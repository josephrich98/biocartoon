// Upload keys. The `UPLOAD_KEY` secret is the master key; with it, these routes make keys to share:
//
//   POST   /keys        {label, scope?: "own" | "all"}  -> 201 {id, key, label, scope}  (the key is shown only here)
//   GET    /keys        -> [{id, label, scope, created_at, last_used_at, revoked_at}]
//   DELETE /keys/<id>   revoke it
//
// Any key (master or shared and not revoked) lifts the daily limit to MAX_PER_IP_PER_DAY_WITH_KEY
// and lets `biocartoon upload --update ID` submit a new version of an approved asset: the master key
// and 'all' keys of any asset, 'own' keys of assets that were submitted with that key.

import type { Env } from "./env.ts";
import { json, sha256Hex } from "./http.ts";
import { Rejected } from "./text.ts";

export type Scope = "own" | "all";
/** The key a request carries. */
export type UploadKey = { id: "master"; scope: "all" } | { id: string; scope: Scope; label: string };

const KEY_ID = /^[a-f0-9]{8}$/;
const now = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");

/** The `X-Upload-Key` a request carries, or null without one; a wrong or revoked key is refused rather than ignored. */
export async function fromRequest(req: Request, env: Env): Promise<UploadKey | null> {
  const sent = req.headers.get("x-upload-key");
  if (sent === null) return null;
  const hash = await sha256Hex(sent);
  // Comparing digests keeps the time taken independent of how much of the key matches.
  if (env.UPLOAD_KEY && hash === (await sha256Hex(env.UPLOAD_KEY))) return { id: "master", scope: "all" };
  const row = await env.DB.prepare("SELECT id, label, scope, revoked_at FROM upload_keys WHERE key_hash = ?1")
    .bind(hash)
    .first<{ id: string; label: string; scope: Scope; revoked_at: string | null }>();
  if (!row) throw new Rejected("Invalid upload key", 403);
  if (row.revoked_at) throw new Rejected("This upload key was revoked", 403);
  await env.DB.prepare("UPDATE upload_keys SET last_used_at = ?2 WHERE id = ?1").bind(row.id, now()).run();
  return { id: row.id, scope: row.scope === "all" ? "all" : "own", label: row.label };
}

/** Whether `key` may submit an update of an asset submitted with `ownerKeyId`. */
export function mayUpdate(key: UploadKey | null, ownerKeyId: string | null): boolean {
  if (!key) return false;
  return key.scope === "all" || (ownerKeyId !== null && ownerKeyId === key.id);
}

/** A new key: `bck_` and 32 random bytes as base64url. */
export function newKey(): string {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return `bck_${btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
}

/** The /keys routes (master key only), or null when `url` isn't one. */
export async function route(req: Request, url: URL, env: Env): Promise<Response | null> {
  const one = /^\/keys\/([^/]+)$/.exec(url.pathname);
  if (url.pathname !== "/keys" && !one) return null;
  const key = await fromRequest(req, env);
  if (key?.id !== "master") throw new Rejected("Managing upload keys needs the master upload key", 403);
  if (url.pathname === "/keys" && req.method === "GET") {
    const { results } = await env.DB.prepare("SELECT id, label, scope, created_at, last_used_at, revoked_at FROM upload_keys ORDER BY created_at").all();
    return json(results);
  }
  if (url.pathname === "/keys" && req.method === "POST") {
    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      throw new Rejected("Body must be JSON", 400);
    }
    const { label, scope = "own" } = (raw ?? {}) as { label?: unknown; scope?: unknown };
    const name = typeof label === "string" ? label.replace(/[\x00-\x1f\x7f]/g, " ").trim() : "";
    if (!name || name.length > 80) throw new Rejected("label is required (up to 80 characters): who the key is for", 400);
    if (scope !== "own" && scope !== "all") throw new Rejected('scope must be "own" or "all"', 400);
    const id = [...crypto.getRandomValues(new Uint8Array(4))].map((b) => b.toString(16).padStart(2, "0")).join("");
    const secret = newKey();
    await env.DB.prepare("INSERT INTO upload_keys (id, key_hash, label, scope, created_at) VALUES (?1, ?2, ?3, ?4, ?5)")
      .bind(id, await sha256Hex(secret), name, scope, now())
      .run();
    return json({ id, key: secret, label: name, scope }, 201);
  }
  if (one && req.method === "DELETE") {
    if (!KEY_ID.test(one[1])) throw new Rejected("Invalid key id", 400);
    const r = await env.DB.prepare("UPDATE upload_keys SET revoked_at = coalesce(revoked_at, ?2) WHERE id = ?1 RETURNING id, label, revoked_at")
      .bind(one[1], now())
      .first();
    if (!r) throw new Rejected("No such key", 404);
    return json(r);
  }
  return json({ error: "Not found" }, 404);
}
