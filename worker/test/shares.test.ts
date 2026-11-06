import { test } from "node:test";
import assert from "node:assert/strict";
import { expired, expiresAt, validSecret, validShareId, versionsToDrop } from "../src/shares.ts";
import { MAX_SHARE_VERSIONS, SHARE_IDLE_DAYS } from "../src/limits.ts";

test("share ids are 22 base64url characters", () => {
  assert.ok(validShareId("AbC-_0123456789abcdefg"));
  for (const bad of ["", "AbC-_0123456789abcdef", "AbC-_0123456789abcdefgh", "AbC+/0123456789abcdefg", "../../users/x/projects"]) assert.equal(validShareId(bad), false, bad);
});

test("secrets are long base64url strings", () => {
  assert.ok(validSecret("a".repeat(22)));
  assert.ok(validSecret("Zz-_".repeat(16)));
  for (const bad of [null, "", "a".repeat(21), "a".repeat(65), `${"a".repeat(21)}=`]) assert.equal(validSecret(bad), false, String(bad));
});

test("idle shares expire after SHARE_IDLE_DAYS", () => {
  const used = "2026-01-01T00:00:00Z";
  const day = 86_400_000;
  assert.equal(expiresAt(used), new Date(Date.parse(used) + SHARE_IDLE_DAYS * day).toISOString().replace(/\.\d+Z$/, "Z"));
  assert.equal(expired(used, Date.parse(used) + (SHARE_IDLE_DAYS - 1) * day), false);
  assert.equal(expired(used, Date.parse(used) + (SHARE_IDLE_DAYS + 1) * day), true);
});

test("only the newest versions are kept", () => {
  const kept = [1, 2, 3, 4, 5, 6];
  assert.deepEqual(versionsToDrop(kept, 6), kept.slice(0, kept.length - MAX_SHARE_VERSIONS));
  assert.deepEqual(versionsToDrop([1, 2], 2), []);
  assert.equal(6 - versionsToDrop(kept, 6).length, MAX_SHARE_VERSIONS);
});
