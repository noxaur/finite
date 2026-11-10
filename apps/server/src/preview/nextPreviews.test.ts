import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { BRAND_BOARD, brandBoard } from "../store/brand.ts";
import { describeChrome } from "./fixtures.ts";
import { bridgeChrome, designOf, get, sharedPreviews } from "./harness.ts";

const NEXT_APPS = ["next-app", "next-webpack"] as const;

const { previews, roots, urls } = sharedPreviews(["next-app", "next-pages", "next-webpack"]);

describe("Next.js previews", () => {
  test("lists App Router and Pages Router routes, but not Finite's frame route", async () => {
    expect(await previews.routes("next-app")).toEqual([
      { path: "/", params: [], file: "app/page.tsx" },
      { path: "/pricing", params: [], file: "app/(marketing)/pricing/page.tsx" },
      { path: "/about", params: [], file: "app/about/page.tsx" },
      { path: "/blog/[slug]", params: ["slug"], file: "app/blog/[slug]/page.tsx" },
      { path: "/docs/[...slug]", params: ["slug"], file: "app/docs/[...slug]/page.tsx" },
      { path: "/shop/[[...slug]]", params: ["slug"], file: "app/shop/[[...slug]]/page.tsx" },
    ]);
    expect(await previews.routes("next-pages")).toEqual([
      { path: "/about", params: [], file: "src/pages/about.tsx" },
      { path: "/", params: [], file: "src/pages/index.tsx" },
      { path: "/posts/[id]", params: ["id"], file: "src/pages/posts/[id].tsx" },
    ]);
  }, 120_000);

  test("serves route pages with the bridge, stamped on the server and the client", async () => {
    const app = await get(previews.frameUrl("next-app", { kind: "route", path: "/about" }));
    expect(app.status).toBe(200);
    expect(app.text.match(/\/__finite\/bridge\.js/g)).toHaveLength(1);
    expect(app.text).toMatch(
      /<h1 data-finite-loc="app\/about\/page\.tsx:4:6" data-finite-rev="[0-9a-f]{8}"/,
    );
    const pages = await get(
      previews.frameUrl("next-pages", { kind: "route", path: "/posts/[id]", params: { id: "7" } }),
    );
    expect(pages.status).toBe(200);
    expect(pages.text).toContain(`<script type="module" src="/__finite/bridge.js"></script>`);
    expect(pages.text).toContain(`data-finite-loc="src/pages/posts/[id].tsx:8:6"`);
    // The project's Tailwind sheet is swapped for Finite's copy, which adds .finite/ as a source.
    expect(app.text).toContain("_finite_runtime_css_app_globals");
  }, 120_000);

  test("runs a project that needs webpack on webpack, with its own webpack config", async () => {
    const page = await get(previews.frameUrl("next-webpack", { kind: "route", path: "/" }));
    expect(page.status).toBe(200);
    expect(page.text.match(/\/__finite\/bridge\.js/g)).toHaveLength(1);
    // The fixture's webpack() defines __BUNDLER__, which Turbopack would leave undefined.
    expect(page.text).toContain("Built with <!-- -->webpack");
    expect(page.text).toMatch(
      /<h1 data-finite-loc="app\/page\.tsx:9:6" data-finite-rev="[0-9a-f]{8}"/,
    );
    expect(page.text).toContain(`<button data-finite-loc="app/_components/Counter.tsx:8:4"`);
  }, 120_000);

  test.each(NEXT_APPS)(
    "renders a prototype file frame with classes used only in .finite/ (%s)",
    async (name) => {
      fs.mkdirSync(path.join(roots[name], ".finite/boards/demo"), { recursive: true });
      fs.writeFileSync(
        path.join(roots[name], ".finite/boards/demo/Hero.tsx"),
        `export default () => <section className="bg-[#0a7f3e] p-[13px]">Hero</section>;\n`,
      );
      const page = await get(
        previews.frameUrl(name, { kind: "file", file: ".finite/boards/demo/Hero.tsx" }),
      );
      expect(page.status).toBe(200);
      expect(page.text).toContain(`id="finite-page"`);
      expect(page.text).toMatch(
        /<section data-finite-loc="\.finite\/boards\/demo\/Hero\.tsx:1:21"/,
      );
      // Turbopack names the sheet after Finite's copy, webpack after the layout that imports it.
      const sheets = [...page.text.matchAll(/<link rel="stylesheet" href="([^"]+\.css[^"]*)"/g)];
      const css = await Promise.all(sheets.map(([, href]) => get(urls[name] + href, "text/css")));
      expect(css.map((sheet) => sheet.text).join("\n")).toContain("bg-\\[\\#0a7f3e\\]");
      expect(fs.readFileSync(path.join(roots[name], "app/globals.css"), "utf8")).not.toContain(
        "@source",
      );
    },
    180_000,
  );

  test.each(NEXT_APPS)(
    "renders the brand board without Vite's import.meta.glob (%s)",
    async (name) => {
      // The fixture's design.json puts the brand folder in assets/brand.
      const root = roots[name];
      fs.mkdirSync(path.join(root, "assets/brand"), { recursive: true });
      fs.writeFileSync(
        path.join(root, "assets/brand/logo.svg"),
        `<svg xmlns="http://www.w3.org/2000/svg"/>`,
      );
      fs.mkdirSync(path.join(root, path.dirname(BRAND_BOARD)), { recursive: true });
      fs.writeFileSync(path.join(root, BRAND_BOARD), brandBoard(designOf(name, roots[name])));
      await expect
        .poll(() => fs.readFileSync(path.join(root, ".finite/runtime/brand.ts"), "utf8"), {
          timeout: 10_000,
        })
        .toContain("logo.svg");
      const page = await get(previews.frameUrl(name, { kind: "file", file: BRAND_BOARD }));
      expect(page.status).toBe(200);
      expect(page.text).toContain(`src="/__finite/asset?file=assets%2Fbrand%2Flogo.svg"`);
      expect(page.text).toContain("--color-brand");
      const logo = await fetch(`${urls[name]}/__finite/asset?file=assets/brand/logo.svg`);
      expect(logo.headers.get("content-type")).toBe("image/svg+xml");
      expect(await logo.text()).toContain("<svg");
      const outside = await fetch(`${urls[name]}/__finite/asset?file=app/page.tsx`);
      expect(outside.status).toBe(404);
    },
    30_000,
  );

  test("follows brand assets added on their own, and dropped when the brand folder is renamed away", async () => {
    // Only an image, once the preview's own writes have settled, so no source change syncs too.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const root = roots["next-app"];
    const runtime = () => fs.readFileSync(path.join(root, ".finite/runtime/brand.ts"), "utf8");
    fs.mkdirSync(path.join(root, "assets/brand"), { recursive: true });
    fs.writeFileSync(path.join(root, "assets/brand/mark.png"), Buffer.from([0x89, 0x50]));
    await expect.poll(runtime, { timeout: 10_000 }).toContain("mark.png");
    // The watcher reports the folder itself, not the files that moved with it.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    fs.renameSync(path.join(root, "assets/brand"), path.join(root, "assets/brand-old"));
    try {
      await expect.poll(runtime, { timeout: 10_000 }).not.toContain("mark.png");
    } finally {
      fs.renameSync(path.join(root, "assets/brand-old"), path.join(root, "assets/brand"));
    }
  }, 30_000);
  test("refuses a frame file outside the design, and never imports one it wasn't given", async () => {
    const page = await get(`${urls["next-pages"]}/__finite/frame?file=../../etc/passwd`);
    expect(page.status).toBe(400);
    expect(page.text).toContain("outside the design folder");
  });

  test("answers cross-origin requests only from the Finite shell's hosts", async () => {
    const origin = async (from: string) => {
      const response = await fetch(`${urls["next-app"]}/__finite/routes`, {
        headers: { origin: from },
      });
      await response.body?.cancel();
      return response.headers.get("access-control-allow-origin");
    };
    expect(await origin("http://localhost:3000")).toBe("http://localhost:3000");
    expect(await origin("https://evil.example")).toBeNull();
  });
});

