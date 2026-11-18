import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const result = await build({
  entryPoints: [new URL("src/gallery.ts", import.meta.url).pathname],
  bundle: true, minify: true, format: "esm", platform: "browser", target: "es2022", write: false,
});
const template = await readFile(new URL("src/gallery.html", import.meta.url), "utf8");
const script = result.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
await mkdir(new URL("dist/", import.meta.url), { recursive: true });
await writeFile(new URL("dist/gallery.html", import.meta.url), template.replace("<!-- gallery-script -->", () => `<script type="module">${script}</script>`));
