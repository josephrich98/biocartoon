import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const result = await build({
  entryPoints: [new URL("src/gallery.ts", import.meta.url).pathname],
  bundle: true, minify: true, format: "esm", platform: "browser", target: "es2022", write: false,
});
const template = await readFile(new URL("src/gallery.html", import.meta.url), "utf8");
const script = result.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
// The palette logo, inline (no image request), sized for the header.
const logo = (await readFile(new URL("../../brand/logo.svg", import.meta.url), "utf8"))
  .replace(/<\?xml[^>]*\?>/, "").replace(/<!--[\s\S]*?-->/g, "").replace(/\s(?:xmlns|sodipodi|inkscape):?[\w-]*(?::[\w-]+)?="[^"]*"/g, m => m.startsWith(' xmlns="') ? m : "")
  .replace(/<(sodipodi|inkscape):[\s\S]*?(?:\/>|<\/\1:[\w-]+>)/g, "").replace(/<svg\b/, '<svg aria-hidden="true" focusable="false"').replace(/\s(width|height)="\d+"/g, "").replace(/<title[\s\S]*?<\/title>|<desc[\s\S]*?<\/desc>/g, "").replace(/\s(role|aria-labelledby)="[^"]*"/g, "").replace(/>\s+</g, "><").trim();
await mkdir(new URL("dist/", import.meta.url), { recursive: true });
await writeFile(new URL("dist/gallery.html", import.meta.url), template.replace("<!-- logo -->", () => logo).replace("<!-- gallery-script -->", () => `<script type="module">${script}</script>`));