describeChrome("bridge in Chrome on Next.js", () => {
  const { open, ask, bridgeEvents } = bridgeChrome();

  test.each([
    ["next-app", "app/page.tsx:7:6"],
    ["next-webpack", "app/page.tsx:9:6"],
  ] as const)(
    "hit, HMR and file frames on Next.js (%s)",
    async (name, headingLoc) => {
      const { page, frame } = await open(`${urls[name]}/`, "h1[data-finite-loc]");
      const heading = await frame.$eval("h1", (h) => {
        const r = h.getBoundingClientRect();
        return { x: r.x + 4, y: r.y + 4, rev: h.getAttribute("data-finite-rev") };
      });
      const hit = await ask(page, "hit", { x: heading.x, y: heading.y });
      expect(hit.value).toMatchObject({ loc: headingLoc, tag: "h1" });
      // A client component is stamped too.
      expect(await frame.$eval("button", (b) => b.getAttribute("data-finite-loc"))).toBe(
        "app/_components/Counter.tsx:8:4",
      );

      // Edit only after React hydrated the page, or the new HTML fails hydration.
      await expect
        .poll(() =>
          frame.$eval("h1", (h) => Object.keys(h).some((key) => key.startsWith("__reactFiber$"))),
        )
        .toBe(true);
      const updates = () =>
        bridgeEvents(page).then((list) => list.filter((e) => e.type === "updated").length);
      const before = await updates();
      const home = path.join(roots[name], "app/page.tsx");
      fs.writeFileSync(home, fs.readFileSync(home, "utf8").replace(">Home<", ">Welcome<"));
      await expect
        .poll(() => frame.$eval("h1", (h) => h.textContent), { timeout: 15_000 })
        .toBe("Welcome");
      await expect.poll(updates).toBeGreaterThan(before);
      expect(await frame.$eval("h1", (h) => h.getAttribute("data-finite-rev"))).not.toBe(
        heading.rev,
      );
      expect((await bridgeEvents(page)).filter((e) => e.type === "error")).toEqual([]);
      await page.close();

      for (const [fixture, file, exportName, selector] of [
        [name, "app/_components/Counter.tsx", "Counter", "button[data-finite-loc]"],
        ["next-pages", "src/pages/about.tsx", undefined, "h1[data-finite-loc]"],
      ] as const) {
        const src = previews.frameUrl(fixture, {
          kind: "file",
          file,
          ...(exportName && { exportName }),
        });
        const opened = await open(src, selector);
        const errors = (await bridgeEvents(opened.page)).filter((e) => e.type === "error");
        expect(errors, src).toEqual([]);
        await opened.page.close();
      }
    },
    180_000,
  );
});
