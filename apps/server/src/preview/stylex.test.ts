import fs from "node:fs";
import path from "node:path";
import type { Design, Previews } from "@finite/protocol";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { rev } from "../source/files.ts";
import { prepareFixture } from "./fixtures.ts";
import { createPreviews } from "./index.ts";

let previews: Previews;
let root: string;
let url: string;
let remove = () => {};

beforeAll(async () => {
  const fixture = await prepareFixture("stylex");
  root = fixture.root;
  remove = fixture.remove;
  previews = createPreviews({ host: "127.0.0.1", graceMs: 100 });
  const design: Design = {
    id: "stylex",
    name: "stylex",
    root,
    origin: "connected",
    router: "react-router",
    styling: "stylex",
    css: ["src/index.css"],
    brandDir: "src/assets/brand",
  };
  url = (await previews.ensure(design)).url;
}, 240_000);

afterAll(async () => {
  await previews?.close();
  remove();
});

async function get(pathname: string, accept = "*/*") {
  const response = await fetch(`${url}${pathname}`, { headers: { accept } });
  return response.text();
}

describe("a StyleX project's preview", () => {
  test("stamps the file as it is on disk, before StyleX compiles it", async () => {
    for (const [file, loc] of [
      ["src/components/Card.tsx", "27:4"],
      [".finite/boards/demo/Hero.tsx", "16:4"],
    ]) {
      const module = await get(`/${file}`);
      const onDisk = fs.readFileSync(path.join(root, file), "utf8");
      expect(module).toContain(`"data-finite-loc": "${file}:${loc}"`);
      expect(module).toContain(`"data-finite-rev": "${rev(onDisk)}"`);
      // StyleX compiled `create` away into class names.
      expect(module).not.toContain("stylex.create(");
    }
    const css = await get("/virtual:stylex.css", "text/css");
    expect(css).toContain("padding: 16px");
    expect(css).toContain("padding: 32px");
  });

  test("gives file frames StyleX's stylesheet", async () => {
    const frame = await get("/__finite/frame?file=.finite/boards/demo/Hero.tsx", "text/html");
    expect(frame).toContain(`href="/virtual:stylex.css"`);
    expect(frame).toContain("virtual:stylex:runtime");
  });
});
