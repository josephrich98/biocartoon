// Approving copies a submission into the public bucket in the layout the app's publish pipeline
// reads (data/uploads.py): `user/<id>.png` or `user/<id>.svg`, + `user/<id>.json`, or `templates/<id>/...` with
// template.json written last. publish_catalog.py then merges it into the catalog.
//
// Both decisions can be undone. Rejecting keeps the pending files (purgeRejected deletes them
// once REJECTED_KEEP_DAYS have passed); undoing an approval moves the files back to the pending
// bucket, and the next publish_catalog.py run drops the item from the catalog.
//
// An update (`replaces`, from `biocartoon upload --update ID`) is published under its own id, so its
// files get new keys (they are cached as immutable). Its sidecar's `replaces` lists every id it is a
// newer version of, newest first; data/uploads.py leaves those out and the catalog gives the update
// their catalog id. The old files stay in the bucket, so projects that use them still open.

import type { Env } from "./env.ts";
import { sha256Hex } from "./http.ts";
import { Rejected } from "./text.ts";
import { type Layer, creditLine, parseLayers } from "./validate.ts";

/** How long a rejected submission's files are kept, so the rejection can be undone. */
export const REJECTED_KEEP_DAYS = 30;

export interface Row {
  id: string;
  kind: "asset" | "template";
  title: string;
  description: string;
  category: string;
  /** JSON array of strings. */
  tags: string;
  /** JSON array of `{name, colors}` (an SVG asset's named colour layers). */
  layers: string;
  author: string;
  license: string;
  /** 1 / 0 / null (not said, or submitted before the question). */
  generative_ai_used: number | null;
  /** How generative AI was used, in the contributor's words ('' when not said). */
  generative_ai_details: string;
  /** Optional contact address for reviewers; never published. */
  email: string;
  files: string;
  texts: string;
  width: number | null;
  height: number | null;
  bytes: number;
  png_sha256: string | null;
  created_at: string;
  status: string;
  /** 1 when the contributor asked for it to go in the official BioCartoon library. */
  official_requested: number;
  /** 1 when a reviewer accepted it to the official BioCartoon library (its author unchanged). */
  official: number;
  reviewed_at: string | null;
  reviewed_by: string | null;
  /** The approved asset this is a new version of (src/submit.ts), or null. */
  replaces: string | null;
  /** The approved update of this asset, once there is one. */
  replaced_by: string | null;
  /** The upload key it was submitted with ('master', a shared key's id, or null). */
  key_id: string | null;
}

const IMMUTABLE = "public, max-age=31536000, immutable";

async function copy(env: Env, from: string, to: string, contentType: string, edit?: (b: ArrayBuffer) => ArrayBuffer): Promise<ArrayBuffer> {
  const obj = await env.PENDING.get(from);
  if (!obj) throw new Error(`pending object ${from} is missing`);
  const raw = await obj.arrayBuffer();
  const body = edit ? edit(raw) : raw;
  // An SVG opened straight from the bucket downloads instead of rendering on the bucket's origin
  // (images and fetches of it are unaffected).
  const contentDisposition = contentType === "image/svg+xml" ? "attachment" : undefined;
  await env.PUBLIC.put(to, body, { httpMetadata: { contentType, cacheControl: IMMUTABLE, contentDisposition } });
  return body;
}

/** Publishes a submission. `official` lists it under the official BioCartoon library rather than
 *  the user-generated one (data/uploads.py reads the flag from an asset's sidecar, or a template's
 *  template.json); it stays credited to its contributor. */
