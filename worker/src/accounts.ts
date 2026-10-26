// Optional accounts (biocartoon-app: app/src/account.rs is the client). Signing in keeps an online
// copy of every project and of Your library (own icons, saved templates, favorites), so work
// survives a browser clearing its storage. Nobody has to: guests
// keep everything in the browser, as before.
//
// Sign-in is Google or GitHub OAuth, run here, so no passwords are stored. The app gets a random
// session token (D1 keeps only its SHA-256) and sends it as `Authorization: Bearer <token>`;
// with no cookies involved there is nothing to forge cross-site.
//
//   GET    /auth/<google|github>/start?return=<app url>  -> redirect to the provider
//   GET    /auth/<google|github>/callback                -> redirect to <app url>#biocartoon_session=<token>
//                                                           (or #biocartoon_error=<message>)
//   POST   /auth/logout                                  ends this session
//   GET    /me                                           -> {"name", "email", "provider", "used", "quota"}
//   DELETE /me                                           deletes the account and every online project
//   GET    /cloud/projects                               -> {"projects": [{"id", "name", "modified", "bytes"}]}
//   GET    /cloud/projects/<id>                          -> the project as a .biocartoon file
//   PUT    /cloud/projects/<id>   body: the .biocartoon file; headers x-project-name (URI-encoded),
//                                 x-project-modified (Unix ms)
//   DELETE /cloud/projects/<id>
//   GET    /cloud/library                                -> {"items": [{"id", "modified", "bytes"}]}
//   GET    /cloud/library/<id>                           -> the item's JSON, as the app sent it
//   PUT    /cloud/library/<id>    body: JSON; header x-item-modified (Unix ms)
//   DELETE /cloud/library/<id>
//   Library ids are "asset.<slug>", "template.<slug>" or "favorites".

import type { Env } from "./env.ts";
import { json, sha256Hex } from "./http.ts";
import { MAX_CLOUD_LIBRARY_ITEM_BYTES, MAX_CLOUD_LIBRARY_ITEMS, MAX_CLOUD_PROJECT_BYTES, MAX_CLOUD_PROJECTS, MAX_CLOUD_USER_BYTES, MAX_SIGNUPS_PER_IP_PER_DAY, SESSION_IDLE_DAYS } from "./limits.ts";
import { Rejected } from "./text.ts";

type Provider = "google" | "github";

interface Identity {
  subject: string;
  email: string;
  name: string;
}

const PROVIDERS: Record<Provider, { authorize: string; token: string; scope: string }> = {
  google: { authorize: "https://accounts.google.com/o/oauth2/v2/auth", token: "https://oauth2.googleapis.com/token", scope: "openid email profile" },
  github: { authorize: "https://github.com/login/oauth/authorize", token: "https://github.com/login/oauth/access_token", scope: "read:user user:email" },
};

const STATE_COOKIE = "__Host-biocartoon_oauth";
const PROJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LIBRARY_ID = /^(?:(?:asset|template)\.[a-z0-9][a-z0-9_-]{0,159}|favorites)$/;
const DEFAULT_ORIGINS = "https://app.biocartoon.com";

const now = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");

export function isProvider(p: string): p is Provider {
  return p === "google" || p === "github";
}

export function validProjectId(id: string): boolean {
  return PROJECT_ID.test(id);
}

export function validLibraryId(id: string): boolean {
  return LIBRARY_ID.test(id);
}

/** Origins the app is served from (`APP_ORIGINS`, comma-separated): where sign-in may return to
 *  and which pages may call the account routes. */
export function appOrigins(env: Env): string[] {
  return (env.APP_ORIGINS ?? DEFAULT_ORIGINS).split(",").map((s) => s.trim()).filter(Boolean);
}

/** `ret` without its fragment, if it is a page on one of the app's origins; otherwise null. */
export function returnUrl(ret: string | null, env: Env): string | null {
  if (!ret) return null;
  let u: URL;
  try {
    u = new URL(ret);
  } catch {
    return null;
  }
  if (!appOrigins(env).includes(u.origin)) return null;
  u.hash = "";
  return u.toString();
}

export function cookie(req: Request, name: string): string | null {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

const toB64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const b64url = (s: string) => toB64url(new TextEncoder().encode(s));
export const unb64url = (s: string) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)));

const randomToken = (bytes: number) => toB64url(crypto.getRandomValues(new Uint8Array(bytes)));

