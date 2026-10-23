import { test } from "node:test";
import assert from "node:assert/strict";
import { checkSvg, checkTemplate, creditLine, parseEmail, parseMeta, parseSuggestion, pngSize } from "../src/validate.ts";

const png = (w: number, h: number) => {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82]);
  new DataView(b.buffer).setUint32(16, w);
  new DataView(b.buffer).setUint32(20, h);
  return b;
};
const meta = { title: "Pathway", description: "", category: "", author: "ann", license: "CC0-1.0" };
const img = (key: string) => ({ name: "pic", kind: { Image: { source: { Asset: { id: key, key, title: "pic", source: "x" } }, crop: [0, 0, 1, 1], overlay: [0, 0, 0, 0] } } });
const text = (t: string) => ({ name: "Title", kind: { Text: { text: t, size: 12, color: [0, 0, 0, 255], align: "Left", bold: false } } });
const tmpl = (items: unknown[]) => ({ meta: {}, width: 960, height: 672, background: [255, 255, 255, 255], slide: { name: "x", items } });

test("png checks", () => {
  assert.deepEqual(pngSize(png(10, 20)), { width: 10, height: 20 });
  assert.throws(() => pngSize(png(5000, 10)), /4096/);
  assert.throws(() => pngSize(new TextEncoder().encode("GIF89a.....................")), /PNG/);
});

const svg = (body: string, head = "") => new TextEncoder().encode(`${head}<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">${body}</svg>`);

test("svg checks", () => {
  const ok = [
    '<path d="M0 0h10v10z" fill="url(#g)" style="fill:#fff"/>',
    '<defs><linearGradient id="g"/></defs><use href="#g"/><use xlink:href="#g" xmlns:xlink="http://www.w3.org/1999/xlink"/>',
    '<style><![CDATA[.a{fill:url(#g)}]]></style><style>.b{stroke:red}</style>',
    '<image href="data:image/png;base64,iVBORw0KGgo="/><a href="#x"><text>A &amp; B &#956;m</text></a>',
    '<!-- note --><sodipodi:namedview xmlns:sodipodi="x" inkscape:export-filename="C:\\Users\\a.png"/>',
  ];
  for (const b of ok) checkSvg(svg(b));
  checkSvg(svg("", '<?xml version="1.0" encoding="UTF-8"?>\n'));
  checkSvg(svg('<g inkscape:export-only_selected="false"/>', '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n'));
  const bad: [string, RegExp][] = [
    ["<script>alert(1)</script>", /script/],
    ["<SCRIPT>alert(1)</SCRIPT>", /script/],
    ['<x:script xmlns:x="http://www.w3.org/2000/svg">1</x:script>', /script/],
    ["<foreignObject><div/></foreignObject>", /foreignobject/],
    ['<g xmlns="http://www.w3.org/1999/xhtml"/>', /HTML/],
    ['<rect onload="alert(1)"/>', /event handlers/],
    ['<rect ONclick="x"/>', /event handlers/],
    ['<a href="javascript:alert(1)"/>', /links/],
    ['<a href="&#x6A;avascript:alert(1)"/>', /links/],
    ['<image href="https://evil.example/x.png"/>', /links/],
    ['<use href="other.svg#a"/>', /links/],
    ['<image href="data:image/svg+xml;base64,PHN2Zz4="/>', /links/],
    ['<rect style="fill:url(https://e.example/a)"/>', /CSS/],
    ['<rect fill="url( \'http://e.example/a\' )"/>', /CSS/],
    ['<rect style="fill:u\\72l(http://e)"/>', /CSS/],
    ["<style>@import 'http://e.example/a.css';</style>", /CSS/],
    ["<style><![CDATA[.a{background:url(http://e)}]]></style>", /CSS/],
    ['<animate attributeName="href" to="javascript:alert(1)"/>', /animate/],
    ["<set/>", /set/],
    ["<g>", /well-formed/],
    ["<g></rect>", /well-formed/],
    ["<rect width=10/>", /well-formed/],
    ["<text>a & b</text>", /well-formed/],
    ["<text>&foo;</text>", /well-formed/],
    ["<text>&constructor;</text>", /well-formed/],
    ["<text>&#x110000;</text>", /well-formed/],
  ];
  for (const [b, re] of bad) assert.throws(() => checkSvg(svg(b)), re, b);
  assert.throws(() => checkSvg(svg("", '<!DOCTYPE svg [<!ENTITY a "b">]>')), /entity/);
  assert.throws(() => checkSvg(svg("", '<!DOCTYPE svg PUBLIC "a" "b" [<!ENTITY a "b">]>')), /entity/);
  assert.throws(() => checkSvg(svg("", '<!DOCTYPE svg SYSTEM "http://e.example/x.dtd">')), /entity/);
  assert.throws(() => checkSvg(svg("<!DOCTYPE svg>")), /entity/);
  assert.throws(() => checkSvg(svg("", '<?xml-stylesheet href="http://e.example/a.css"?>')), /processing/);
  assert.throws(() => checkSvg(new TextEncoder().encode("<html><body/></html>")), /root element/);
  assert.throws(() => checkSvg(new TextEncoder().encode("<svg/><svg/>")), /root element/);
  assert.throws(() => checkSvg(new TextEncoder().encode("<svg/>trailing")), /well-formed/);
  assert.throws(() => checkSvg(new Uint8Array([0x3c, 0x73, 0x76, 0x67, 0xff, 0x2f, 0x3e])), /UTF-8/);
  assert.throws(() => checkSvg(new Uint8Array(3 * 1024 * 1024)), /2 MB/);
});

