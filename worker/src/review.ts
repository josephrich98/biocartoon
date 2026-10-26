// biocartoon-review: the reviewer's page. Lists pending submissions (image or template
// thumbnail, all their text) with Approve / Reject. Every request must carry a valid Cloudflare
// Access token (src/access.ts).
//
//   GET  /                 pending queue (oldest first) and the latest decisions
//   GET  /file/<key>       a pending PNG or SVG
//   POST /approve/<id>     copy into the public bucket (see src/publish.ts)
//   POST /reject/<id>      mark it rejected (its files are deleted REJECTED_KEEP_DAYS later)
//   POST /undo/<id>        put an approved or rejected submission back in the queue
//   POST /done/<id>        mark a suggestion (icon or template requests from the app) handled
//   POST /resolved/<id>    mark a removal request handled (take the icon down first, if agreed)
//   POST /publish          queue "Publish catalog now" (run by the Mac, see src/publish_requests.ts)
//
// A daily cron (wrangler.review.jsonc) deletes the files of old rejections.

import { reviewer } from "./access.ts";
import type { Env } from "./env.ts";
import { guarded } from "./http.ts";
import { REJECTED_KEEP_DAYS, type Row, approve, purgeRejected, reject, rowLayers, rowTags, undo } from "./publish.ts";
import { type PublishRequest, STALE_RUN_MINUTES, latest as latestPublish, request as requestPublish } from "./publish_requests.ts";
import { Rejected } from "./text.ts";

const ID = /^[a-z0-9][a-z0-9-]{0,100}$/;
const SECURITY_HEADERS = {
  "content-security-policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  // Not no-referrer: under that policy browsers send `Origin: null` on the page's own form posts,
  // which sameOrigin() then refuses. same-origin still keeps the referrer from other sites.
  "referrer-policy": "same-origin",
  "cache-control": "no-store",
};
// A pending SVG opened on its own: nothing in it may run or load (submit.ts checked it too).
const SVG_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox";

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const who = await reviewer(req, env);
    if (!who) return new Response("Forbidden\n", { status: 403 });
    return guarded(() => route(req, env, who));
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(purgeRejected(env).then((n) => n && console.log(`purged the files of ${n} old rejections`)));
  },
} satisfies ExportedHandler<Env>;

async function route(req: Request, env: Env, who: string): Promise<Response> {
  const url = new URL(req.url);
  const [, action, ...rest] = url.pathname.split("/");
  if (req.method === "GET" && url.pathname === "/") {
    const undoId = url.searchParams.get("undo");
    return page(env, url.searchParams.get("done"), undoId && ID.test(undoId) ? undoId : null);
  }
  if (req.method === "GET" && action === "file") {
    const key = rest.join("/");
    if (!/^[a-z0-9-]+\/((image|thumb|img-\d{1,3})\.png|image\.svg)$/.test(key)) return new Response("Not found", { status: 404 });
    const obj = await env.PENDING.get(key);
    if (!obj) return new Response("Not found", { status: 404 });
    const svg = key.endsWith(".svg");
    return new Response(obj.body, {
      headers: {
        ...SECURITY_HEADERS,
        ...(svg && { "content-security-policy": SVG_CSP }),
        "content-type": svg ? "image/svg+xml" : "image/png",
        "cache-control": "private, max-age=600",
      },
    });
  }
  if (req.method === "POST" && action === "done" && ID.test(rest[0] ?? "")) {
    if (!sameOrigin(req, url)) return new Response("Bad origin", { status: 403 });
    const r = await env.DB.prepare("UPDATE suggestions SET status = 'done', reviewed_at = ?2, reviewed_by = ?3 WHERE id = ?1 AND status = 'open' RETURNING title")
      .bind(rest[0], new Date().toISOString().replace(/\.\d+Z$/, "Z"), who)
      .first<{ title: string }>();
    return Response.redirect(`${url.origin}/?done=${encodeURIComponent(r ? `Marked the suggestion “${r.title}” done` : "That suggestion was already done")}`, 303);
  }
  if (req.method === "POST" && action === "resolved" && ID.test(rest[0] ?? "")) {
    if (!sameOrigin(req, url)) return new Response("Bad origin", { status: 403 });
    const r = await env.DB.prepare("UPDATE removal_requests SET status = 'done', reviewed_at = ?2, reviewed_by = ?3 WHERE id = ?1 AND status = 'open' RETURNING title, asset_id")
      .bind(rest[0], new Date().toISOString().replace(/\.\d+Z$/, "Z"), who)
      .first<{ title: string; asset_id: string }>();
    return Response.redirect(`${url.origin}/?done=${encodeURIComponent(r ? `Marked the removal request for “${r.title || r.asset_id}” done` : "That removal request was already done")}`, 303);
  }
  if (req.method === "POST" && url.pathname === "/publish") {
    if (!sameOrigin(req, url)) return new Response("Bad origin", { status: 403 });
    const queued = await requestPublish(env, who);
    const msg = queued ? "Publish requested: the Mac picks it up within 5 minutes" : "A publish is already waiting or running";
    return Response.redirect(`${url.origin}/?done=${encodeURIComponent(msg)}`, 303);
  }
  if (req.method === "POST" && (action === "approve" || action === "reject" || action === "undo") && ID.test(rest[0] ?? "")) {
    // Forms from other sites must not be able to approve anything.
    if (!sameOrigin(req, url)) return new Response("Bad origin", { status: 403 });
    const row = await env.DB.prepare("SELECT * FROM submissions WHERE id = ?1").bind(rest[0]).first<Row>();
    if (!row) return new Response("Not found", { status: 404 });
    const back = (msg: string, undoable = false) =>
      Response.redirect(`${url.origin}/?done=${encodeURIComponent(msg)}${undoable ? `&undo=${row.id}` : ""}`, 303);
    if (action === "undo") {
      const was = row.status;
      try {
        await undo(env, row);
      } catch (e) {
        if (e instanceof Rejected) return back(e.message);
        throw e;
      }
      if (was === "pending") return back(`“${row.title}” is already pending`);
      return back(`Undid: “${row.title}” is pending again${was === "approved" ? ". If the catalog was published since, it leaves the app at the next publish_catalog.py run" : ""}`);
    }
    if (row.status !== "pending") return back(`“${row.title}” was already ${row.status}`);
    // Never into the official library against the contributor's wishes.
    const official = action === "approve" && row.official_requested === 1 && (await req.formData()).get("official") === "1";
    await (action === "approve" ? approve(env, row, who, official) : reject(env, row, who));
    return back(`${action === "approve" ? "Approved" : "Rejected"} “${row.title}”${official ? " as an official BioCartoon asset" : ""}`, true);
  }
  return new Response("Not found", { status: 404 });
}

