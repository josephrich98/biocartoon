import { test } from "node:test";
import assert from "node:assert/strict";
import { parseIds, validClient, validId } from "../src/stars.ts";
import { MAX_STAR_IDS } from "../src/limits.ts";

test("catalog ids are accepted, junk is not", () => {
  for (const id of ["BA000001", "BI004816", "OM013699", "UG020071", "BC020061", "SV1234567"]) {
    assert.ok(validId(id), id);
  }
  for (const id of ["", "BA", "BA12345", "ba000001", "XX000001", "US020061", "BA000001 ", "BA0000001234", "bioart/2_626557", "user/t-cell-0a1b2c3d4e", 5, null]) {
    assert.equal(validId(id), false, String(id));
  }
});

test("template ids are accepted", () => {
  for (const id of ["eukaryotic-cell-5a1e09d5a6", "scrna-seq-workflow-965cc5021c", "item-0a1b2c3d4e"]) {
    assert.ok(validId(id), id);
  }
  for (const id of ["eukaryotic-cell", "Eukaryotic-cell-5a1e09d5a6", "-cell-5a1e09d5a6", "cell-5A1E09D5A6", "cell-5a1e09d5a", "templates/cell-5a1e09d5a6"]) {
    assert.equal(validId(id), false, id);
  }
});

test("client ids are lowercase hex", () => {
  assert.ok(validClient("0123456789abcdef0123456789abcdef"));
  assert.equal(validClient("0123456789ABCDEF0123456789ABCDEF"), false);
  assert.equal(validClient("abc"), false);
  assert.equal(validClient(undefined), false);
});

test("id lists are deduplicated, cleaned and capped", () => {
  assert.deepEqual(parseIds("BA000001,BA000001,bad id,SV017041"), ["BA000001", "SV017041"]);
  assert.deepEqual(parseIds(null), []);
  const many = Array.from({ length: MAX_STAR_IDS + 10 }, (_, i) => `BA${String(i).padStart(6, "0")}`).join(",");
  assert.equal(parseIds(many).length, MAX_STAR_IDS);
});
