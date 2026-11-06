// Share links: a project the app encrypted (AES-256-GCM) before sending it, so this Worker keeps
// bytes it can't read. The decryption key travels only in the link's fragment, which browsers
// never send to a server. Anyone may share, signed in or not.
//
//   POST   /shares                 body = encrypted project; x-share-edit, x-share-owner: new secrets
//                                  -> {id, version: 1}
//   GET    /shares/<id>            -> {version, updated, bytes, expires, versions: [{version, updated, bytes}]}
//   GET    /shares/<id>/<version>  -> that version's encrypted bytes ("latest" for the newest)
//   PUT    /shares/<id>            body = new version; x-share-edit, x-share-base: the version it was
//                                  made from. 409 {error, version} when someone saved since.
//   DELETE /shares/<id>            x-share-owner: stop sharing (every version is deleted)
//
// The edit secret (in edit links, not view links) and the owner secret (kept by the sharer's app)
// are stored only as SHA-256 hashes. The latest MAX_SHARE_VERSIONS versions are kept, so an
// overwrite can be undone, and a link nobody has used for SHARE_IDLE_DAYS is deleted (on the
// daily cron, and when it is next asked for).

import { optionalUser } from "./accounts.ts";
import type { Env } from "./env.ts";
import { json, sha256Hex } from "./http.ts";
import {
  MAX_ACTIVE_SHARE_BYTES_GUEST, MAX_ACTIVE_SHARE_BYTES_USER, MAX_ACTIVE_SHARES_GUEST, MAX_ACTIVE_SHARES_USER, MAX_NEW_SHARES_PER_IP_PER_DAY, MAX_SHARE_BYTES,
  MAX_SHARE_VERSIONS, SHARE_IDLE_DAYS,
} from "./limits.ts";
import { Rejected } from "./text.ts";

/** Encrypted projects start with these bytes ("BCS1"), then the nonce and the ciphertext. */
export const MAGIC = [0x42, 0x43, 0x53, 0x31];
const ID = /^[A-Za-z0-9_-]{22}$/;
const SECRET = /^[A-Za-z0-9_-]{22,64}$/;
/** last_used is written at most this often, so checking an open project costs no writes. */
const TOUCH_MS = 3_600_000;

export const validShareId = (id: string) => ID.test(id);
export const validSecret = (s: string | null): s is string => s !== null && SECRET.test(s);
/** Each write gets its own object, so a save that loses a race never touches the winner's. */
const blobKey = (id: string, version: number) => `shares/${id}/${version}-${crypto.randomUUID()}.bin`;
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");
const now = () => iso(Date.now());

/** When a share last used at `lastUsed` (ISO) expires. */
export function expiresAt(lastUsed: string): string {
  return iso(Date.parse(lastUsed) + SHARE_IDLE_DAYS * 86_400_000);
}
export function expired(lastUsed: string, at = Date.now()): boolean {
  return at > Date.parse(lastUsed) + SHARE_IDLE_DAYS * 86_400_000;
}

/** The versions to delete once `latest` is written: all but the newest MAX_SHARE_VERSIONS. */
export function versionsToDrop(kept: number[], latest: number): number[] {
  return kept.filter((v) => v <= latest - MAX_SHARE_VERSIONS);
}

interface Share {
  id: string;
  edit_hash: string;
  owner_hash: string;
  version: number;
  bytes: number;
  updated_at: string;
  last_used: string;
}

async function body(req: Request): Promise<Uint8Array> {
  const length = Number(req.headers.get("content-length"));
  if (!length) throw new Rejected("Content-Length is required", 411);
  if (length > MAX_SHARE_BYTES) throw new Rejected(`This project is over ${MAX_SHARE_BYTES >> 20} MB, too large to share`, 413);
  const b = new Uint8Array(await req.arrayBuffer());
  if (b.length !== length) throw new Rejected("The upload was cut short", 400);
  if (b.length < 4 + 12 + 16 || MAGIC.some((m, i) => b[i] !== m)) throw new Rejected("Expected an encrypted BioCartoon project", 400);
  return b;
}

/** The share, or 404 if there is none (an expired one is deleted on the way). */
async function find(env: Env, id: string): Promise<Share> {
  const s = await env.DB.prepare("SELECT id, edit_hash, owner_hash, version, bytes, updated_at, last_used FROM shares WHERE id = ?1").bind(id).first<Share>();
  if (s && expired(s.last_used)) {
    await deleteShare(env, id);
  } else if (s) {
    return s;
  }
  throw new Rejected("This share link has expired or was turned off", 404);
}