/** Whether a POST came from this site's own page (forms from other sites must not act). */
function sameOrigin(req: Request, url: URL): boolean {
  const origin = req.headers.get("origin");
  if (origin && origin !== "null") return origin === url.origin;
  return req.headers.get("sec-fetch-site") === "same-origin";
}

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function card(r: Row): string {
  const files: string[] = JSON.parse(r.files);
  const texts: string[] = JSON.parse(r.texts);
  const svg = files.includes(`${r.id}/image.svg`);
  const pics = r.kind === "asset" ? [`${r.id}/image.${svg ? "svg" : "png"}`] : [`${r.id}/thumb.png`, ...files.filter((f) => /img-\d+\.png$/.test(f))];
  const imgs = pics.map((k, i) => `<a href="/file/${esc(k)}"><img src="/file/${esc(k)}" class="${i ? "small" : "main"}" alt=""></a>`).join("");
  const textList = texts.length ? `<details open><summary>Text in the slide (${texts.length})</summary><ul>${texts.map((t) => `<li>${esc(t)}</li>`).join("")}</ul></details>` : "";
  return `<section>
  <div class="pics">${imgs}</div>
  <div class="info">
    <h2>${esc(r.title)} <span class="kind">${esc(r.kind)}</span></h2>
    ${r.description ? `<p>${esc(r.description)}</p>` : ""}
    <dl><dt>Category</dt><dd>${esc(r.category || "–")}</dd><dt>Tags</dt><dd>${esc(rowTags(r).join(", ") || "–")}</dd>${layerList(r)}<dt>Credit</dt><dd>${esc(r.author)}</dd>
    ${r.email ? `<dt>Email</dt><dd>${mailto(r.email)} (private)</dd>` : ""}
    <dt>License</dt><dd>${esc(r.license)}</dd><dt>Generative AI</dt><dd>${r.generative_ai_used == null ? "not said" : r.generative_ai_used ? "used" : "not used"}</dd><dt>Size</dt><dd>${r.width ? `${r.width}×${r.height}, ` : ""}${Math.max(1, Math.round(r.bytes / 1024))} KB${svg ? " SVG" : ""}</dd>
    <dt>Submitted</dt><dd>${esc(r.created_at)}</dd></dl>
    ${textList}
    <form method="post">${officialBoxes(r)}
    <button formaction="/approve/${esc(r.id)}" class="ok">Approve</button>
    <button formaction="/reject/${esc(r.id)}" class="no">Reject</button></form>
  </div>
</section>`;
}

