import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { designOf, get, previewHarness } from "./harness.ts";

const { previews, prepare } = previewHarness();

describe("Next.js on webpack", () => {
  test("runs a Pages Router project on webpack when its dev script says --webpack", async () => {
    const fixture = await prepare("next-pages");
    const pkg = path.join(fixture.root, "package.json");
    fs.writeFileSync(
      pkg,
      fs.readFileSync(pkg, "utf8").replace(`"next dev"`, `"next dev --webpack"`),
    );
    const copy = { ...designOf("next-pages", fixture.root), id: "next-pages-webpack" };
    const { url } = await previews.ensure(copy);
    const page = await get(`${url}/posts/7`);
    expect(page.status).toBe(200);
    // webpack's dev runtime, which Turbopack doesn't serve.
    expect(page.text).toContain("/_next/static/chunks/webpack.js");
    expect(page.text).toContain(`data-finite-loc="src/pages/posts/[id].tsx:8:6"`);
    const frame = await get(`${url}/__finite/frame?file=src%2Fpages%2Fabout.tsx`);
    expect(frame.status).toBe(200);
    expect(frame.text).toContain(`id="finite-page"`);
    await previews.stop(copy.id);
  }, 120_000);

  test("runs a project on webpack when its config has webpack() and no turbopack", async () => {
    const fixture = await prepare("next-webpack");
    const pkg = path.join(fixture.root, "package.json");
    fs.writeFileSync(
      pkg,
      fs.readFileSync(pkg, "utf8").replace(`"next dev --webpack"`, `"next dev"`),
    );
    const copy = { ...designOf("next-webpack", fixture.root), id: "next-webpack-config" };
    const { url } = await previews.ensure(copy);
    expect((await get(`${url}/`)).text).toContain("Built with <!-- -->webpack");
    await previews.stop(copy.id);
  }, 120_000);
});