async function touch(env: Env, s: Share): Promise<void> {
  if (Date.now() - Date.parse(s.last_used) < TOUCH_MS) return;
  s.last_used = now();
  await env.DB.prepare("UPDATE shares SET last_used = ?2 WHERE id = ?1").bind(s.id, s.last_used).run();
}

async function checkSecret(given: string | null, hash: string, what: string): Promise<void> {
  if (!validSecret(given) || (await sha256Hex(given)) !== hash) throw new Rejected(`This link can't ${what} the shared project`, 403);
}

function newShareId(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function create(req: Request, env: Env): Promise<Response> {
  const edit = req.headers.get("x-share-edit");
  const owner = req.headers.get("x-share-owner");
  if (!validSecret(edit) || !validSecret(owner) || edit === owner) throw new Rejected("x-share-edit and x-share-owner must be two random secrets", 400);
  const userId = await optionalUser(req, env);
  const ipHash = (await sha256Hex(`${env.IP_SALT ?? "biocartoon"}:${req.headers.get("cf-connecting-ip") ?? "?"}`)).slice(0, 32);
  const dayAgo = iso(Date.now() - 86_400_000);
  const [recent, active] = await env.DB.batch<{ n: number; bytes: number }>([
    env.DB.prepare("SELECT count(*) AS n, 0 AS bytes FROM shares WHERE ip_hash = ?1 AND created_at > ?2").bind(ipHash, dayAgo),
    userId
      ? env.DB.prepare("SELECT count(*) AS n, coalesce(sum(bytes), 0) AS bytes FROM shares WHERE user_id = ?1").bind(userId)
      : env.DB.prepare("SELECT count(*) AS n, coalesce(sum(bytes), 0) AS bytes FROM shares WHERE ip_hash = ?1 AND user_id IS NULL").bind(ipHash),
  ]);
  if ((recent.results[0]?.n ?? 0) >= MAX_NEW_SHARES_PER_IP_PER_DAY) throw new Rejected("Too many new share links today; please try again tomorrow", 429);
  const [maxCount, maxBytes] = userId ? [MAX_ACTIVE_SHARES_USER, MAX_ACTIVE_SHARE_BYTES_USER] : [MAX_ACTIVE_SHARES_GUEST, MAX_ACTIVE_SHARE_BYTES_GUEST];
  const a = active.results[0] ?? { n: 0, bytes: 0 };
  if (a.n >= maxCount) throw new Rejected(`Limit reached: ${maxCount} share links at once. Turn off sharing for some projects first${userId ? "" : ", or sign in for more"}.`, 413);
  const b = await body(req);
  if (a.bytes + b.length > maxBytes) throw new Rejected(`Your share links hold ${maxBytes >> 20} MB already. Turn off sharing for some projects first${userId ? "" : ", or sign in for more"}.`, 413);
  const id = newShareId();
  const t = now();
  const blob = blobKey(id, 1);
  await env.USERS.put(blob, b, { httpMetadata: { contentType: "application/octet-stream" } });
  await env.DB.batch([
    env.DB.prepare("INSERT INTO shares (id, edit_hash, owner_hash, user_id, ip_hash, version, bytes, created_at, updated_at, last_used) VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, ?7, ?7, ?7)")
      .bind(id, await sha256Hex(edit), await sha256Hex(owner), userId, ipHash, b.length, t),
    env.DB.prepare("INSERT INTO share_versions (share_id, version, bytes, blob, created_at) VALUES (?1, 1, ?2, ?3, ?4)").bind(id, b.length, blob, t),
  ]);
  return json({ id, version: 1, expires: expiresAt(t) });
}

export async function info(id: string, env: Env): Promise<Response> {
  const s = await find(env, id);
  await touch(env, s);
  const { results } = await env.DB.prepare("SELECT version, bytes, created_at AS updated FROM share_versions WHERE share_id = ?1 ORDER BY version DESC").bind(id).all();
  return json({ version: s.version, updated: s.updated_at, bytes: s.bytes, expires: expiresAt(s.last_used), versions: results });
}

export async function download(id: string, which: string, env: Env): Promise<Response> {
  const s = await find(env, id);
  const version = which === "latest" ? s.version : Number(which);
  if (!Number.isSafeInteger(version) || version < 1) throw new Rejected("Unknown version", 400);
  const row = await env.DB.prepare("SELECT blob FROM share_versions WHERE share_id = ?1 AND version = ?2").bind(id, version).first<{ blob: string }>();
  const obj = row && (await env.USERS.get(row.blob));
  if (!obj) throw new Rejected("That version is no longer kept", 404);
  await touch(env, s);
  return new Response(obj.body, { headers: { "content-type": "application/octet-stream", "cache-control": "no-store", "x-share-version": String(version) } });
}

export async function update(req: Request, id: string, env: Env): Promise<Response> {
  const s = await find(env, id);
  await checkSecret(req.headers.get("x-share-edit"), s.edit_hash, "edit");
  const base = Number(req.headers.get("x-share-base"));
  if (!Number.isSafeInteger(base)) throw new Rejected("x-share-base must be the version this edit was made from", 400);
  if (base !== s.version) return json({ error: "Someone else saved a newer version of this shared project", version: s.version }, 409);
  const b = await body(req);
  const version = s.version + 1;
  const t = now();
  const blob = blobKey(id, version);
  await env.USERS.put(blob, b, { httpMetadata: { contentType: "application/octet-stream" } });
  // Only the edit made from the latest version wins: a second one, racing it, finds version moved on.
  const r = await env.DB.prepare("UPDATE shares SET version = ?2, bytes = ?3, updated_at = ?4, last_used = ?4 WHERE id = ?1 AND version = ?5")
    .bind(id, version, b.length, t, s.version)
    .run();
  if (!r.meta.changes) {
    await env.USERS.delete(blob);
    const cur = await env.DB.prepare("SELECT version FROM shares WHERE id = ?1").bind(id).first<{ version: number }>();
    return json({ error: "Someone else saved a newer version of this shared project", version: cur?.version ?? s.version }, 409);
  }
  await env.DB.prepare("INSERT OR REPLACE INTO share_versions (share_id, version, bytes, blob, created_at) VALUES (?1, ?2, ?3, ?4, ?5)").bind(id, version, b.length, blob, t).run();
  const { results } = await env.DB.prepare("SELECT version, blob FROM share_versions WHERE share_id = ?1").bind(id).all<{ version: number; blob: string }>();
  const drop = versionsToDrop(results.map((x) => x.version), version);
  if (drop.length) {
    await env.USERS.delete(results.filter((x) => drop.includes(x.version)).map((x) => x.blob));
    await env.DB.batch(drop.map((v) => env.DB.prepare("DELETE FROM share_versions WHERE share_id = ?1 AND version = ?2").bind(id, v)));
  }
  return json({ version, expires: expiresAt(t) });
}

export async function stop(req: Request, id: string, env: Env): Promise<Response> {
  const s = await find(env, id);
  await checkSecret(req.headers.get("x-share-owner"), s.owner_hash, "turn off");
  await deleteShare(env, id);
  return json({ ok: true });
}

/** Delete a share: every version kept and its rows. */
export async function deleteShare(env: Env, id: string): Promise<void> {
  // By prefix, so an object left by a save cut short goes too.
  let cursor: string | undefined;
  do {
    const page = await env.USERS.list({ prefix: `shares/${id}/`, cursor });
    if (page.objects.length) await env.USERS.delete(page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM share_versions WHERE share_id = ?1").bind(id),
    env.DB.prepare("DELETE FROM shares WHERE id = ?1").bind(id),
  ]);
}

/** Delete every share a (deleted) account made. */
export async function deleteOwned(env: Env, userId: string): Promise<void> {
  const { results } = await env.DB.prepare("SELECT id FROM shares WHERE user_id = ?1").bind(userId).all<{ id: string }>();
  for (const r of results) await deleteShare(env, r.id);
}

/** The daily cron: delete shares idle for SHARE_IDLE_DAYS. */
export async function sweep(env: Env): Promise<number> {
  const cutoff = iso(Date.now() - SHARE_IDLE_DAYS * 86_400_000);
  const { results } = await env.DB.prepare("SELECT id FROM shares WHERE last_used < ?1 LIMIT 500").bind(cutoff).all<{ id: string }>();
  for (const r of results) await deleteShare(env, r.id);
  return results.length;
}