/** What the contributor asked for, and the reviewer's choice, which is open only if they asked for it. */
/** The layers the contributor named, each with its colours as swatches; nothing when none. */
function layerList(r: Row): string {
  const layers = rowLayers(r);
  if (!layers.length) return "";
  const swatch = (c: string) => `<span class="swatch" style="background:${esc(c)}" title="${esc(c)}"></span>`;
  return `<dt>Layers</dt><dd>${layers.map((l) => `${l.colors.map(swatch).join("")} ${esc(l.name)}`).join("<br>")}</dd>`;
}

function officialBoxes(r: Row): string {
  const asked = r.official_requested === 1;
  return `<label class="official"><input type="checkbox" disabled${asked ? " checked" : ""}> Submitted as an official BioCartoon asset</label>
    <label class="official${asked ? "" : " off"}"${asked ? "" : ` title="The contributor didn't ask for it"`}><input type="checkbox" name="official" value="1"${asked ? "" : " disabled"}> Accept to official BioCartoon asset
    <span>List under the official BioCartoon library rather than the User-Generated library. Authorship is unchanged (simply changes library).</span></label>`;
}

interface SuggestionRow {
  id: string;
  kind: string;
  title: string;
  description: string;
  name: string;
  email: string;
  created_at: string;
}

const mailto = (e: string) => `<a href="mailto:${esc(encodeURIComponent(e).replace(/%40/g, "@"))}">${esc(e)}</a>`;

const suggestionRow = (r: SuggestionRow) =>
  `<tr><td>${esc(r.kind)}</td><td><b>${esc(r.title)}</b>${r.description ? `<br>${esc(r.description)}` : ""}</td><td>${esc(r.name || "–")}${r.email ? `<br>${mailto(r.email)}` : ""}</td><td>${esc(r.created_at)}</td>
  <td><form method="post" class="inline"><button formaction="/done/${esc(r.id)}" class="undo">Done</button></form></td></tr>`;

interface RemovalRow {
  id: string;
  asset_id: string;
  title: string;
  reason: string;
  name: string;
  email: string;
  created_at: string;
}

const removalRow = (r: RemovalRow) =>
  `<tr><td><b>${esc(r.title || "–")}</b><br><code>${esc(r.asset_id)}</code></td><td>${esc(r.reason)}</td><td>${esc(r.name || "–")}${r.email ? `<br>${mailto(r.email)}` : ""}</td><td>${esc(r.created_at)}</td>
  <td><form method="post" class="inline"><button formaction="/resolved/${esc(r.id)}" class="undo">Done</button></form></td></tr>`;

/** The "Publish catalog now" button and how the latest publish went. */
function publishBox(p: PublishRequest | null): string {
  const state = !p
    ? "No publish requested from here yet."
    : p.status === "requested"
      ? `Requested ${esc(p.requested_at)} by ${esc(p.requested_by)}; waiting for the Mac (it checks every 5 minutes while awake).`
      : p.status === "running"
        ? `Running since ${esc(p.started_at)} (requested by ${esc(p.requested_by)}). A run that has not reported back after ${STALE_RUN_MINUTES} minutes can be requested again.`
        : `Last publish ${p.status === "done" ? "finished" : "<b>failed</b>"} ${esc(p.finished_at)} (requested by ${esc(p.requested_by)}).`;
  const log = p?.message ? `<details${p.status === "failed" || /skip /.test(p.message) ? " open" : ""}><summary>Output</summary><pre>${esc(p.message)}</pre></details>` : "";
  return `<div class="publish"><form method="post" class="inline"><button formaction="/publish" class="ok">Publish catalog now</button></form>
<span>${state}</span>${log}</div>`;
}

const undoForm = (id: string, cls = "") =>
  `<form method="post" class="inline"><button formaction="/undo/${esc(id)}" class="undo ${cls}">Undo</button></form>`;

