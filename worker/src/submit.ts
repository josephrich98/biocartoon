// biocartoon-submit: anyone can contribute an asset or a template from the app. Submissions
// are validated, filtered for profanity and rate limited, then held in the private pending bucket
// until approved on the review Worker (src/review.ts).
//
//   POST /submit   multipart/form-data:
//     kind=asset     meta=<JSON>  image=<PNG> | svg=<SVG> (publishing renders an SVG's PNG; one sent along is ignored)
//     kind=template  meta=<JSON>  template=<JSON>  thumb=<PNG>  img-1.png=<PNG> ...
//   POST /suggest  application/json {kind: "icon" | "template" | "other", title, description?, name?, email?}
//   POST /removal  application/json {asset_id, title?, reason, name?, email?}: ask to take an icon out of the library
//   GET  /status?ids=<id>,<id>   -> {"<id>": "pending" | "approved" | "rejected"}
//   POST /star, GET /stars, GET /stars/all: star counts on catalog assets (src/stars.ts)
//   /auth/*, /me, /cloud/projects/*: optional accounts that keep projects online (src/accounts.ts)

import * as accounts from "./accounts.ts";
import type { Env } from "./env.ts";
import { guarded, json, sha256Hex } from "./http.ts";
import {
  MAX_OPEN_REMOVALS, MAX_OPEN_SUGGESTIONS, MAX_PENDING, MAX_PER_IP_PER_DAY, MAX_PER_IP_PER_DAY_WITH_KEY, MAX_REMOVALS_PER_IP_PER_DAY, MAX_REQUEST_BYTES,
  MAX_SUGGESTIONS_PER_IP_PER_DAY, MAX_TEMPLATE_JSON_BYTES,
} from "./limits.ts";
import * as stars from "./stars.ts";
import { Rejected, newId } from "./text.ts";
import { type Layer, checkSvg, checkTemplate, parseEmail, parseMeta, parseRemoval, parseSuggestion, pngSize } from "./validate.ts";

const ID = /^[a-z0-9][a-z0-9-]{0,100}$/;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/submit" && req.method === "POST") return guarded(() => submit(req, env));
    if (url.pathname === "/suggest" && req.method === "POST") return guarded(() => suggest(req, env));
    if (url.pathname === "/removal" && req.method === "POST") return guarded(() => removal(req, env));
    if (url.pathname === "/status" && req.method === "GET") return guarded(() => status(url, env));
    if (url.pathname === "/star" || url.pathname === "/stars" || url.pathname === "/stars/all") {
      if (req.method === "OPTIONS") return stars.preflight();
      if (url.pathname === "/star" && req.method === "POST") return stars.cors(await guarded(() => stars.toggle(req, env)));
      if (url.pathname === "/stars" && req.method === "GET") return stars.cors(await guarded(() => stars.counts(url, env)));
      if (url.pathname === "/stars/all" && req.method === "GET") return stars.cors(await guarded(() => stars.all(env)));
    }
    const auth = /^\/auth\/([a-z]+)\/(start|callback)$/.exec(url.pathname);
    if (auth && accounts.isProvider(auth[1]) && req.method === "GET") {
      const p = auth[1];
      return guarded(() => (auth[2] === "start" ? accounts.start(url, p, env) : accounts.callback(req, url, p, env)));
    }
    const project = /^\/cloud\/projects\/([^/]+)$/.exec(url.pathname);
    if (url.pathname === "/me" || url.pathname === "/auth/logout" || url.pathname === "/cloud/projects" || project) {
      if (req.method === "OPTIONS") return accounts.cors(req, new Response(null, { status: 204 }), env);
      const route = `${req.method} ${project ? "/cloud/projects/:id" : url.pathname}`;
      const id = project?.[1] ?? "";
      const handler: Record<string, () => Promise<Response>> = {
        "GET /me": () => accounts.me(req, env),
        "DELETE /me": () => accounts.deleteAccount(req, env),
        "POST /auth/logout": () => accounts.logout(req, env),
        "GET /cloud/projects": () => accounts.list(req, env),
        "GET /cloud/projects/:id": () => accounts.get(req, id, env),
        "PUT /cloud/projects/:id": () => accounts.put(req, id, env),
        "DELETE /cloud/projects/:id": () => accounts.remove(req, id, env),
      };
      const f = handler[route];
      if (project && !accounts.validProjectId(id)) return accounts.cors(req, json({ error: "Invalid project id" }, 400), env);
      return accounts.cors(req, f ? await guarded(f) : json({ error: "Not found" }, 404), env);
    }
    if (url.pathname === "/") return new Response("BioCartoon submissions\n");
    return json({ error: "Not found" }, 404);
  },
} satisfies ExportedHandler<Env>;

async function fileBytes(form: FormData, name: string): Promise<Uint8Array | null> {
  const v = form.get(name);
  if (v === null) return null;
  return typeof v === "string" ? new TextEncoder().encode(v) : new Uint8Array(await v.arrayBuffer());
}

