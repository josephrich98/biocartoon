// Stars on catalog assets (biocartoon-app: app/src/stars.rs is the client). Counts live in D1 (migration
// 0002_stars.sql); publish_catalog.py copies them into the catalog's `stars` column.
//
//   POST /star       JSON {"id": <asset id>, "client": <hex>, "on": true|false}
//                    -> {"id", "stars": <count>, "starred": <bool>}
//   GET  /stars?ids=<id>,<id>&client=<hex>
//                    -> {"stars": {"<id>": <count>}, "mine": ["<id>"]}   (only starred ids)
//   GET  /stars/all  -> {"<id>": <count>}   every asset with at least one star (for publishing)

import type { Env } from "./env.ts";
import { json, sha256Hex } from "./http.ts";
import { MAX_STAR_IDS, MAX_STARS_PER_IP_PER_DAY } from "./limits.ts";
import { Rejected } from "./text.ts";

/** The two-letter codes of catalog ids (data/build_assets_db.py's ID_PREFIX). */
const ID_PREFIXES = ["BA", "BI", "HI", "OM", "RE", "SD", "SV", "US"];

/** Catalog ids look like `BA000123`: the source's code, then a number unique across the catalog. */
export function validId(id: unknown): id is string {
  return typeof id === "string" && /^[A-Z]{2}[0-9]{6,9}$/.test(id) && ID_PREFIXES.includes(id.slice(0, 2));
}

export function validClient(c: unknown): c is string {
  return typeof c === "string" && /^[a-f0-9]{16,64}$/.test(c);
}

/** The ids of a `?ids=` list, deduplicated, invalid ones dropped, at most MAX_STAR_IDS. */
export function parseIds(list: string | null): string[] {
  const out: string[] = [];
  for (const id of (list ?? "").split(",")) {
    if (validId(id) && !out.includes(id)) out.push(id);
    if (out.length >= MAX_STAR_IDS) break;
  }
  return out;
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "86400",
};

/** The web build runs on another origin, so the star routes answer with CORS headers. */
export function cors(res: Response): Response {
  const r = new Response(res.body, res);
  for (const [k, v] of Object.entries(CORS)) r.headers.set(k, v);
  return r;
}

export function preflight(): Response {
  return new Response(null, { status: 204, headers: CORS });
}

const now = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");

export async function toggle(req: Request, env: Env): Promise<Response> {
  let body: { id?: unknown; client?: unknown; on?: unknown };
  try {
    body = await req.json();
  } catch {
    throw new Rejected("Expected a JSON body", 400);
  }
  if (!validId(body.id)) throw new Rejected("Invalid asset id", 400);
  if (!validClient(body.client)) throw new Rejected("Invalid client id", 400);
  if (typeof body.on !== "boolean") throw new Rejected("`on` must be true or false", 400);
  const { id, client, on } = body;

  const row = await env.DB.prepare('SELECT "on" FROM starred WHERE asset_id = ?1 AND client = ?2').bind(id, client).first<{ on: number }>();
  const current = row ? row.on === 1 : false;
  const count = () => env.DB.prepare("SELECT n FROM stars WHERE asset_id = ?1").bind(id).first<{ n: number }>().then((r) => r?.n ?? 0);
  if (current === on) return json({ id, stars: await count(), starred: on });

  const t = now();
  const ipHash = (await sha256Hex(`${env.IP_SALT ?? "biocartoon"}:${req.headers.get("cf-connecting-ip") ?? "?"}`)).slice(0, 32);
  if (!row) {
    if (!on) return json({ id, stars: await count(), starred: false });
    const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
    const mine = await env.DB.prepare("SELECT count(*) AS n FROM starred WHERE ip_hash = ?1 AND created_at > ?2").bind(ipHash, dayAgo).first<{ n: number }>();
    if ((mine?.n ?? 0) >= MAX_STARS_PER_IP_PER_DAY) throw new Rejected(`Limit reached: ${MAX_STARS_PER_IP_PER_DAY} new stars a day. Please try again tomorrow.`, 429);
    // The Worker has no catalog to look ids up in: well-formed ones are taken, and the daily quota
    // above bounds what junk one address can add.
  }
  const delta = on ? 1 : -1;
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO starred (asset_id, client, "on", ip_hash, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5) \
       ON CONFLICT (asset_id, client) DO UPDATE SET "on" = ?3, updated_at = ?5',
    ).bind(id, client, on ? 1 : 0, ipHash, t),
    env.DB.prepare("INSERT INTO stars (asset_id, n) VALUES (?1, max(0, ?2)) ON CONFLICT (asset_id) DO UPDATE SET n = max(0, n + ?2)").bind(id, delta),
  ]);
  return json({ id, stars: await count(), starred: on });
}

export async function counts(url: URL, env: Env): Promise<Response> {
  const ids = parseIds(url.searchParams.get("ids"));
  const client = url.searchParams.get("client");
  const stars: Record<string, number> = {};
  const mine: string[] = [];
  if (ids.length > 0) {
    const marks = ids.map(() => "?").join(",");
    const { results } = await env.DB.prepare(`SELECT asset_id, n FROM stars WHERE n > 0 AND asset_id IN (${marks})`)
      .bind(...ids)
      .all<{ asset_id: string; n: number }>();
    for (const r of results) stars[r.asset_id] = r.n;
    if (validClient(client)) {
      const { results } = await env.DB.prepare(`SELECT asset_id FROM starred WHERE client = ? AND "on" = 1 AND asset_id IN (${marks})`)
        .bind(client, ...ids)
        .all<{ asset_id: string }>();
      for (const r of results) mine.push(r.asset_id);
    }
  }
  return json({ stars, mine });
}

export async function all(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare("SELECT asset_id, n FROM stars WHERE n > 0").all<{ asset_id: string; n: number }>();
  const res = json(Object.fromEntries(results.map((r) => [r.asset_id, r.n])));
  res.headers.set("cache-control", "no-cache");
  return res;
}
