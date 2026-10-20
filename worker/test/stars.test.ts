import { test } from "node:test";
import assert from "node:assert/strict";
import { parseIds, validClient, validId } from "../src/stars.ts";
import { MAX_STAR_IDS } from "../src/limits.ts";

test("catalog ids are accepted, junk is not", () => {
  for (const id of ["bioart/2_626557", "bioicons/bsd/Machine_Learning/PyTorch", "openmoji/1F600", "user/t-cell-0a1b2c3d4e", "servier/8-well-pcr-tube-strip"]) {
    assert.ok(validId(id), id);
  }
  for (const id of ["", "bioart", "/bioart/1", "bioart//1", "bioart/../x", "bioart/1/", "bioart/a b", "bioart/1.png?x=1", "x".repeat(201), 5, null]) {
    assert.equal(validId(id), false, String(id));
  }
});

test("client ids are lowercase hex", () => {
  assert.ok(validClient("0123456789abcdef0123456789abcdef"));
  assert.equal(validClient("0123456789ABCDEF0123456789ABCDEF"), false);
  assert.equal(validClient("abc"), false);
  assert.equal(validClient(undefined), false);
});

test("id lists are deduplicated, cleaned and capped", () => {
  assert.deepEqual(parseIds("bioart/1,bioart/1,bad id,servier/x"), ["bioart/1", "servier/x"]);
  assert.deepEqual(parseIds(null), []);
  const many = Array.from({ length: MAX_STAR_IDS + 10 }, (_, i) => `bioart/${i}`).join(",");
  assert.equal(parseIds(many).length, MAX_STAR_IDS);
});