test("meta checks", () => {
  assert.equal(parseMeta({ title: " T cell ", license: "CC0-1.0" }).author, "anonymous");
  assert.throws(() => parseMeta({ title: "x", license: "All rights reserved" }), /License/);
  assert.throws(() => parseMeta({ title: "shit cell", license: "CC0-1.0" }), /language/);
  assert.throws(() => parseMeta({ title: "ok", author: "f*ck", license: "CC0-1.0" }), /language/);
  assert.throws(() => parseMeta({ title: "ok", license: "CC-BY-4.0" }), /credit name/);
  assert.equal(parseMeta({ title: "ok", author: "Ann", license: "CC-BY-4.0" }).author, "Ann");
  assert.throws(() => parseMeta({ title: "ok", author: "BioCartoon team", license: "CC0-1.0" }), /BioCartoon/);
});

test("emails", () => {
  assert.equal(parseEmail(undefined), "");
  assert.equal(parseEmail("a.b+c@lab.example.org"), "a.b+c@lab.example.org");
  for (const bad of ["ann", "ann@lab", "@lab.org", "ann@@lab.org", "a b@lab.org", "ann@.org", "ann@lab."]) assert.throws(() => parseEmail(bad), /email/, bad);
});

test("credit lines", () => {
  assert.equal(creditLine("Cell", "Ann", "CC-BY-4.0"), '"Cell" by Ann, BioCartoon community contribution, CC-BY-4.0 (https://creativecommons.org/licenses/by/4.0/)');
  assert.equal(creditLine("Cell", "anonymous", "CC0-1.0"), '"Cell", BioCartoon community contribution, CC0');
});

test("template images are re-keyed and references collected", () => {
  const t = checkTemplate(tmpl([text("Step 1"), img("img-1.png"), img("bioart/a.png")]), "path-1", meta, new Set(["img-1.png"]), "now");
  const items = (t.doc.slide as any).items;
  assert.equal(items[1].kind.Image.source.Asset.key, "templates/path-1/img-1.png");
  assert.deepEqual(t.references, ["bioart/a.png"]);
  assert.deepEqual(t.images, ["img-1.png"]);
  assert.equal((t.doc.meta as any).thumb_key, "templates/path-1/thumb.png");
  assert.ok(t.texts.includes("Step 1"));
  assert.equal(items[1].kind.Image.source.Asset.credit, '"pic" by ann, template "Pathway", CC0');
  assert.equal(items[1].kind.Image.source.Asset.license, "CC0-1.0");
});

test("template rejections", () => {
  const ok = new Set<string>();
  const local = { name: "f", kind: { Image: { source: { File: { path: "/etc/passwd" } } } } };
  assert.throws(() => checkTemplate(tmpl([local]), "a", meta, ok, ""), /uploaded/);
  assert.throws(() => checkTemplate(tmpl([text("what the fuck")]), "a", meta, ok, ""), /language/);
  assert.throws(() => checkTemplate(tmpl([img("img-2.png")]), "a", meta, ok, ""), /missing/);
  assert.throws(() => checkTemplate(tmpl([text("x")]), "a", meta, new Set(["img-1.png"]), ""), /not used/);
  assert.throws(() => checkTemplate(tmpl([img("../secret.png")]), "a", meta, ok, ""), /reference/);
  assert.throws(() => checkTemplate(tmpl([img("catalog/assets.png")]), "a", meta, ok, ""), /reference/);
  assert.throws(() => checkTemplate(tmpl(Array(301).fill(text("x"))), "a", meta, ok, ""), /300/);
  assert.throws(() => checkTemplate(tmpl([{ kind: { Script: {} } }]), "a", meta, ok, ""), /invalid/);
});

test("suggestions are checked", () => {
  assert.deepEqual(parseSuggestion({ kind: "icon", title: " T  cell ", description: "", name: "" }), { kind: "icon", title: "T cell", description: "", name: "", email: "" });
  assert.equal(parseSuggestion({ kind: "other", title: "Dark mode", email: " ann@lab.org " }).email, "ann@lab.org");
  assert.throws(() => parseSuggestion({ kind: "other", title: "x", email: "ann" }), /email/);
  assert.throws(() => parseSuggestion({ kind: "asset", title: "x" }), /kind/);
  assert.throws(() => parseSuggestion({ kind: "template", title: "" }), /Title/);
  assert.throws(() => parseSuggestion({ kind: "icon", title: "shit cell" }), /language/);
});
