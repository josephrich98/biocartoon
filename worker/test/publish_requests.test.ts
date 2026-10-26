import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_MESSAGE_CHARS, authorized, parseFinish } from "../src/publish_requests.ts";

test("only the configured bearer token is accepted", async () => {
  assert.ok(await authorized("Bearer s3cret", "s3cret"));
  assert.equal(await authorized("Bearer wrong", "s3cret"), false);
  assert.equal(await authorized("s3cret", "s3cret"), false);
  assert.equal(await authorized(null, "s3cret"), false);
  // No secret configured: nothing gets in, not even an empty token.
  assert.equal(await authorized("Bearer ", undefined), false);
  assert.equal(await authorized("Bearer ", ""), false);
});

test("finish reports are checked and their output trimmed to the end", () => {
  assert.deepEqual(parseFinish({ ids: [3, 4], ok: true, message: "published" }), { ids: [3, 4], ok: true, message: "published" });
  assert.deepEqual(parseFinish({ ids: [1], ok: false }), { ids: [1], ok: false, message: "" });
  const long = parseFinish({ ids: [1], ok: true, message: "x".repeat(MAX_MESSAGE_CHARS) + "END" })!;
  assert.equal(long.message.length, MAX_MESSAGE_CHARS);
  assert.ok(long.message.endsWith("END"));
  for (const bad of [null, "x", { ids: "1", ok: true }, { ids: [1.5], ok: true }, { ids: [1], ok: "yes" }]) {
    assert.equal(parseFinish(bad), null, JSON.stringify(bad));
  }
});