/** Whether the request carries the `UPLOAD_KEY` secret; a wrong key is refused rather than ignored. */
async function uploadKey(req: Request, env: Env): Promise<boolean> {
  const sent = req.headers.get("x-upload-key");
  if (sent === null) return false;
  // Comparing digests keeps the time taken independent of how much of the key matches.
  if (!env.UPLOAD_KEY || (await sha256Hex(sent)) !== (await sha256Hex(env.UPLOAD_KEY))) throw new Rejected("Invalid upload key", 403);
  return true;
}

async function submit(req: Request, env: Env): Promise<Response> {
  const length = Number(req.headers.get("content-length"));
  if (!length) throw new Rejected("Content-Length is required", 411);
  if (length > MAX_REQUEST_BYTES) throw new Rejected("Submission is too large", 413);

  const keyed = await uploadKey(req, env);
  const perDay = keyed ? MAX_PER_IP_PER_DAY_WITH_KEY : MAX_PER_IP_PER_DAY;
  const ipHash = (await sha256Hex(`${env.IP_SALT ?? "biocartoon"}:${req.headers.get("cf-connecting-ip") ?? "?"}`)).slice(0, 32);
  const now = new Date();
  const dayAgo = new Date(now.getTime() - 86_400_000).toISOString();
  const counts = await env.DB.prepare(
    "SELECT (SELECT count(*) FROM submissions WHERE ip_hash = ?1 AND created_at > ?2) AS mine, \
            (SELECT count(*) FROM submissions WHERE status = 'pending') AS pending",
  )
    .bind(ipHash, dayAgo)
    .first<{ mine: number; pending: number }>();
  if ((counts?.mine ?? 0) >= perDay) throw new Rejected(`Limit reached: ${perDay} submissions a day. Please try again tomorrow.`, 429);
  if (!keyed && (counts?.pending ?? 0) >= MAX_PENDING) throw new Rejected("The review queue is full. Please try again in a few days.", 503);

  const form = await req.formData();
  const kind = form.get("kind");
  let metaRaw: unknown;
  try {
    metaRaw = JSON.parse(String(form.get("meta") ?? ""));
  } catch {
    throw new Rejected("meta must be JSON", 400);
  }
  const meta = parseMeta(metaRaw);
  // Kept apart from meta, which is published: the address is only for the reviewers.
  const email = parseEmail((metaRaw as Record<string, unknown> | null)?.email);
  // Kept apart from meta too: only a reviewer can make it official (src/publish.ts).
  const officialRequested = (metaRaw as Record<string, unknown> | null)?.official === true;
  const id = newId(meta.title);
  const createdAt = now.toISOString().replace(/\.\d+Z$/, "Z");
  const puts: [string, Uint8Array, string][] = [];
  let width: number | null = null;
  let height: number | null = null;
  let pngSha: string | null = null;
  let texts: string[] = [];
  // Layers are colours of an SVG: a PNG or a template has none.
  let layers: Layer[] = [];

  if (kind === "asset") {
    const svg = await fileBytes(form, "svg");
    const png = svg ? null : await fileBytes(form, "image");
    if (svg) {
      checkSvg(svg);
      layers = meta.layers;
      puts.push([`${id}/image.svg`, svg, "image/svg+xml"]);
    } else if (png) {
      ({ width, height } = pngSize(png));
      pngSha = await sha256Hex(png);
      puts.push([`${id}/image.png`, png, "image/png"]);
    } else {
      throw new Rejected("image or svg is required", 400);
    }
  } else if (kind === "template") {
    const raw = await fileBytes(form, "template");
    const thumb = await fileBytes(form, "thumb");
    if (!raw || !thumb) throw new Rejected("template and thumb are required", 400);
    if (raw.length > MAX_TEMPLATE_JSON_BYTES) throw new Rejected("Template is too large", 413);
    ({ width, height } = pngSize(thumb));
    const uploaded = new Map<string, Uint8Array>();
    for (const name of new Set(form.keys())) {
      if (!["kind", "meta", "template", "thumb"].includes(name)) {
        if (!/^img-\d{1,3}\.png$/.test(name)) throw new Rejected(`Unexpected field ${name}`, 400);
        const b = (await fileBytes(form, name))!;
        pngSize(b);
        uploaded.set(name, b);
      }
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      throw new Rejected("Template is not valid JSON");
    }
    const t = checkTemplate(parsed, id, meta, new Set(uploaded.keys()), createdAt);
    for (const key of t.references) {
      if (!(await env.PUBLIC.head(key))) throw new Rejected(`Template uses an image that is not in the library (${key})`);
    }
    texts = t.texts;
    for (const [name, b] of uploaded) puts.push([`${id}/${name}`, b, "image/png"]);
    puts.push([`${id}/thumb.png`, thumb, "image/png"]);
    puts.push([`${id}/template.json`, new TextEncoder().encode(JSON.stringify(t.doc)), "application/json"]);
  } else {
    throw new Rejected("kind must be asset or template", 400);
  }

  for (const [key, body, contentType] of puts) await env.PENDING.put(key, body, { httpMetadata: { contentType } });
  try {
    await env.DB.prepare(
      "INSERT INTO submissions (id, kind, title, description, category, author, license, files, texts, width, height, bytes, png_sha256, ip_hash, created_at, email, tags, generative_ai_used, official_requested, layers) \
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)",
    )
      .bind(id, kind, meta.title, meta.description, meta.category, meta.author, meta.license, JSON.stringify(puts.map((p) => p[0])),
        JSON.stringify(texts.slice(0, 200)), width, height, puts.reduce((n, p) => n + p[1].length, 0), pngSha, ipHash, createdAt, email, JSON.stringify(meta.tags),
        meta.generative_ai_used === null ? null : Number(meta.generative_ai_used), Number(officialRequested), JSON.stringify(layers))
      .run();
  } catch (e) {
    await env.PENDING.delete(puts.map((p) => p[0]));
    throw e;
  }
  return json({ id, kind, status: "pending" }, 201);
}

