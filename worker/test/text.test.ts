import { test } from "node:test";
import assert from "node:assert/strict";
import { profanity, clean, newId, checkLanguage, Rejected } from "../src/text.ts";

test("scientific vocabulary passes", () => {
  const ok = `penis vagina vulva testis scrotum anus anal rectum breast nipple sperm semen ejaculation erection
    uterus orgasm sexual intercourse sex cumulative titration assay cocci bacteria analysis analgesic cocktail
    Dickinson Hancock shiitake cumin cucumber flame-retardant retardation Uranus spermatogenesis homozygous
    phagocytosis peacock cockroach titmouse great tit Beta cell; T cell activation pathway`;
  for (const w of ok.split(/[\s;]+/)) assert.equal(profanity(w), null, w);
  assert.equal(profanity(ok), null);
});

test("profanity is caught, including obfuscated", () => {
  for (const s of ["shit", "sh1t", "a sh!t cell", "fuuuuck", "motherf*cker", "Cunt cell", "retard", "bitch"]) {
    assert.notEqual(profanity(s), null, s);
  }
});

test("clean trims and limits", () => {
  assert.equal(clean("  a\n\tb  ", 10, "x"), "a b");
  assert.throws(() => clean("", 10, "Title", true), Rejected);
  assert.throws(() => clean("x".repeat(11), 10, "Title"), /longer/);
  assert.throws(() => checkLanguage(["fine", "shit"]), /language/);
});

test("ids are slug-safe", () => {
  assert.match(newId("T cell: activation!"), /^t-cell-activation-[0-9a-f]{10}$/);
  assert.match(newId("!!!"), /^item-[0-9a-f]{10}$/);
});
