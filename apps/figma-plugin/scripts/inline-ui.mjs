// Puts the bundled UI script into the UI page. Figma loads `ui` from the
// manifest as one HTML string and has no way to fetch a second file.

import { readFile, rm, writeFile } from "node:fs/promises";

const page = await readFile(new URL("../src/ui.html", import.meta.url), "utf8");
const scriptUrl = new URL("../dist/ui.js", import.meta.url);
const script = await readFile(scriptUrl, "utf8");

const marker = /<script>[\s\S]*?<\/script>/;
if (!marker.test(page)) throw new Error("src/ui.html has no <script> to fill");
// A `</script` in the bundle would end the tag early.
const safe = script.replace(/<\/script/gi, "<\\/script");
await writeFile(
  new URL("../dist/ui.html", import.meta.url),
  page.replace(marker, () => `<script>\n${safe}</script>`),
);
await rm(scriptUrl);
