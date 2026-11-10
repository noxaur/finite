import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { designOf, get, previewHarness } from "./harness.ts";

const { previews, prepare } = previewHarness();

describe("Next.js previews follow the project's config", () => {
  test("follows a Next.js project's pageExtensions and basePath, and renders frames with output: export", async () => {
    const fixture = await prepare("next-pages");
    const at = (file: string) => path.join(fixture.root, file);
    fs.writeFileSync(
      at("next.config.ts"),
      fs
        .readFileSync(at("next.config.ts"), "utf8")
        .replace(
          "{}",
          `{ output: "export", basePath: "/docs", pageExtensions: ["page.tsx", "mdx"] }`,
        ),
    );
    for (const page of ["_app", "_document", "about", "index", "posts/[id]"]) {
      fs.renameSync(at(`src/pages/${page}.tsx`), at(`src/pages/${page}.page.tsx`));
    }
    // Not a page with these pageExtensions, so not a route either.
    fs.writeFileSync(
      at("src/pages/posts/Card.tsx"),
      "export function Card() {\n  return <p>Card</p>;\n}\n",
    );
    const copy = { ...designOf("next-pages", fixture.root), id: "next-settings" };
    const seen: string[][] = [];
    const off = previews.on(copy.id, (e) => {
      if (e.type === "routes") seen.push(e.routes.map((r) => r.path));
    });
    const { url } = await previews.ensure(copy);
    expect(url).toMatch(/:\d+\/docs$/);
    expect(fs.existsSync(at("src/pages/__finite/frame.page.tsx"))).toBe(true);
    expect(await previews.routes(copy.id)).toEqual([
      { path: "/about", params: [], file: "src/pages/about.page.tsx" },
      { path: "/", params: [], file: "src/pages/index.page.tsx" },
      { path: "/posts/[id]", params: ["id"], file: "src/pages/posts/[id].page.tsx" },
    ]);

    const about = await get(previews.frameUrl(copy.id, { kind: "route", path: "/about" }));
    expect(about.status).toBe(200);
    expect(about.text).toContain(`<script type="module" src="/docs/__finite/bridge.js"></script>`);
    expect(about.text).toContain(`data-finite-loc="src/pages/about.page.tsx:6:6"`);
    expect((await get(previews.frameUrl(copy.id, { kind: "route", path: "/" }))).status).toBe(200);
    expect((await get(`${url}/__finite/bridge.js`, "*/*")).status).toBe(200);
    const card = await get(
      previews.frameUrl(copy.id, {
        kind: "file",
        file: "src/pages/posts/Card.tsx",
        exportName: "Card",
      }),
    );
    expect(card.status).toBe(200);
    expect(card.text).toContain(`id="finite-page"`);
    expect(card.text).toContain(`src="/docs/__finite/bridge.js"`);
    // A page with one of the config's own extensions refreshes the routes too.
    fs.writeFileSync(at("src/pages/guide.mdx"), "# Guide\n");
    await expect.poll(() => seen.at(-1), { timeout: 10_000 }).toContain("/guide");
    off();
    await previews.stop(copy.id);
    expect(fs.existsSync(at("src/pages/__finite"))).toBe(false);
  }, 120_000);

  test("serves an App Router project's frames and brand files under its basePath, with its own adapter running its modifyConfig too", async () => {
    const fixture = await prepare("next-app");
    const at = (file: string) => path.join(fixture.root, file);
    fs.writeFileSync(
      at("adapter.mjs"),
      `await Promise.resolve();
export default {
  name: "mine",
  modifyConfig: (config) => ({ ...config, distDir: "mine", env: { ...config.env, MINE: "ran" } }),
  onBuildComplete: () => {},
};\n`,
    );
    fs.writeFileSync(
      at("next.config.ts"),
      fs
        .readFileSync(at("next.config.ts"), "utf8")
        .replace("{}", `{ basePath: "/base", adapterPath: ${JSON.stringify(at("adapter.mjs"))} }`),
    );
    fs.writeFileSync(
      at("app/about/page.tsx"),
      "export default () => <h1>{process.env.MINE}</h1>;\n",
    );
    // The fixture's design.json puts the brand folder in assets/brand.
    fs.mkdirSync(at("assets/brand"), { recursive: true });
    fs.writeFileSync(at("assets/brand/logo.svg"), `<svg xmlns="http://www.w3.org/2000/svg"/>`);
    const copy = { ...designOf("next-app", fixture.root), id: "next-base" };
    const { url } = await previews.ensure(copy);
    expect(url).toMatch(/:\d+\/base$/);
    expect((await previews.routes(copy.id)).map((r) => r.path)).toContain("/about");

    const about = await get(previews.frameUrl(copy.id, { kind: "route", path: "/about" }));
    expect(about.status).toBe(200);
    expect(about.text).toContain(`src="/base/__finite/bridge.js"`);
    expect(about.text).toMatch(/<h1 data-finite-loc="app\/about\/page.tsx:[^"]*"[^>]*>ran<\/h1>/);
    expect(fs.existsSync(at("mine"))).toBe(false);
    expect(fs.existsSync(at(".finite/runtime/next"))).toBe(true);
    const counter = await get(
      previews.frameUrl(copy.id, {
        kind: "file",
        file: "app/_components/Counter.tsx",
        exportName: "Counter",
      }),
    );
    expect(counter.status).toBe(200);
    expect(counter.text).toContain(`data-finite-loc="app/_components/Counter.tsx`);
    // Outside the basePath, Finite's URLs are Next's 404s like any other.
    const origin = new URL(url).origin;
    expect((await get(`${origin}/__finite/routes`, "*/*")).status).toBe(404);

    const brand = fs.readFileSync(at(".finite/runtime/brand.ts"), "utf8");
    expect(brand).toContain(`"/base/__finite/asset?file=assets%2Fbrand%2Flogo.svg"`);
    const logo = await fetch(`${url}/__finite/asset?file=assets%2Fbrand%2Flogo.svg`);
    expect(logo.headers.get("content-type")).toBe("image/svg+xml");
    await logo.body?.cancel();
    await previews.stop(copy.id);
  }, 120_000);
});