function credentials(env: Env, p: Provider): { id: string; secret: string } {
  const [id, secret] = p === "google" ? [env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET] : [env.GITHUB_CLIENT_ID, env.GITHUB_CLIENT_SECRET];
  if (!id || !secret) throw new Rejected(`Signing in with ${p === "google" ? "Google" : "GitHub"} isn't set up on this server`, 503);
  return { id, secret };
}

const redirect = (to: string, headers: Record<string, string> = {}) => new Response(null, { status: 302, headers: { location: to, "cache-control": "no-store", ...headers } });

// ---------- sign-in ----------

/** Send the browser to the provider. The state (and Google's PKCE verifier) ride in a short-lived
 *  cookie on this origin, which the callback checks so nobody can complete a sign-in they didn't start. */
export async function start(url: URL, p: Provider, env: Env): Promise<Response> {
  const ret = returnUrl(url.searchParams.get("return"), env);
  if (!ret) throw new Rejected("Unknown return address", 400);
  const { id } = credentials(env, p);
  const state = randomToken(24);
  const verifier = randomToken(48);
  const q = new URLSearchParams({ client_id: id, redirect_uri: `${url.origin}/auth/${p}/callback`, scope: PROVIDERS[p].scope, state, response_type: "code" });
  if (p === "google") {
    q.set("code_challenge", toB64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)))));
    q.set("code_challenge_method", "S256");
    q.set("prompt", "select_account");
  }
  const value = [state, verifier, b64url(ret)].join(".");
  return redirect(`${PROVIDERS[p].authorize}?${q}`, { "set-cookie": `${STATE_COOKIE}=${value}; Path=/; Max-Age=600; HttpOnly; Secure; SameSite=Lax` });
}

export async function callback(req: Request, url: URL, p: Provider, env: Env): Promise<Response> {
  const [state, verifier, ret64] = (cookie(req, STATE_COOKIE) ?? "").split(".");
  let ret: string | null = null;
  try {
    ret = ret64 ? returnUrl(unb64url(ret64), env) : null;
  } catch {
    ret = null;
  }
  const clear = { "set-cookie": `${STATE_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax` };
  if (!ret || !state || url.searchParams.get("state") !== state) {
    // Expired or forged: there is no trusted page to go back to.
    return new Response("This sign-in link has expired. Go back to BioCartoon and try again.\n", { status: 400, headers: clear });
  }
  const fail = (msg: string) => redirect(`${ret}#biocartoon_error=${encodeURIComponent(msg)}`, clear);
  const code = url.searchParams.get("code");
  if (!code) return fail(url.searchParams.get("error") === "access_denied" ? "Sign-in was cancelled" : "Sign-in didn't complete");
  try {
    const who = await identify(p, code, verifier, `${url.origin}/auth/${p}/callback`, env);
    const ipHash = (await sha256Hex(`${env.IP_SALT ?? "biocartoon"}:${req.headers.get("cf-connecting-ip") ?? "?"}`)).slice(0, 32);
    const userId = await upsertUser(env, p, who, ipHash);
    const token = randomToken(32);
    const t = now();
    await env.DB.prepare("INSERT INTO sessions (token_hash, user_id, created_at, last_used) VALUES (?1, ?2, ?3, ?3)").bind(await sha256Hex(token), userId, t).run();
    return redirect(`${ret}#biocartoon_session=${token}`, clear);
  } catch (e) {
    if (e instanceof Rejected) return fail(e.message);
    console.error(e);
    return fail("Sign-in failed on the server; please try again later");
  }
}

async function identify(p: Provider, code: string, verifier: string, redirectUri: string, env: Env): Promise<Identity> {
  const { id, secret } = credentials(env, p);
  const form = new URLSearchParams({ client_id: id, client_secret: secret, code, redirect_uri: redirectUri, grant_type: "authorization_code" });
  if (p === "google") form.set("code_verifier", verifier);
  const tok = await fetch(PROVIDERS[p].token, { method: "POST", headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" }, body: form });
  const t = (await tok.json().catch(() => ({}))) as { access_token?: string };
  if (!tok.ok || !t.access_token) throw new Rejected("The sign-in provider didn't accept the request", 502);
  const auth = { authorization: `Bearer ${t.access_token}`, accept: "application/json", "user-agent": "biocartoon-accounts" };
  if (p === "google") {
    const u = (await (await fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers: auth })).json()) as { sub?: string; email?: string; email_verified?: boolean; name?: string };
    if (!u.sub) throw new Rejected("Google didn't say who you are", 502);
    return { subject: u.sub, email: u.email_verified ? (u.email ?? "") : "", name: u.name ?? "" };
  }
  const u = (await (await fetch("https://api.github.com/user", { headers: auth })).json()) as { id?: number; login?: string; name?: string | null };
  if (!u.id) throw new Rejected("GitHub didn't say who you are", 502);
  const emails = (await (await fetch("https://api.github.com/user/emails", { headers: auth })).json().catch(() => [])) as { email: string; primary: boolean; verified: boolean }[];
  const email = Array.isArray(emails) ? (emails.find((e) => e.primary && e.verified)?.email ?? "") : "";
  return { subject: String(u.id), email, name: u.name || u.login || "" };
}

