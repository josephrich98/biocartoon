// biocartoon-review: the reviewer's page. Lists pending submissions (image or template
// thumbnail, all their text) with Approve / Reject. Every request must carry a valid Cloudflare
// Access token (src/access.ts).
//
//   GET  /                 pending queue (oldest first) and the latest decisions
//   GET  /file/<key>       a pending PNG or SVG
//   GET  /public/<key>     a published upload's PNG or SVG (the version an update replaces)
//   POST /approve/<id>     copy into the public bucket (see src/publish.ts)
//   POST /approve-page     approve every card on the page, each as its "official" box says
//   POST /approve-all      approve the whole queue (as submitted) in batches, continuing itself
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
import { REJECTED_KEEP_DAYS, type Row, approve, latestVersion, purgeRejected, reject, rowLayers, rowTags, undo } from "./publish.ts";
import { type PublishRequest, STALE_RUN_MINUTES, latest as latestPublish, request as requestPublish } from "./publish_requests.ts";
import { Rejected } from "./text.ts";

const ID = /^[a-z0-9][a-z0-9-]{0,100}$/;
/** Cards per page, and approvals per request (each is a handful of R2 and D1 calls, and a
 *  Worker request may make only so many). */
const PAGE_SIZE = 50;
const BATCH = 50;
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
    return page(env, url.searchParams.get("done"), undoId && ID.test(undoId) ? undoId : null, pageNo(url.searchParams.get("page")));
  }
  if (req.method === "GET" && (action === "file" || action === "public")) {
    const key = rest.join("/");
    const pattern = action === "file" ? /^[a-z0-9-]+\/((image|thumb|img-\d{1,3})\.png|image\.svg)$/ : /^user\/[a-z0-9-]+\.(png|svg)$/;
    if (!pattern.test(key)) return new Response("Not found", { status: 404 });
    const obj = await (action === "file" ? env.PENDING : env.PUBLIC).get(key);
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
  if (req.method === "POST" && (url.pathname === "/approve-page" || url.pathname === "/approve-all")) {
    if (!sameOrigin(req, url)) return new Response("Bad origin", { status: 403 });
    const form = await req.formData();
    return url.pathname === "/approve-page" ? approvePage(env, url, who, form) : approveAll(env, url, who, form);
  }
  if (req.method === "POST" && (action === "approve" || action === "reject" || action === "undo") && ID.test(rest[0] ?? "")) {
    // Forms from other sites must not be able to approve anything.
    if (!sameOrigin(req, url)) return new Response("Bad origin", { status: 403 });
    const row = await env.DB.prepare("SELECT * FROM submissions WHERE id = ?1").bind(rest[0]).first<Row>();
    if (!row) return new Response("Not found", { status: 404 });
    const form = await req.formData();
    const pg = pageNo(form.get("page"));
    const back = (msg: string, undoable = false) =>
      Response.redirect(`${url.origin}/?done=${encodeURIComponent(msg)}${undoable ? `&undo=${row.id}` : ""}${pg > 1 ? `&page=${pg}` : ""}`, 303);
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
    // Never into the official library against the contributor's wishes. An update may stay where
    // the version it replaces is.
    const target = action === "approve" ? await updateTarget(env, row) : null;
    const official = action === "approve" && mayBeOfficial(row, target) && form.get(`official-${row.id}`) === "1";
    await (action === "approve" ? approve(env, row, who, official) : reject(env, row, who));
    return back(`${action === "approve" ? "Approved" : "Rejected"} “${row.title}”${official ? " as an official BioCartoon asset" : ""}`, true);
  }
  return new Response("Not found", { status: 404 });
}

/** A 1-based page number from a query or form value. */
function pageNo(v: unknown): number {
  const n = Number(typeof v === "string" ? v : 1);
  return Number.isInteger(n) && n >= 1 && n <= 100_000 ? n : 1;
}

/** Never into the official library against the contributor's wishes. An update may stay where
 *  the version it replaces is. */
const mayBeOfficial = (r: Row, target: Target | null) => r.official_requested === 1 || target?.official === 1;

/** Approves one pending row; a reason instead when it can't be (e.g. an update whose target is gone). */
async function tryApprove(env: Env, row: Row, who: string, official: (target: Target | null) => boolean): Promise<string | null> {
  try {
    const target = await updateTarget(env, row);
    if (target?.error) return `“${row.title}”: ${target.error}`;
    await approve(env, row, who, mayBeOfficial(row, target) && official(target));
    return null;
  } catch (e) {
    if (e instanceof Rejected || e instanceof Error) return `“${row.title}”: ${e.message}`;
    throw e;
  }
}

