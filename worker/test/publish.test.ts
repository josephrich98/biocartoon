import { test } from "node:test";
import assert from "node:assert/strict";
import { REJECTED_KEEP_DAYS, type Row, approve, publicKey, purgeRejected, reject, undo } from "../src/publish.ts";
import { Rejected } from "../src/text.ts";

// Just enough of R2 and D1 for publish.ts. The fake DB understands the few statements it sends.
function bucket() {
  const m = new Map<string, { body: ArrayBuffer; contentType?: string }>();
  return {
    m,
    async get(k: string) {
      const o = m.get(k);
      return o ? { arrayBuffer: async () => o.body, httpMetadata: { contentType: o.contentType } } : null;
    },
    async head(k: string) {
      return m.has(k) ? {} : null;
    },
    async put(k: string, body: ArrayBuffer | Uint8Array, opts?: { httpMetadata?: { contentType?: string } }) {
      m.set(k, { body: body instanceof Uint8Array ? body.slice().buffer : body, contentType: opts?.httpMetadata?.contentType });
    },
    async delete(k: string | string[]) {
      for (const key of Array.isArray(k) ? k : [k]) m.delete(key);
    },
  };
}

function setup(row: Row, pending: string[]) {
  const PENDING = bucket(), PUBLIC = bucket();
  for (const f of pending) PENDING.m.set(f, { body: new TextEncoder().encode(f).buffer, contentType: f.endsWith(".svg") ? "image/svg+xml" : "image/png" });
  const DB = {
    prepare(sql: string) {
      return {
        bind(...a: unknown[]) {
          return {
            async run() {
              if (sql.includes("status = 'pending'")) Object.assign(row, { status: "pending", reviewed_at: null, reviewed_by: null, official: 0 });
              else if (sql.includes("files = '[]'")) row.files = "[]";
              else Object.assign(row, { status: a[1], reviewed_at: a[2], reviewed_by: a[3], official: a[4] });
            },
            async all() {
              const old = row.status === "rejected" && row.files !== "[]" && row.reviewed_at! < (a[0] as string);
              return { results: old ? [{ id: row.id, files: row.files }] : [] };
            },
          };
        },
      };
    },
  };
  return { env: { PENDING, PUBLIC, DB } as any, PENDING, PUBLIC };
}

const asset = (id: string, files: string[]): Row => ({
  id, kind: "asset", title: "Cell", description: "", category: "", tags: '["cell", "membrane"]', author: "Me", license: "CC0-1.0", files: JSON.stringify(files),
  texts: "[]", width: 10, height: 10, bytes: 3, png_sha256: null, created_at: "2026-10-01T00:00:00Z", status: "pending",
  reviewed_at: null, reviewed_by: null, official: 0,
});
const sidecar = (PUBLIC: ReturnType<typeof bucket>, k: string) => {
  const b: unknown = PUBLIC.m.get(k)!.body; // the sidecar is put as a string
  return JSON.parse(typeof b === "string" ? b : new TextDecoder().decode(b as ArrayBuffer));
};

test("public keys", () => {
  assert.equal(publicKey({ id: "a", kind: "asset" }, "a/image.png"), "user/a.png");
  assert.equal(publicKey({ id: "a", kind: "asset" }, "a/image.svg"), "user/a.svg");
  assert.equal(publicKey({ id: "t", kind: "template" }, "t/img-3.png"), "templates/t/img-3.png");
  assert.throws(() => publicKey({ id: "a", kind: "asset" }, "a/other.png"));
});

