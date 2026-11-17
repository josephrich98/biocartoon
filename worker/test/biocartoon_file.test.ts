import { test } from "node:test";
import assert from "node:assert/strict";
import { attachment, templateToBiocartoon } from "../src/biocartoon_file.ts";

const asset = (key: string) => ({ id: key, key, title: "pic", source: "template", credit: "c", license: "CC0-1.0" });
const item = (id: number, key: string) => ({ id, name: "pic", kind: { Image: { source: { Asset: asset(key) }, crop: [0, 0, 1, 1] } }, group: null });
const doc = {
  meta: { id: "pathway-ab12", title: "Pathway" },
  width: 960,
  height: 672,
  background: [255, 255, 255, 255],
  slide: {
    name: "Pathway",
    items: [item(3, "templates/pathway-ab12/img-1.png"), item(7, "user/cell-x.png"), item(4, "templates/pathway-ab12/img-1.png")],
    comments: [{ id: 9 }],
  },
};

test("a template becomes a .biocartoon document with its own images bundled", () => {
  const f = JSON.parse(templateToBiocartoon(doc, new Map([["img-1.png", new Uint8Array([1, 2, 3])]])));
  assert.equal(f.title, "Pathway");
  assert.deepEqual([f.width, f.height, f.unit, f.next_id], [960, 672, "Inch", 10]);
  assert.equal(f.slides.length, 1);
  const [own, lib, again] = f.slides[0].items.map((i: any) => i.kind.Image.source);
  assert.deepEqual(own, { File: { path: "img-1.png", from: { Asset: asset("templates/pathway-ab12/img-1.png") } } });
  assert.deepEqual(again, own);
  assert.deepEqual(lib, { Asset: asset("user/cell-x.png") });
  assert.deepEqual(f.images, { "img-1.png": "AQID" });
  assert.equal(f.meta, undefined);
  // The stored template is left as it was.
  assert.equal((doc.slide.items[0].kind.Image.source as any).Asset.key, "templates/pathway-ab12/img-1.png");
});

test("a template without its own images has no images map; a missing image is an error", () => {
  const plain = { ...doc, slide: { name: "x", items: [item(1, "user/cell-x.png")] } };
  assert.equal(JSON.parse(templateToBiocartoon(plain, new Map())).images, undefined);
  assert.throws(() => templateToBiocartoon(doc, new Map()), /img-1.png is missing/);
});

test("download file names", () => {
  assert.equal(attachment("Cell / membrane", ".svg"), `attachment; filename="Cell membrane.svg"; filename*=UTF-8''Cell%20membrane.svg`);
  assert.equal(attachment("Zellkern \"µ\"", ".png"), `attachment; filename="Zellkern .png"; filename*=UTF-8''Zellkern%20%C2%B5.png`);
  assert.equal(attachment("  ", ".biocartoon"), `attachment; filename="download.biocartoon"; filename*=UTF-8''download.biocartoon`);
});