const summary = (n: number, failed: string[]) =>
  `Approved ${n} submission${n === 1 ? "" : "s"}${failed.length ? `; ${failed.length} left pending (${failed.slice(0, 5).join("; ")}${failed.length > 5 ? "; …" : ""})` : ""}`;

/** "Accept all on page": every card the page listed, each official as its box says. */
async function approvePage(env: Env, url: URL, who: string, form: FormData): Promise<Response> {
  const ids = form.getAll("id").filter((v): v is string => typeof v === "string" && ID.test(v)).slice(0, BATCH);
  let n = 0;
  const failed: string[] = [];
  for (const id of ids) {
    const row = await env.DB.prepare("SELECT * FROM submissions WHERE id = ?1 AND status = 'pending'").bind(id).first<Row>();
    if (!row) continue;
    const why = await tryApprove(env, row, who, () => form.get(`official-${id}`) === "1");
    if (why) failed.push(why);
    else n++;
  }
  // The approved cards leave the queue, so the same page number now shows the next ones.
  const pg = pageNo(form.get("page"));
  return Response.redirect(`${url.origin}/?done=${encodeURIComponent(summary(n, failed))}${pg > 1 ? `&page=${pg}` : ""}`, 303);
}

/** "Accept all": the whole queue as it was when the page was shown, official where the contributor
 *  asked (or the version an update replaces is official), BATCH at a time. Between batches it
 *  answers with a page that posts the next one itself. */
async function approveAll(env: Env, url: URL, who: string, form: FormData): Promise<Response> {
  const str = (k: string) => (typeof form.get(k) === "string" ? (form.get(k) as string) : "");
  const cutoff = str("cutoff");
  if (!/^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(cutoff)) return new Response("Bad cutoff", { status: 400 });
  // Rows that could not be approved stay pending; the cursor moves past them so they aren't retried.
  const afterAt = str("after_at");
  const afterId = str("after_id");
  let n = Number(str("n")) || 0;
  const failed = str("failed") ? str("failed").split("\n").slice(0, 50) : [];
  const rows = (await env.DB.prepare(
    "SELECT * FROM submissions WHERE status = 'pending' AND created_at <= ?1 AND (created_at > ?2 OR (created_at = ?2 AND id > ?3)) ORDER BY created_at, id LIMIT ?4",
  ).bind(cutoff, afterAt, afterId, BATCH).all<Row>()).results;
  for (const row of rows) {
    const why = await tryApprove(env, row, who, () => true);
    if (why) failed.push(why);
    else n++;
  }
  if (rows.length < BATCH) return Response.redirect(`${url.origin}/?done=${encodeURIComponent(summary(n, failed))}`, 303);
  const last = rows[rows.length - 1];
  const left = (await env.DB.prepare("SELECT count(*) AS n FROM submissions WHERE status = 'pending' AND created_at <= ?1 AND (created_at > ?2 OR (created_at = ?2 AND id > ?3))")
    .bind(cutoff, last.created_at, last.id).first<{ n: number }>())?.n ?? 0;
  const nonce = crypto.randomUUID().replace(/-/g, "");
  const hidden = (k: string, v: string | number) => `<input type="hidden" name="${k}" value="${esc(v)}">`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Approving…</title></head>
<body style="font:15px system-ui,sans-serif;padding:24px">
<p>Approved ${n} so far; ${left} to go${failed.length ? ` (${failed.length} left pending)` : ""}. Keep this tab open.</p>
<form method="post" action="/approve-all" id="next">${hidden("cutoff", cutoff)}${hidden("after_at", last.created_at)}${hidden("after_id", last.id)}${hidden("n", n)}${hidden("failed", failed.join("\n"))}
<noscript><button>Continue</button></noscript></form>
<script nonce="${nonce}">document.getElementById("next").submit()</script></body></html>`;
  return new Response(html, {
    headers: {
      ...SECURITY_HEADERS,
      "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; form-action 'self'; frame-ancestors 'none'`,
      "content-type": "text/html; charset=utf-8",
    },
  });
}

/** Whether a POST came from this site's own page (forms from other sites must not act). */
function sameOrigin(req: Request, url: URL): boolean {
  const origin = req.headers.get("origin");
  if (origin && origin !== "null") return origin === url.origin;
  return req.headers.get("sec-fetch-site") === "same-origin";
}

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** What a pending update replaces: the newest approved version of the asset it names, or why there is none. */
interface Target {
  id: string;
  title: string;
  official: number;
  svg: boolean;
  error?: string;
}