/** The user for this identity, made on first sign-in. Accounts are per provider: the same email at
 *  Google and GitHub gives two accounts, since linking on email would trust each provider's checks. */
async function upsertUser(env: Env, p: Provider, who: Identity, ipHash: string): Promise<string> {
  const t = now();
  const existing = await env.DB.prepare("SELECT id FROM users WHERE provider = ?1 AND subject = ?2").bind(p, who.subject).first<{ id: string }>();
  if (existing) {
    await env.DB.prepare("UPDATE users SET email = ?2, name = ?3, last_seen = ?4 WHERE id = ?1").bind(existing.id, who.email, who.name.slice(0, 200), t).run();
    return existing.id;
  }
  const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
  const recent = await env.DB.prepare("SELECT count(*) AS n FROM users WHERE ip_hash = ?1 AND created_at > ?2").bind(ipHash, dayAgo).first<{ n: number }>();
  if ((recent?.n ?? 0) >= MAX_SIGNUPS_PER_IP_PER_DAY) throw new Rejected("Too many new accounts from this network today; please try again tomorrow", 429);
  const id = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO users (id, provider, subject, email, name, ip_hash, created_at, last_seen) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)")
    .bind(id, p, who.subject, who.email, who.name.slice(0, 200), ipHash, t)
    .run();
  return id;
}

// ---------- signed-in routes ----------

interface Session {
  tokenHash: string;
  userId: string;
}

/** The session behind the request's bearer token. Sessions end after SESSION_IDLE_DAYS unused;
 *  the online projects stay, and signing in again brings them back. */
async function session(req: Request, env: Env): Promise<Session> {
  const token = /^Bearer ([A-Za-z0-9_-]{20,100})$/.exec(req.headers.get("authorization") ?? "")?.[1];
  if (!token) throw new Rejected("Not signed in", 401);
  const tokenHash = await sha256Hex(token);
  const row = await env.DB.prepare("SELECT user_id, last_used FROM sessions WHERE token_hash = ?1").bind(tokenHash).first<{ user_id: string; last_used: string }>();
  if (!row) throw new Rejected("Your sign-in has expired; please sign in again", 401);
  const idle = Date.now() - Date.parse(row.last_used);
  if (idle > SESSION_IDLE_DAYS * 86_400_000) {
    await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?1").bind(tokenHash).run();
    throw new Rejected("Your sign-in has expired; please sign in again", 401);
  }
  if (idle > 86_400_000) {
    const t = now();
    await env.DB.batch([
      env.DB.prepare("UPDATE sessions SET last_used = ?2 WHERE token_hash = ?1").bind(tokenHash, t),
      env.DB.prepare("UPDATE users SET last_seen = ?2 WHERE id = ?1").bind(row.user_id, t),
    ]);
  }
  return { tokenHash, userId: row.user_id };
}

const projectKey = (userId: string, id: string) => `users/${userId}/projects/${id}.biocartoon`;
const libraryKey = (userId: string, id: string) => `users/${userId}/library/${id}.json`;

/** Online space used by projects and library items together, leaving out the project or library
 *  item `except` (about to be replaced); `count` counts only that table's rows. */
async function usedBytes(env: Env, userId: string, except = "", table: "cloud_projects" | "cloud_library" = "cloud_projects"): Promise<{ bytes: number; count: number }> {
  const other = table === "cloud_projects" ? "cloud_library" : "cloud_projects";
  const [mine, theirs] = await env.DB.batch<{ bytes: number; count: number }>([
    env.DB.prepare(`SELECT coalesce(sum(bytes), 0) AS bytes, count(*) AS count FROM ${table} WHERE user_id = ?1 AND id != ?2`).bind(userId, except),
    env.DB.prepare(`SELECT coalesce(sum(bytes), 0) AS bytes, count(*) AS count FROM ${other} WHERE user_id = ?1`).bind(userId),
  ]);
  const a = mine.results[0];
  const b = theirs.results[0];
  return { bytes: (a?.bytes ?? 0) + (b?.bytes ?? 0), count: a?.count ?? 0 };
}

