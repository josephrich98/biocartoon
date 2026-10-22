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
//
// A daily cron (wrangler.review.jsonc) deletes the files of old rejections.

import { reviewer } from "./access.ts";
import type { Env } from "./env.ts";
import { guarded } from "./http.ts";
import { REJECTED_KEEP_DAYS, type Row, approve, purgeRejected, reject, undo } from "./publish.ts";
import { Rejected } from "./text.ts";

const ID = /^[a-z0-9][a-z0-9-]{0,100}$/;
const SECURITY_HEADERS = {
  "content-security-policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
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
    if (req.headers.get("origin") !== url.origin) return new Response("Bad origin", { status: 403 });
    const r = await env.DB.prepare("UPDATE suggestions SET status = 'done', reviewed_at = ?2, reviewed_by = ?3 WHERE id = ?1 AND status = 'open' RETURNING title")
      .bind(rest[0], new Date().toISOString().replace(/\.\d+Z$/, "Z"), who)
      .first<{ title: string }>();
    return Response.redirect(`${url.origin}/?done=${encodeURIComponent(r ? `Marked the suggestion “${r.title}” done` : "That suggestion was already done")}`, 303);
  }
  if (req.method === "POST" && (action === "approve" || action === "reject" || action === "undo") && ID.test(rest[0] ?? "")) {
    // Forms from other sites must not be able to approve anything.
    if (req.headers.get("origin") !== url.origin) return new Response("Bad origin", { status: 403 });
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
    const official = action === "approve" && (await req.formData()).get("official") === "1";
    await (action === "approve" ? approve(env, row, who, official) : reject(env, row, who));
    return back(`${action === "approve" ? "Approved" : "Rejected"} “${row.title}”${official ? " as an official BioCartoon asset" : ""}`, true);
  }
  return new Response("Not found", { status: 404 });
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
    <dl><dt>Category</dt><dd>${esc(r.category || "–")}</dd><dt>Credit</dt><dd>${esc(r.author)}</dd>
    ${r.email ? `<dt>Email</dt><dd>${mailto(r.email)} (private)</dd>` : ""}
    <dt>License</dt><dd>${esc(r.license)}</dd><dt>Size</dt><dd>${r.width ? `${r.width}×${r.height}, ` : ""}${Math.max(1, Math.round(r.bytes / 1024))} KB${svg ? " SVG" : ""}</dd>
    <dt>Submitted</dt><dd>${esc(r.created_at)}</dd></dl>
    ${textList}
    <form method="post"><label class="official"><input type="checkbox" name="official" value="1"> Official BioCartoon ${esc(r.kind)}
    <span>(credited to BioCartoon instead of ${esc(r.author)}, and listed under the BioCartoon database)</span></label>
    <button formaction="/approve/${esc(r.id)}" class="ok">Approve</button>
    <button formaction="/reject/${esc(r.id)}" class="no">Reject</button></form>
  </div>
</section>`;
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

const undoForm = (id: string, cls = "") =>
  `<form method="post" class="inline"><button formaction="/undo/${esc(id)}" class="undo ${cls}">Undo</button></form>`;

async function page(env: Env, done: string | null, undoId: string | null): Promise<Response> {
  const pending = await env.DB.prepare("SELECT * FROM submissions WHERE status = 'pending' ORDER BY created_at LIMIT 50").all<Row>();
  const total = await env.DB.prepare("SELECT count(*) AS n FROM submissions WHERE status = 'pending'").first<{ n: number }>();
  const recent = await env.DB.prepare("SELECT * FROM submissions WHERE status != 'pending' ORDER BY reviewed_at DESC LIMIT 20").all<Row>();
  const suggestions = await env.DB.prepare("SELECT * FROM suggestions WHERE status = 'open' ORDER BY created_at LIMIT 100").all<SuggestionRow>();
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
label.official{display:block;margin:0 0 10px;font-size:14px}label.official span{color:#777;font-size:12px}
table{border-collapse:collapse;font-size:13px;width:100%}td{border-top:1px solid #ddd;padding:4px 6px}
</style></head><body>
<h1>Review queue: ${total?.n ?? 0} pending</h1>
${done ? `<div class="done"><span>${esc(done)}</span>${undoId ? undoForm(undoId) : ""}</div>` : ""}
${pending.results.map(card).join("") || "<p>Nothing to review.</p>"}
<h3>Suggestions (${suggestions.results.length})</h3>
${suggestions.results.length ? `<table>${suggestions.results.map(suggestionRow).join("")}</table>` : "<p>No open suggestions.</p>"}
<h3>Recent decisions</h3><table>${recent.results
    .map((r) => `<tr><td>${esc(r.status)}${r.official ? " (official)" : ""}</td><td>${esc(r.kind)}</td><td>${esc(r.title)}</td><td>${esc(r.author)}</td><td>${esc(r.reviewed_by)}</td><td>${esc(r.reviewed_at)}</td><td>${r.status === "approved" || r.files !== "[]" ? undoForm(r.id) : ""}</td></tr>`)
    .join("")}</table>
<p style="color:#777;font-size:13px">Approved items reach the app the next time <code>data/publish_catalog.py</code> runs, and an undone approval leaves it then too.
Rejections can be undone for ${REJECTED_KEEP_DAYS} days.</p>
</body></html>`;
  return new Response(html, { headers: { ...SECURITY_HEADERS, "content-type": "text/html; charset=utf-8" } });
}