for (const ext of ["png", "svg"]) {
  test(`undoing an approved ${ext} puts it back in the queue`, async () => {
    const row = asset("cell", [`cell/image.${ext}`]);
    const { env, PENDING, PUBLIC } = setup(row, [`cell/image.${ext}`]);
    await approve(env, row, "me@example.com");
    assert.equal(row.status, "approved");
    assert.equal(PENDING.m.size, 0);
    assert.ok(PUBLIC.m.has(`user/cell.${ext}`) && PUBLIC.m.has("user/cell.json"));
    if (ext === "svg") PUBLIC.m.set("user/cell.png", { body: new ArrayBuffer(1) }); // rendered by uploads.py
    await undo(env, row);
    assert.equal(row.status, "pending");
    assert.equal(row.reviewed_by, null);
    assert.deepEqual([...PUBLIC.m.keys()], []);
    assert.deepEqual([...PENDING.m.keys()], [`cell/image.${ext}`]);
    assert.equal(PENDING.m.get(`cell/image.${ext}`)!.contentType, ext === "svg" ? "image/svg+xml" : "image/png");
    await approve(env, row, "me@example.com");
    assert.equal(row.status, "approved");
  });
}

test("undoing an approved template", async () => {
  const files = ["t/img-0.png", "t/thumb.png", "t/template.json"];
  const row = { ...asset("t", files), kind: "template" as const };
  const { env, PENDING, PUBLIC } = setup(row, files);
  await approve(env, row, "me");
  await undo(env, row);
  assert.equal(PUBLIC.m.size, 0);
  assert.deepEqual([...PENDING.m.keys()].sort(), [...files].sort());
});

test("an official approval credits BioCartoon, and undoing it clears the flag", async () => {
  const row = asset("cell", ["cell/image.png"]);
  const { env, PUBLIC } = setup(row, ["cell/image.png"]);
  await approve(env, row, "me");
  assert.equal(sidecar(PUBLIC, "user/cell.json").author, "Me");
  assert.deepEqual(sidecar(PUBLIC, "user/cell.json").tags, ["cell", "membrane"]);
  assert.equal(sidecar(PUBLIC, "user/cell.json").official, undefined);
  await undo(env, row);
  await approve(env, row, "me", true);
  const s = sidecar(PUBLIC, "user/cell.json");
  assert.deepEqual([s.author, s.credit, s.official, row.official], ["BioCartoon", '"Cell", BioCartoon, CC0', true, 1]);
  await undo(env, row);
  assert.equal(row.official, 0);
});

test("an official template is credited to BioCartoon in its template.json", async () => {
  const files = ["t/thumb.png", "t/template.json"];
  const row = { ...asset("t", files), kind: "template" as const };
  const { env, PENDING, PUBLIC } = setup(row, files);
  PENDING.m.set("t/template.json", { body: new TextEncoder().encode(JSON.stringify({ meta: { id: "t", author: "Me" }, width: 1 })).buffer });
  await approve(env, row, "me", true);
  assert.deepEqual(sidecar(PUBLIC, "templates/t/template.json"), { meta: { id: "t", author: "BioCartoon" }, width: 1 });
});

test("undoing an approval whose public files are gone fails without changing anything", async () => {
  const row = asset("cell", ["cell/image.png"]);
  const { env, PUBLIC } = setup(row, ["cell/image.png"]);
  await approve(env, row, "me");
  PUBLIC.m.delete("user/cell.png");
  await assert.rejects(undo(env, row), Rejected);
  assert.equal(row.status, "approved");
  assert.ok(PUBLIC.m.has("user/cell.json"));
});

test("rejections keep their files until purged, and can be undone until then", async () => {
  const row = asset("cell", ["cell/image.png"]);
  const { env, PENDING } = setup(row, ["cell/image.png"]);
  await reject(env, row, "me");
  assert.equal(row.status, "rejected");
  assert.ok(PENDING.m.has("cell/image.png"));
  await undo(env, row);
  assert.equal(row.status, "pending");

  await reject(env, row, "me");
  const reviewed = new Date(row.reviewed_at!);
  assert.equal(await purgeRejected(env, new Date(reviewed.getTime() + (REJECTED_KEEP_DAYS - 1) * 86400_000)), 0);
  assert.equal(await purgeRejected(env, new Date(reviewed.getTime() + (REJECTED_KEEP_DAYS + 1) * 86400_000)), 1);
  assert.equal(PENDING.m.size, 0);
  assert.equal(row.files, "[]");
  await assert.rejects(undo(env, row), Rejected);
  assert.equal(row.status, "rejected");
});