export async function approve(env: Env, row: Row, reviewer: string, official = false): Promise<void> {
  const files: string[] = JSON.parse(row.files);
  // Read before anything is written, so a missing target leaves the update pending.
  const target = row.replaces ? await latestVersion(env, row.replaces) : null;
  const lineage = target ? [target, ...(await sidecarReplaces(env, target))] : [];
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
      id: `user/${row.id}`, title: row.title, description: row.description, category: row.category, tags: rowTags(row), license: row.license,
      credit, author: row.author, png_key: key, ...image, created_at: row.created_at, ...(official && { official: true }),
      generative_ai_used: row.generative_ai_used == null ? null : row.generative_ai_used === 1,
      ...(row.generative_ai_used === 1 && row.generative_ai_details && { generative_ai_details: row.generative_ai_details }),
      ...(image.svg_key && rowLayers(row).length && { layers: rowLayers(row) }),
      ...(lineage.length && { replaces: lineage.map((id) => `user/${id}`) }),
    };
    await env.PUBLIC.put(`user/${row.id}.json`, JSON.stringify(sidecar), { httpMetadata: { contentType: "application/json" } });
  } else {
    // template.json last: publishing only looks for it, so it never sees a partial template.
    const ordered = [...files.filter((f) => !f.endsWith("template.json")), ...files.filter((f) => f.endsWith("template.json"))];
    const markOfficial = (b: ArrayBuffer) => {
      const t = JSON.parse(new TextDecoder().decode(b));
      t.meta = { ...t.meta, official: true };
      return new TextEncoder().encode(JSON.stringify(t)).buffer as ArrayBuffer;
    };
    for (const f of ordered) {
      const name = f.slice(row.id.length + 1);
      const json = name.endsWith(".json");
      await copy(env, f, `templates/${row.id}/${name}`, json ? "application/json" : "image/png", json && official ? markOfficial : undefined);
    }
  }
  await env.PENDING.delete(files);
  await setStatus(env, row.id, "approved", reviewer, official);
  if (target) await env.DB.prepare("UPDATE submissions SET replaced_by = ?2 WHERE id = ?1").bind(target, row.id).run();
}

/** The newest approved version of upload `id`: itself, or the update that replaced it, and so on. */
export async function latestVersion(env: Env, id: string): Promise<string> {
  let at = id;
  for (let i = 0; i < 100; i++) {
    const r = await env.DB.prepare("SELECT status, replaced_by FROM submissions WHERE id = ?1").bind(at).first<{ status: string; replaced_by: string | null }>();
    if (!r || r.status !== "approved") throw new Rejected(`Can't publish this update: ${at}, the asset it updates, is no longer approved.`, 409);
    if (!r.replaced_by) return at;
    at = r.replaced_by;
  }
  throw new Rejected(`Can't publish this update: ${id} has too many versions.`, 409);
}

/** The ids (without `user/`) the published sidecar of upload `id` says it replaces. */
async function sidecarReplaces(env: Env, id: string): Promise<string[]> {
  const obj = await env.PUBLIC.get(`user/${id}.json`);
  if (!obj) throw new Rejected(`Can't publish this update: user/${id}.json, the asset it updates, is not in the public bucket.`, 409);
  const r: unknown = JSON.parse(new TextDecoder().decode(await obj.arrayBuffer())).replaces;
  return Array.isArray(r) ? r.filter((x): x is string => typeof x === "string" && x.startsWith("user/")).map((x) => x.slice(5)) : [];
}

/** A row's tags (rows from before tags were kept have none). */
export function rowTags(row: Pick<Row, "tags">): string[] {
  try {
    const t: unknown = JSON.parse(row.tags ?? "[]");
    return Array.isArray(t) ? t.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** A row's layers (rows from before layers were kept, or malformed ones, have none). */
export function rowLayers(row: Pick<Row, "layers">): Layer[] {
  try {
    return parseLayers(JSON.parse(row.layers ?? "[]"));
  } catch {
    return [];
  }
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
    if (row.replaced_by) throw new Rejected(`Can't undo: it was updated since (by ${row.replaced_by}); undo that update first.`, 409);
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
  // The version it replaced is the newest again (its sidecar never left the bucket).
  if (row.status === "approved" && row.replaces) await env.DB.prepare("UPDATE submissions SET replaced_by = NULL WHERE replaced_by = ?1").bind(row.id).run();
  await env.DB.prepare("UPDATE submissions SET status = 'pending', reviewed_at = NULL, reviewed_by = NULL, official = 0 WHERE id = ?1").bind(row.id).run();
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

async function setStatus(env: Env, id: string, status: string, reviewer: string, official = false): Promise<void> {
  await env.DB.prepare("UPDATE submissions SET status = ?2, reviewed_at = ?3, reviewed_by = ?4, official = ?5 WHERE id = ?1")
    .bind(id, status, new Date().toISOString().replace(/\.\d+Z$/, "Z"), reviewer, official ? 1 : 0)
    .run();
}