async function suggest(req: Request, env: Env): Promise<Response> {
  const length = Number(req.headers.get("content-length"));
  if (!length) throw new Rejected("Content-Length is required", 411);
  if (length > 16 * 1024) throw new Rejected("Suggestion is too large", 413);
  const ipHash = (await sha256Hex(`${env.IP_SALT ?? "biocartoon"}:${req.headers.get("cf-connecting-ip") ?? "?"}`)).slice(0, 32);
  const now = new Date();
  const dayAgo = new Date(now.getTime() - 86_400_000).toISOString();
  const counts = await env.DB.prepare(
    "SELECT (SELECT count(*) FROM suggestions WHERE ip_hash = ?1 AND created_at > ?2) AS mine, \
            (SELECT count(*) FROM suggestions WHERE status = 'open') AS open",
  )
    .bind(ipHash, dayAgo)
    .first<{ mine: number; open: number }>();
  if ((counts?.mine ?? 0) >= MAX_SUGGESTIONS_PER_IP_PER_DAY) throw new Rejected(`Limit reached: ${MAX_SUGGESTIONS_PER_IP_PER_DAY} suggestions a day. Please try again tomorrow.`, 429);
  if ((counts?.open ?? 0) >= MAX_OPEN_SUGGESTIONS) throw new Rejected("The suggestion box is full. Please try again in a few days.", 503);
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new Rejected("Body must be JSON", 400);
  }
  const s = parseSuggestion(raw);
  const id = newId(s.title);
  await env.DB.prepare("INSERT INTO suggestions (id, kind, title, description, name, email, ip_hash, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)")
    .bind(id, s.kind, s.title, s.description, s.name, s.email, ipHash, now.toISOString().replace(/\.\d+Z$/, "Z"))
    .run();
  return json({ id, status: "open" }, 201);
}

async function removal(req: Request, env: Env): Promise<Response> {
  const length = Number(req.headers.get("content-length"));
  if (!length) throw new Rejected("Content-Length is required", 411);
  if (length > 16 * 1024) throw new Rejected("Request is too large", 413);
  const ipHash = (await sha256Hex(`${env.IP_SALT ?? "biocartoon"}:${req.headers.get("cf-connecting-ip") ?? "?"}`)).slice(0, 32);
  const now = new Date();
  const dayAgo = new Date(now.getTime() - 86_400_000).toISOString();
  const counts = await env.DB.prepare(
    "SELECT (SELECT count(*) FROM removal_requests WHERE ip_hash = ?1 AND created_at > ?2) AS mine, \
            (SELECT count(*) FROM removal_requests WHERE status = 'open') AS open",
  )
    .bind(ipHash, dayAgo)
    .first<{ mine: number; open: number }>();
  if ((counts?.mine ?? 0) >= MAX_REMOVALS_PER_IP_PER_DAY) throw new Rejected(`Limit reached: ${MAX_REMOVALS_PER_IP_PER_DAY} removal requests a day. Please try again tomorrow.`, 429);
  if ((counts?.open ?? 0) >= MAX_OPEN_REMOVALS) throw new Rejected("Too many removal requests are waiting. Please try again in a few days.", 503);
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new Rejected("Body must be JSON", 400);
  }
  const r = parseRemoval(raw);
  const id = newId(r.title || r.asset_id.split("/").pop() || "removal");
  await env.DB.prepare("INSERT INTO removal_requests (id, asset_id, title, reason, name, email, ip_hash, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)")
    .bind(id, r.asset_id, r.title, r.reason, r.name, r.email, ipHash, now.toISOString().replace(/\.\d+Z$/, "Z"))
    .run();
  return json({ id, status: "open" }, 201);
}

async function status(url: URL, env: Env): Promise<Response> {
  const ids = (url.searchParams.get("ids") ?? "").split(",").filter((s) => ID.test(s)).slice(0, 100);
  if (ids.length === 0) return json({});
  const { results } = await env.DB.prepare(`SELECT id, status FROM submissions WHERE id IN (${ids.map(() => "?").join(",")})`)
    .bind(...ids)
    .all<{ id: string; status: string }>();
  return json(Object.fromEntries(results.map((r) => [r.id, r.status])));
}