async function updateTarget(env: Env, r: Row): Promise<Target | null> {
  if (!r.replaces) return null;
  try {
    const id = await latestVersion(env, r.replaces);
    const t = await env.DB.prepare("SELECT title, official, files FROM submissions WHERE id = ?1").bind(id).first<{ title: string; official: number; files: string }>();
    return { id, title: t?.title ?? id, official: t?.official ?? 0, svg: (t?.files ?? "").includes("image.svg") };
  } catch (e) {
    if (!(e instanceof Rejected)) throw e;
    return { id: r.replaces, title: r.replaces, official: 0, svg: false, error: e.message };
  }
}

function card(r: Row, target: Target | null, keyLabel: string | null): string {
  const files: string[] = JSON.parse(r.files);
  const texts: string[] = JSON.parse(r.texts);
  const svg = files.includes(`${r.id}/image.svg`);
  const pics = r.kind === "asset" ? [`${r.id}/image.${svg ? "svg" : "png"}`] : [`${r.id}/thumb.png`, ...files.filter((f) => /img-\d+\.png$/.test(f))];
  const imgs = pics.map((k, i) => `<a href="/file/${esc(k)}"><img src="/file/${esc(k)}" class="${i ? "small" : "main"}" alt=""></a>`).join("");
  // The PNG of an SVG upload is rendered at publish, so the SVG is what is surely there.
  const now = target && !target.error ? `user/${target.id}.${target.svg ? "svg" : "png"}` : null;
  const was = target
    ? `<p class="update">Update of <b>${esc(target.title)}</b> <code>${esc(target.id)}</code>${target.error ? ` <b>${esc(target.error)}</b>` : ": it takes this one's place (and catalog id) at the next publish; the old files stay for the projects that use them."}</p>`
    : "";
  const before = now ? `<div class="was">Now:<a href="/public/${esc(now)}"><img src="/public/${esc(now)}" class="small" alt=""></a></div>` : "";
  const textList = texts.length ? `<details open><summary>Text in the slide (${texts.length})</summary><ul>${texts.map((t) => `<li>${esc(t)}</li>`).join("")}</ul></details>` : "";
  return `<section>
  <div class="pics">${imgs}${before}</div>
  <div class="info">
    <h2>${esc(r.title)} <span class="kind">${esc(kindLabel(r.kind))}${r.replaces ? " update" : ""}</span></h2>
    ${was}
    ${r.description ? `<p>${esc(r.description)}</p>` : ""}
    <dl><dt>Category</dt><dd>${esc(r.category || "–")}</dd><dt>Tags</dt><dd>${esc(rowTags(r).join(", ") || "–")}</dd>${layerList(r)}<dt>Credit</dt><dd>${esc(r.author)}</dd>
    ${r.email ? `<dt>Email</dt><dd>${mailto(r.email)} (private)</dd>` : ""}
    <dt>License</dt><dd>${esc(r.license)}</dd><dt>Generative AI</dt><dd>${r.generative_ai_used == null ? "not said" : r.generative_ai_used ? `used${r.generative_ai_details ? `: ${esc(r.generative_ai_details)}` : ""}` : "not used"}</dd><dt>Size</dt><dd>${r.width ? `${r.width}×${r.height}, ` : ""}${Math.max(1, Math.round(r.bytes / 1024))} KB${svg ? " SVG" : ""}</dd>
    <dt>Submitted</dt><dd>${esc(r.created_at)}</dd>${r.key_id ? `<dt>Upload key</dt><dd>${esc(r.key_id === "master" ? "master" : keyLabel ?? r.key_id)}</dd>` : ""}</dl>
    ${textList}
    <input type="hidden" name="id" value="${esc(r.id)}">${officialBoxes(r, target)}
    <button formaction="/approve/${esc(r.id)}" class="ok">Approve</button>
    <button formaction="/reject/${esc(r.id)}" class="no">Reject</button>
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

function officialBoxes(r: Row, target: Target | null): string {
  const asked = r.official_requested === 1;
  // Open (and checked to begin with) when the contributor asked, or the version an update replaces is official.
  const open = mayBeOfficial(r, target);
  return `<label class="official"><input type="checkbox" disabled${asked ? " checked" : ""}> Submitted as an official BioCartoon asset${target?.official ? " (the version it updates is official)" : ""}</label>
    <label class="official${open ? "" : " off"}"${open ? "" : ` title="The contributor didn't ask for it"`}><input type="checkbox" name="official-${esc(r.id)}" value="1"${open ? " checked" : " disabled"}> Accept to official BioCartoon library
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
  `<tr><td>${esc(kindLabel(r.kind))}</td><td><b>${esc(r.title)}</b>${r.description ? `<br>${esc(r.description)}` : ""}</td><td>${esc(r.name || "–")}${r.email ? `<br>${mailto(r.email)}` : ""}</td><td>${esc(r.created_at)}</td>
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

/** The "Publish catalog now" button (after "Accept all on page" and "Accept all") and how the latest publish went. */
function publishBox(p: PublishRequest | null, onPage: number, total: number, cutoff: string): string {
  const state = !p
    ? "No publish requested from here yet."
    : p.status === "requested"
      ? `Requested ${esc(p.requested_at)} by ${esc(p.requested_by)}; waiting for the Mac (it checks every 5 minutes while awake).`
      : p.status === "running"
        ? `Running since ${esc(p.started_at)} (requested by ${esc(p.requested_by)}). A run that has not reported back after ${STALE_RUN_MINUTES} minutes can be requested again.`
        : `Last publish ${p.status === "done" ? "finished" : "<b>failed</b>"} ${esc(p.finished_at)} (requested by ${esc(p.requested_by)}).`;
  const log = p?.message ? `<details${p.status === "failed" || /skip /.test(p.message) ? " open" : ""}><summary>Output</summary><pre>${esc(p.message)}</pre></details>` : "";
  const accept = total
    ? `<button form="queue" formaction="/approve-page" class="ok"${onPage ? "" : " disabled"}>Accept all on page (${onPage})</button><form method="post" class="inline">\
<input type="hidden" name="cutoff" value="${esc(cutoff)}"><button formaction="/approve-all" class="ok">Accept all (${total})</button></form>`
    : "";
  return `<div class="publish">${accept}<form method="post" class="inline"><button formaction="/publish" class="ok">Publish catalog now</button></form>
<span>${state}</span>${log}</div>`;
}

/** Reviewer-facing name for a submission kind: the database says "asset" for a single icon. */
const kindLabel = (kind: string) => (kind === "asset" ? "icon" : kind);

const undoForm = (id: string, cls = "") =>
  `<form method="post" class="inline"><button formaction="/undo/${esc(id)}" class="undo ${cls}">Undo</button></form>`;

function pager(pg: number, pages: number, total: number): string {
  if (pages <= 1) return "";
  const link = (p: number, label: string) => `<a href="/?page=${p}" class="pg">${label}</a>`;
  const first = (pg - 1) * PAGE_SIZE + 1;
  // Page numbers: the first, the last, and two either side of the current one, with gaps as "…".
  const shown = [...new Set([1, pg - 2, pg - 1, pg, pg + 1, pg + 2, pages])].filter((p) => p >= 1 && p <= pages).sort((a, b) => a - b);
  const nums = shown
    .map((p, i) => (i && p - shown[i - 1] > 1 ? `<span class="gap">…</span>` : "") +
      (p === pg ? `<span class="pg cur" aria-current="page">${p}</span>` : link(p, String(p))))
    .join("");
  return `<nav class="pager">${pg > 1 ? link(pg - 1, "← Previous") : `<span class="pg off">← Previous</span>`}
<span class="nums">${nums}</span>
<span>${first}–${Math.min(pg * PAGE_SIZE, total)} of ${total}</span>
${pg < pages ? link(pg + 1, "Next →") : `<span class="pg off">Next →</span>`}</nav>`;
}

async function page(env: Env, done: string | null, undoId: string | null, pg: number): Promise<Response> {
  const cutoff = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const total = await env.DB.prepare("SELECT count(*) AS n FROM submissions WHERE status = 'pending'").first<{ n: number }>();
  const pages = Math.max(1, Math.ceil((total?.n ?? 0) / PAGE_SIZE));
  pg = Math.min(pg, pages);
  const pending = await env.DB.prepare("SELECT * FROM submissions WHERE status = 'pending' ORDER BY created_at, id LIMIT ?1 OFFSET ?2")
    .bind(PAGE_SIZE, (pg - 1) * PAGE_SIZE).all<Row>();
  const recent = await env.DB.prepare("SELECT * FROM submissions WHERE status != 'pending' ORDER BY reviewed_at DESC LIMIT 20").all<Row>();
  const suggestions = await env.DB.prepare("SELECT * FROM suggestions WHERE status = 'open' ORDER BY created_at LIMIT 100").all<SuggestionRow>();
  const removals = await env.DB.prepare("SELECT * FROM removal_requests WHERE status = 'open' ORDER BY created_at LIMIT 100").all<RemovalRow>();
  const publish = await latestPublish(env);
  const targets = await Promise.all(pending.results.map((r) => updateTarget(env, r)));
  const keys = new Map(
    (await env.DB.prepare("SELECT id, label FROM upload_keys").all<{ id: string; label: string }>()).results.map((k) => [k.id, k.label]),
  );
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
.update{background:#fff8e1;border:1px solid #ffe082;border-radius:6px;padding:6px 10px;font-size:13px;margin:0 0 8px}.was{font-size:12px;color:#777;display:flex;flex-direction:column;gap:2px}
.pager{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:12px 0;font-size:14px;color:#555}
.pg{padding:6px 14px;border:1px solid #c8c8d0;border-radius:6px;background:#fff;color:#1d1d22;text-decoration:none}.pg.off{opacity:.4}
.nums{display:flex;flex-wrap:wrap;align-items:center;gap:4px}.nums .pg{padding:6px 10px}.pg.cur{background:#1d1d22;color:#fff;border-color:#1d1d22}.gap{padding:0 4px}
.nums{display:flex;flex-wrap:wrap;align-items:center;gap:4px}.nums .pg{padding:6px 10px}.pg.cur{background:#1d1d22;color:#fff;border-color:#1d1d22}.gap{padding:0 4px}
button[disabled]{opacity:.5;cursor:default}.publish{background:#fff;border:1px solid #dcdce2;border-radius:10px;padding:10px 14px;margin:12px 0;font-size:14px}.publish span{color:#555}
.publish pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;max-height:300px;overflow:auto;background:#f6f6f8;padding:8px;border-radius:6px}
table{border-collapse:collapse;font-size:13px;width:100%}td{border-top:1px solid #ddd;padding:4px 6px}
</style></head><body>
<h1>Review queue: ${total?.n ?? 0} pending</h1>
${done ? `<div class="done"><span>${esc(done)}</span>${undoId ? undoForm(undoId) : ""}</div>` : ""}
${publishBox(publish, pending.results.length, total?.n ?? 0, cutoff)}
${pager(pg, pages, total?.n ?? 0)}
${pending.results.length ? `<form method="post" id="queue"><input type="hidden" name="page" value="${pg}">
${pending.results.map((r, i) => card(r, targets[i], r.key_id ? keys.get(r.key_id) ?? null : null)).join("")}</form>` : "<p>Nothing to review.</p>"}
${pager(pg, pages, total?.n ?? 0)}
<h3>Removal requests (${removals.results.length})</h3>
${removals.results.length ? `<table>${removals.results.map(removalRow).join("")}</table>
<p style="color:#777;font-size:13px">To take an icon down, Undo its approval under Recent decisions (or list its id in <code>data/upload_blocklist.txt</code>), then mark the request done.</p>` : "<p>No open removal requests.</p>"}
<h3>Suggestions (${suggestions.results.length})</h3>
${suggestions.results.length ? `<table>${suggestions.results.map(suggestionRow).join("")}</table>` : "<p>No open suggestions.</p>"}
<h3>Recent decisions</h3><table>${recent.results
    .map((r) => `<tr><td>${esc(r.status)}${r.official ? " (official)" : ""}${r.replaces ? " update" : ""}${r.replaced_by ? " (since updated)" : ""}</td><td>${esc(kindLabel(r.kind))}</td><td>${esc(r.title)}</td><td>${esc(r.author)}</td><td>${esc(r.reviewed_by)}</td><td>${esc(r.reviewed_at)}</td><td>${r.status === "approved" || r.files !== "[]" ? undoForm(r.id) : ""}</td></tr>`)
    .join("")}</table>
<p style="color:#777;font-size:13px">Approved items reach the app the next time <code>data/publish_catalog.py</code> runs (Publish catalog now above, or the weekly sync), and an undone approval leaves it then too.
Rejections can be undone for ${REJECTED_KEEP_DAYS} days.</p>
</body></html>`;
  return new Response(html, { headers: { ...SECURITY_HEADERS, "content-type": "text/html; charset=utf-8" } });
}
