// Approving copies a submission into the public bucket in the layout the app's publish pipeline
// reads (data/uploads.py): `user/<id>.png` or `user/<id>.svg`, + `user/<id>.json`, or `templates/<id>/...` with
// template.json written last. publish_catalog.py then merges it into the catalog.
//
// Both decisions can be undone. Rejecting keeps the pending files (purgeRejected deletes them
// once REJECTED_KEEP_DAYS have passed); undoing an approval moves the files back to the pending
// bucket, and the next publish_catalog.py run drops the item from the catalog.

import type { Env } from "./env.ts";
import { sha256Hex } from "./http.ts";
import { Rejected } from "./text.ts";
import { creditLine } from "./validate.ts";

/** How long a rejected submission's files are kept, so the rejection can be undone. */
export const REJECTED_KEEP_DAYS = 30;

export interface Row {
  id: string;
  kind: "asset" | "template";
  title: string;
  description: string;
  category: string;
  author: string;
  license: string;
  files: string;
  texts: string;
  width: number | null;
  height: number | null;
  bytes: number;
  png_sha256: string | null;
  created_at: string;
  status: string;
  reviewed_at: string | null;
  reviewed_by: string | null;
}

const IMMUTABLE = "public, max-age=31536000, immutable";

async function copy(env: Env, from: string, to: string, contentType: string): Promise<ArrayBuffer> {
  const obj = await env.PENDING.get(from);
  if (!obj) throw new Error(`pending object ${from} is missing`);
  const body = await obj.arrayBuffer();
  // An SVG opened straight from the bucket downloads instead of rendering on the bucket's origin
  // (images and fetches of it are unaffected).
  const contentDisposition = contentType === "image/svg+xml" ? "attachment" : undefined;
  await env.PUBLIC.put(to, body, { httpMetadata: { contentType, cacheControl: IMMUTABLE, contentDisposition } });
  return body;
}

export async function approve(env: Env, row: Row, reviewer: string): Promise<void> {
  const files: string[] = JSON.parse(row.files);
  if (row.kind === "asset") {
    const key = `user/${row.id}.png`;
    let image;
    if (files.includes(`${row.id}/image.svg`)) {
      // data/uploads.py renders `png_key` from it when it publishes the catalog.
      const svgKey = `user/${row.id}.svg`;
      const body = await copy(env, `${row.id}/image.svg`, svgKey, "image/svg+xml");
      image = { svg_key: svgKey, svg_bytes: body.byteLength, svg_sha256: await sha256Hex(body) };
    } else {
      const bytes = (await copy(env, `${row.id}/image.png`, key, "image/png")).byteLength;
      image = { png_width: row.width, png_height: row.height, png_bytes: bytes, png_sha256: row.png_sha256 };
    }
    const credit = creditLine(row.title, row.author, row.license);
    const sidecar = {
      id: `user/${row.id}`, title: row.title, description: row.description, category: row.category, license: row.license,
      credit, author: row.author, png_key: key, ...image, created_at: row.created_at,
    };
    await env.PUBLIC.put(`user/${row.id}.json`, JSON.stringify(sidecar), { httpMetadata: { contentType: "application/json" } });
  } else {
    // template.json last: publishing only looks for it, so it never sees a partial template.
    const ordered = [...files.filter((f) => !f.endsWith("template.json")), ...files.filter((f) => f.endsWith("template.json"))];
    for (const f of ordered) {
      const name = f.slice(row.id.length + 1);
      await copy(env, f, `templates/${row.id}/${name}`, name.endsWith(".json") ? "application/json" : "image/png");
    }
  }
  await env.PENDING.delete(files);
  await setStatus(env, row.id, "approved", reviewer);
}

export async function reject(env: Env, row: Row, reviewer: string): Promise<void> {
  await setStatus(env, row.id, "rejected", reviewer);
}

/** Where approve() puts a pending file in the public bucket. */
export function publicKey(row: Pick<Row, "id" | "kind">, pendingKey: string): string {
  const name = pendingKey.slice(row.id.length + 1);
  if (row.kind === "template") return `templates/${row.id}/${name}`;
  if (name === "image.png") return `user/${row.id}.png`;
  if (name === "image.svg") return `user/${row.id}.svg`;
  throw new Error(`unexpected asset file ${pendingKey}`);
}

/** Puts an approved or rejected submission back in the queue. */
export async function undo(env: Env, row: Row): Promise<void> {
  const files: string[] = JSON.parse(row.files);
  if (row.status === "rejected") {
    const present = await Promise.all(files.map((f) => env.PENDING.head(f)));
    if (!files.length || present.some((o) => !o)) throw new Rejected("This rejection is too old to undo: its files were deleted.", 409);
  } else if (row.status === "approved") {
    // Copy back first, so a failure part way leaves the item published rather than lost.
    for (const f of files) {
      const obj = await env.PUBLIC.get(publicKey(row, f));
      if (!obj) throw new Rejected(`Can't undo: ${publicKey(row, f)} is no longer in the public bucket.`, 409);
      await env.PENDING.put(f, await obj.arrayBuffer(), { httpMetadata: { contentType: obj.httpMetadata?.contentType } });
    }
    // The file publishing looks for goes first, so it never sees a half-removed item. An SVG's
    // user/<id>.png is rendered by data/uploads.py, so it may be there even though no pending file maps to it.
    const keys = row.kind === "asset"
      ? [`user/${row.id}.json`, `user/${row.id}.png`, `user/${row.id}.svg`]
      : [`templates/${row.id}/template.json`, ...files.map((f) => publicKey(row, f))];
    for (const k of keys) await env.PUBLIC.delete(k);
  } else {
    return;
  }
  await env.DB.prepare("UPDATE submissions SET status = 'pending', reviewed_at = NULL, reviewed_by = NULL WHERE id = ?1").bind(row.id).run();
}

/** Deletes the files of rejections older than REJECTED_KEEP_DAYS (run daily by the review Worker's cron). */
export async function purgeRejected(env: Env, now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - REJECTED_KEEP_DAYS * 86400_000).toISOString().replace(/\.\d+Z$/, "Z");
  const rows = await env.DB.prepare("SELECT id, files FROM submissions WHERE status = 'rejected' AND files != '[]' AND reviewed_at < ?1 LIMIT 200")
    .bind(cutoff).all<{ id: string; files: string }>();
  for (const r of rows.results) {
    const files: string[] = JSON.parse(r.files);
    if (files.length) await env.PENDING.delete(files);
    await env.DB.prepare("UPDATE submissions SET files = '[]' WHERE id = ?1").bind(r.id).run();
  }
  return rows.results.length;
}

async function setStatus(env: Env, id: string, status: string, reviewer: string): Promise<void> {
  await env.DB.prepare("UPDATE submissions SET status = ?2, reviewed_at = ?3, reviewed_by = ?4 WHERE id = ?1")
    .bind(id, status, new Date().toISOString().replace(/\.\d+Z$/, "Z"), reviewer)
    .run();
}