export async function logout(req: Request, env: Env): Promise<Response> {
  const s = await session(req, env);
  await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?1").bind(s.tokenHash).run();
  return json({ ok: true });
}

export async function me(req: Request, env: Env): Promise<Response> {
  const s = await session(req, env);
  const u = await env.DB.prepare("SELECT provider, email, name FROM users WHERE id = ?1").bind(s.userId).first<{ provider: string; email: string; name: string }>();
  if (!u) throw new Rejected("This account no longer exists", 401);
  const used = await usedBytes(env, s.userId);
  return json({ ...u, used: used.bytes, projects: used.count, quota: MAX_CLOUD_USER_BYTES });
}

/** Delete the account: every online project and library item, every session, the user row. */
export async function deleteAccount(req: Request, env: Env): Promise<Response> {
  const s = await session(req, env);
  const prefix = `users/${s.userId}/`;
  let cursor: string | undefined;
  do {
    const page = await env.USERS.list({ prefix, cursor });
    if (page.objects.length) await env.USERS.delete(page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM cloud_projects WHERE user_id = ?1").bind(s.userId),
    env.DB.prepare("DELETE FROM cloud_library WHERE user_id = ?1").bind(s.userId),
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ?1").bind(s.userId),
    env.DB.prepare("DELETE FROM users WHERE id = ?1").bind(s.userId),
  ]);
  return json({ ok: true });
}

export async function list(req: Request, env: Env): Promise<Response> {
  const s = await session(req, env);
  const { results } = await env.DB.prepare("SELECT id, name, modified, bytes FROM cloud_projects WHERE user_id = ?1 ORDER BY modified DESC")
    .bind(s.userId)
    .all<{ id: string; name: string; modified: number; bytes: number }>();
  return json({ projects: results });
}

export async function get(req: Request, id: string, env: Env): Promise<Response> {
  const s = await session(req, env);
  const obj = await env.USERS.get(projectKey(s.userId, id));
  if (!obj) throw new Rejected("No such project", 404);
  return new Response(obj.body, { headers: { "content-type": "application/x-biocartoon", "cache-control": "no-store" } });
}

export async function put(req: Request, id: string, env: Env): Promise<Response> {
  const s = await session(req, env);
  const length = Number(req.headers.get("content-length"));
  if (!length) throw new Rejected("Content-Length is required", 411);
  if (length > MAX_CLOUD_PROJECT_BYTES) throw new Rejected(`This project is over ${MAX_CLOUD_PROJECT_BYTES >> 20} MB, too large to keep online`, 413);
  const modified = Number(req.headers.get("x-project-modified"));
  if (!Number.isSafeInteger(modified) || modified <= 0) throw new Rejected("x-project-modified must be Unix milliseconds", 400);
  let name: string;
  try {
    name = decodeURIComponent(req.headers.get("x-project-name") ?? "").trim().slice(0, 200) || "Untitled";
  } catch {
    throw new Rejected("x-project-name must be URI-encoded", 400);
  }
  const used = await usedBytes(env, s.userId, id);
  if (used.count >= MAX_CLOUD_PROJECTS) throw new Rejected(`Limit reached: ${MAX_CLOUD_PROJECTS} projects online`, 413);
  if (used.bytes + length > MAX_CLOUD_USER_BYTES) throw new Rejected(`Your online space (${MAX_CLOUD_USER_BYTES >> 20} MB) is full; delete some projects to make room`, 413);
  const body = new Uint8Array(await req.arrayBuffer());
  if (body.length !== length) throw new Rejected("The upload was cut short", 400);
  if (body[0] !== 0x7b) throw new Rejected("Expected a .biocartoon file", 400); // "{"
  await env.USERS.put(projectKey(s.userId, id), body, { httpMetadata: { contentType: "application/x-biocartoon" } });
  await env.DB.prepare(
    "INSERT INTO cloud_projects (user_id, id, name, modified, bytes, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6) \
     ON CONFLICT (user_id, id) DO UPDATE SET name = ?3, modified = ?4, bytes = ?5, updated_at = ?6",
  )
    .bind(s.userId, id, name, modified, body.length, now())
    .run();
  return json({ id, bytes: body.length, used: used.bytes + body.length, quota: MAX_CLOUD_USER_BYTES });
}

