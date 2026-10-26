// "Publish catalog now": the review page queues a request; the Mac that holds the master DB
// (data/publish_poll.py, every few minutes) claims it here, runs publish_catalog.py and reports
// back. The Mac's routes are on the submit Worker, since the review Worker sits behind Access.
//
//   POST /publish/claim    Authorization: Bearer <PUBLISH_TOKEN>  -> {"ids": [<id>, ...]} (now running)
//   POST /publish/finish   Authorization: Bearer <PUBLISH_TOKEN>  {"ids": [...], "ok": bool, "message": "..."}

import type { Env } from "./env.ts";
import { json, sha256Hex } from "./http.ts";

/** A run that has not reported back after this long (the Mac slept or died) no longer blocks a new request. */
export const STALE_RUN_MINUTES = 90;
export const MAX_MESSAGE_CHARS = 4000;

export interface PublishRequest {
  id: number;
  requested_at: string;
  requested_by: string;
  status: "requested" | "running" | "done" | "failed";
  started_at: string | null;
  finished_at: string | null;
  message: string;
}

const now = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");

/** Queues a publish unless one is already waiting or running; returns whether it queued one. */
export async function request(env: Env, who: string): Promise<boolean> {
  const busy = await env.DB.prepare(
    `SELECT 1 FROM publish_requests WHERE status = 'requested'
       OR (status = 'running' AND started_at > strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-${STALE_RUN_MINUTES} minutes')) LIMIT 1`,
  ).first();
  if (busy) return false;
  await env.DB.prepare("INSERT INTO publish_requests (requested_at, requested_by) VALUES (?1, ?2)").bind(now(), who).run();
  return true;
}

export async function latest(env: Env): Promise<PublishRequest | null> {
  return env.DB.prepare("SELECT * FROM publish_requests ORDER BY id DESC LIMIT 1").first<PublishRequest>();
}

/** Whether `header` is `Bearer <token>` (compared as hashes, so the time taken says nothing about it). */
export async function authorized(header: string | null, token: string | undefined): Promise<boolean> {
  if (!token || !header?.startsWith("Bearer ")) return false;
  return (await sha256Hex(header.slice(7))) === (await sha256Hex(token));
}

export function parseFinish(body: unknown): { ids: number[]; ok: boolean; message: string } | null {
  if (typeof body !== "object" || body === null) return null;
  const { ids, ok, message } = body as Record<string, unknown>;
  if (!Array.isArray(ids) || !ids.every((i) => Number.isInteger(i)) || typeof ok !== "boolean") return null;
  return { ids: ids.slice(0, 100) as number[], ok, message: typeof message === "string" ? message.slice(-MAX_MESSAGE_CHARS) : "" };
}

/** The Mac's two routes; null for any other path. */
export async function route(req: Request, url: URL, env: Env): Promise<Response | null> {
  if (url.pathname !== "/publish/claim" && url.pathname !== "/publish/finish") return null;
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (!(await authorized(req.headers.get("authorization"), env.PUBLISH_TOKEN))) return json({ error: "Forbidden" }, 403);
  if (url.pathname === "/publish/claim") {
    const r = await env.DB.prepare("UPDATE publish_requests SET status = 'running', started_at = ?1 WHERE status = 'requested' RETURNING id")
      .bind(now())
      .all<{ id: number }>();
    return json({ ids: r.results.map((x) => x.id) });
  }
  const f = parseFinish(await req.json().catch(() => null));
  if (!f) return json({ error: "expected {ids, ok, message}" }, 400);
  for (const id of f.ids) {
    await env.DB.prepare("UPDATE publish_requests SET status = ?2, finished_at = ?3, message = ?4 WHERE id = ?1 AND status = 'running'")
      .bind(id, f.ok ? "done" : "failed", now(), f.message)
      .run();
  }
  return json({ ok: true });
}