async function page(env: Env, done: string | null, undoId: string | null): Promise<Response> {
  const pending = await env.DB.prepare("SELECT * FROM submissions WHERE status = 'pending' ORDER BY created_at LIMIT 50").all<Row>();
  const total = await env.DB.prepare("SELECT count(*) AS n FROM submissions WHERE status = 'pending'").first<{ n: number }>();
  const recent = await env.DB.prepare("SELECT * FROM submissions WHERE status != 'pending' ORDER BY reviewed_at DESC LIMIT 20").all<Row>();
  const suggestions = await env.DB.prepare("SELECT * FROM suggestions WHERE status = 'open' ORDER BY created_at LIMIT 100").all<SuggestionRow>();
  const removals = await env.DB.prepare("SELECT * FROM removal_requests WHERE status = 'open' ORDER BY created_at LIMIT 100").all<RemovalRow>();
  const publish = await latestPublish(env);
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>BioCartoon review (${total?.n ?? 0})</title><style>
body{font:15px system-ui,sans-serif;margin:0 auto;max-width:1000px;padding:16px;color:#1d1d22;background:#f6f6f8}
section{display:flex;gap:16px;background:#fff;border:1px solid #dcdce2;border-radius:10px;padding:14px;margin:12px 0}
.pics{flex:0 0 260px;display:flex;flex-wrap:wrap;gap:6px;align-content:flex-start}
.pics img{background:repeating-conic-gradient(#eee 0 25%,#fff 0 50%) 0 0/16px 16px;border:1px solid #ddd;border-radius:6px;object-fit:contain}
.main{width:260px;height:200px}.small{width:60px;height:60px}.info{flex:1;min-width:0}
h2{margin:0 0 6px;font-size:18px}.kind{font-size:12px;color:#666;border:1px solid #ccc;border-radius:4px;padding:1px 5px}
dl{display:grid;grid-template-columns:90px 1fr;gap:2px 8px;margin:8px 0;font-size:13px}dt{color:#777}dd{margin:0;overflow-wrap:anywhere}
li{overflow-wrap:anywhere}button{font:inherit;padding:7px 18px;border-radius:6px;border:0;color:#fff;cursor:pointer;margin-right:6px}
.ok{background:#2e7d32}.no{background:#b3261e}.done{background:#e8f5e9;border:1px solid #a5d6a7;padding:8px 12px;border-radius:6px;display:flex;align-items:center;gap:12px}
.undo{background:#55555f;padding:3px 12px;font-size:13px}.done .undo{margin-left:auto}form.inline{display:inline;margin:0}
.swatch{display:inline-block;width:10px;height:10px;border:1px solid #999;margin-right:1px;vertical-align:middle}label.official{display:block;margin:0 0 10px;font-size:14px}label.official span{display:block;margin-left:22px;color:#777;font-size:12px}label.official.off{opacity:.45}
.publish{background:#fff;border:1px solid #dcdce2;border-radius:10px;padding:10px 14px;margin:12px 0;font-size:14px}.publish span{color:#555}
.publish pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;max-height:300px;overflow:auto;background:#f6f6f8;padding:8px;border-radius:6px}
table{border-collapse:collapse;font-size:13px;width:100%}td{border-top:1px solid #ddd;padding:4px 6px}
</style></head><body>
<h1>Review queue: ${total?.n ?? 0} pending</h1>
${done ? `<div class="done"><span>${esc(done)}</span>${undoId ? undoForm(undoId) : ""}</div>` : ""}
${publishBox(publish)}
${pending.results.map(card).join("") || "<p>Nothing to review.</p>"}
<h3>Removal requests (${removals.results.length})</h3>
${removals.results.length ? `<table>${removals.results.map(removalRow).join("")}</table>
<p style="color:#777;font-size:13px">To take an icon down, Undo its approval under Recent decisions (or list its id in <code>data/upload_blocklist.txt</code>), then mark the request done.</p>` : "<p>No open removal requests.</p>"}
<h3>Suggestions (${suggestions.results.length})</h3>
${suggestions.results.length ? `<table>${suggestions.results.map(suggestionRow).join("")}</table>` : "<p>No open suggestions.</p>"}
<h3>Recent decisions</h3><table>${recent.results
    .map((r) => `<tr><td>${esc(r.status)}${r.official ? " (official)" : ""}</td><td>${esc(r.kind)}</td><td>${esc(r.title)}</td><td>${esc(r.author)}</td><td>${esc(r.reviewed_by)}</td><td>${esc(r.reviewed_at)}</td><td>${r.status === "approved" || r.files !== "[]" ? undoForm(r.id) : ""}</td></tr>`)
    .join("")}</table>
<p style="color:#777;font-size:13px">Approved items reach the app the next time <code>data/publish_catalog.py</code> runs (Publish catalog now above, or the weekly sync), and an undone approval leaves it then too.
Rejections can be undone for ${REJECTED_KEEP_DAYS} days.</p>
</body></html>`;
  return new Response(html, { headers: { ...SECURITY_HEADERS, "content-type": "text/html; charset=utf-8" } });
}