export async function remove(req: Request, id: string, env: Env): Promise<Response> {
  const s = await session(req, env);
  await env.USERS.delete(projectKey(s.userId, id));
  await env.DB.prepare("DELETE FROM cloud_projects WHERE user_id = ?1 AND id = ?2").bind(s.userId, id).run();
  return json({ ok: true });
}

// ---------- Your library ----------

export async function libraryList(req: Request, env: Env): Promise<Response> {
  const s = await session(req, env);
  const { results } = await env.DB.prepare("SELECT id, modified, bytes FROM cloud_library WHERE user_id = ?1 ORDER BY modified DESC")
    .bind(s.userId)
    .all<{ id: string; modified: number; bytes: number }>();
  return json({ items: results });
}

export async function libraryGet(req: Request, id: string, env: Env): Promise<Response> {
  const s = await session(req, env);
  const obj = await env.USERS.get(libraryKey(s.userId, id));
  if (!obj) throw new Rejected("No such library item", 404);
  return new Response(obj.body, { headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

export async function libraryPut(req: Request, id: string, env: Env): Promise<Response> {
  const s = await session(req, env);
  const length = Number(req.headers.get("content-length"));
  if (!length) throw new Rejected("Content-Length is required", 411);
  if (length > MAX_CLOUD_LIBRARY_ITEM_BYTES) throw new Rejected(`This library item is over ${MAX_CLOUD_LIBRARY_ITEM_BYTES >> 20} MB, too large to keep online`, 413);
  const modified = Number(req.headers.get("x-item-modified"));
  if (!Number.isSafeInteger(modified) || modified <= 0) throw new Rejected("x-item-modified must be Unix milliseconds", 400);
  const used = await usedBytes(env, s.userId, id, "cloud_library");
  if (used.count >= MAX_CLOUD_LIBRARY_ITEMS) throw new Rejected(`Limit reached: ${MAX_CLOUD_LIBRARY_ITEMS} library items online`, 413);
  if (used.bytes + length > MAX_CLOUD_USER_BYTES) throw new Rejected(`Your online space (${MAX_CLOUD_USER_BYTES >> 20} MB) is full; delete some projects or library items to make room`, 413);
  const body = new Uint8Array(await req.arrayBuffer());
  if (body.length !== length) throw new Rejected("The upload was cut short", 400);
  if (body[0] !== 0x7b && body[0] !== 0x5b) throw new Rejected("Expected a JSON library item", 400); // "{" or "["
  await env.USERS.put(libraryKey(s.userId, id), body, { httpMetadata: { contentType: "application/json" } });
  await env.DB.prepare(
    "INSERT INTO cloud_library (user_id, id, modified, bytes, updated_at) VALUES (?1, ?2, ?3, ?4, ?5) \
     ON CONFLICT (user_id, id) DO UPDATE SET modified = ?3, bytes = ?4, updated_at = ?5",
  )
    .bind(s.userId, id, modified, body.length, now())
    .run();
  return json({ id, bytes: body.length, used: used.bytes + body.length, quota: MAX_CLOUD_USER_BYTES });
}

export async function libraryRemove(req: Request, id: string, env: Env): Promise<Response> {
  const s = await session(req, env);
  await env.USERS.delete(libraryKey(s.userId, id));
  await env.DB.prepare("DELETE FROM cloud_library WHERE user_id = ?1 AND id = ?2").bind(s.userId, id).run();
  return json({ ok: true });
}

// ---------- CORS ----------

/** The app runs on another origin, so the signed-in routes answer its origin (and only its). */
export function cors(req: Request, res: Response, env: Env): Response {
  const origin = req.headers.get("origin");
  const r = new Response(res.body, res);
  if (origin && appOrigins(env).includes(origin)) {
    r.headers.set("access-control-allow-origin", origin);
    r.headers.set("access-control-allow-methods", "GET, PUT, POST, DELETE, OPTIONS");
    r.headers.set("access-control-allow-headers", "authorization, content-type, x-project-name, x-project-modified, x-item-modified");
    r.headers.set("access-control-max-age", "86400");
    r.headers.set("vary", "origin");
  }
  return r;
}
