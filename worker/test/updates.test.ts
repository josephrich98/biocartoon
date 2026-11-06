import { test } from "node:test";
import assert from "node:assert/strict";
import { type Row, approve, latestVersion, undo } from "../src/publish.ts";
import { Rejected } from "../src/text.ts";
import { mayUpdate, newKey } from "../src/upload_keys.ts";

// Just enough of R2 and D1 for updates: a bucket, and a submissions table the fake DB answers
// the statements publish.ts sends about it.
function bucket() {
  const m = new Map<string, { body: ArrayBuffer; contentType?: string }>();
  const enc = (b: ArrayBuffer | Uint8Array | string) => (typeof b === "string" ? new TextEncoder().encode(b).buffer : b instanceof Uint8Array ? b.slice().buffer : b);
  return {
    m,
    async get(k: string) {
      const o = m.get(k);
      return o ? { arrayBuffer: async () => o.body, httpMetadata: { contentType: o.contentType } } : null;
    },
    async head(k: string) {
      return m.has(k) ? {} : null;
    },
    async put(k: string, body: ArrayBuffer | Uint8Array | string, opts?: { httpMetadata?: { contentType?: string } }) {
      m.set(k, { body: enc(body) as ArrayBuffer, contentType: opts?.httpMetadata?.contentType });
    },
    async delete(k: string | string[]) {
      for (const key of Array.isArray(k) ? k : [k]) m.delete(key);
    },
  };
}

function setup(rows: Row[]) {
  const PENDING = bucket(), PUBLIC = bucket();
  const table = new Map(rows.map((r) => [r.id, r]));
  for (const r of rows) for (const f of JSON.parse(r.files) as string[]) PENDING.m.set(f, { body: new TextEncoder().encode(f).buffer });
  const DB = {
    prepare(sql: string) {
      return {
        bind(...a: unknown[]) {
          return {
            async first() {
              const r = table.get(a[0] as string);
              return r ? { ...r } : null;
            },
            async run() {
              if (sql.startsWith("UPDATE submissions SET replaced_by = ?2")) table.get(a[0] as string)!.replaced_by = a[1] as string;
              else if (sql.includes("replaced_by = NULL")) {
                for (const r of table.values()) if (r.replaced_by === a[0]) r.replaced_by = null;
              }
              else if (sql.includes("status = 'pending'")) Object.assign(table.get(a[0] as string)!, { status: "pending", reviewed_at: null, reviewed_by: null, official: 0 });
              else Object.assign(table.get(a[0] as string)!, { status: a[1], reviewed_at: a[2], reviewed_by: a[3], official: a[4] });
            },
          };
        },
      };
    },
  };
  return { env: { PENDING, PUBLIC, DB } as any, PENDING, PUBLIC, table };
}

const asset = (id: string, replaces: string | null = null): Row => ({
  id, kind: "asset", title: "Cell", description: "", category: "", tags: "[]", layers: "[]", author: "Me", license: "CC0-1.0", files: JSON.stringify([`${id}/image.png`]),
  texts: "[]", width: 10, height: 10, bytes: 3, png_sha256: null, created_at: "2026-10-01T00:00:00Z", status: "pending",
  reviewed_at: null, reviewed_by: null, official_requested: 0, official: 0, generative_ai_used: 0, generative_ai_details: "", email: "",
  replaces, replaced_by: null, key_id: null,
});
const sidecar = (PUBLIC: ReturnType<typeof bucket>, k: string) => JSON.parse(new TextDecoder().decode(PUBLIC.m.get(k)!.body));

test("an update is published under its own id and lists every version it replaces", async () => {
  const [v1, v2, v3] = [asset("cell-1"), asset("cell-2", "cell-1"), asset("cell-3", "cell-1")];
  const { env, PUBLIC, table } = setup([v1, v2, v3]);
  await approve(env, table.get("cell-1")!, "me");
  await approve(env, table.get("cell-2")!, "me");
  assert.deepEqual(sidecar(PUBLIC, "user/cell-2.json").replaces, ["user/cell-1"]);
  assert.equal(table.get("cell-1")!.replaced_by, "cell-2");
  // v3 named v1 too, but v2 is the newest by the time it is approved.
  assert.equal(await latestVersion(env, "cell-1"), "cell-2");
  await approve(env, table.get("cell-3")!, "me");
  assert.deepEqual(sidecar(PUBLIC, "user/cell-3.json").replaces, ["user/cell-2", "user/cell-1"]);
  assert.equal(table.get("cell-2")!.replaced_by, "cell-3");
  // The old versions stay published, for the projects that use their files.
  assert.ok(["user/cell-1.png", "user/cell-1.json", "user/cell-2.png", "user/cell-3.png"].every((k) => PUBLIC.m.has(k)));
  assert.equal(sidecar(PUBLIC, "user/cell-1.json").replaces, undefined);
});

test("an updated version can't be undone before its update; undoing the update restores it", async () => {
  const [v1, v2] = [asset("cell-1"), asset("cell-2", "cell-1")];
  const { env, PUBLIC, table } = setup([v1, v2]);
  await approve(env, table.get("cell-1")!, "me");
  await approve(env, table.get("cell-2")!, "me");
  await assert.rejects(undo(env, table.get("cell-1")!), Rejected);
  await undo(env, table.get("cell-2")!);
  assert.equal(table.get("cell-1")!.replaced_by, null);
  assert.equal(table.get("cell-2")!.status, "pending");
  assert.ok(!PUBLIC.m.has("user/cell-2.json") && PUBLIC.m.has("user/cell-1.json"));
  await undo(env, table.get("cell-1")!);
  assert.equal(table.get("cell-1")!.status, "pending");
});

test("an update of an asset that is no longer approved stays pending", async () => {
  const [v1, v2] = [asset("cell-1"), asset("cell-2", "cell-1")];
  const { env, PUBLIC, table, PENDING } = setup([v1, v2]);
  await assert.rejects(approve(env, table.get("cell-2")!, "me"), Rejected);
  assert.equal(table.get("cell-2")!.status, "pending");
  assert.ok(PENDING.m.has("cell-2/image.png") && !PUBLIC.m.has("user/cell-2.json"));
});

test("upload keys", () => {
  assert.match(newKey(), /^bck_[A-Za-z0-9_-]{43}$/);
  assert.notEqual(newKey(), newKey());
  const master = { id: "master" as const, scope: "all" as const };
  const own = { id: "ab12cd34", scope: "own" as const, label: "Ann" };
  assert.ok(mayUpdate(master, null) && mayUpdate(master, "ab12cd34"));
  assert.ok(mayUpdate({ ...own, scope: "all" }, null));
  assert.ok(mayUpdate(own, "ab12cd34"));
  assert.ok(!mayUpdate(own, null) && !mayUpdate(own, "master") && !mayUpdate(own, "ffffffff"));
  assert.ok(!mayUpdate(null, null));
});
