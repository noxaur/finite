/// <reference lib="dom" />
// The DOM types are for the code these tests run in Chrome.

import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import type { Design, LayerNode, PreviewEvent, Previews } from "@finite/protocol";
import { getChromePath } from "chrome-launcher";
import puppeteer, { type Browser, type Frame, type Page } from "puppeteer-core";
import { afterAll, beforeAll, describe, expect, test, vi } from "vite-plus/test";
import { BRAND_BOARD, brandBoard } from "../store/brand.ts";
import { prepareFixture } from "./fixtures.ts";
import { createPreviews } from "./index.ts";

const FIXTURES = [
  "rr-spa",
  "rr-framework",
  "tanstack",
  "next-app",
  "next-pages",
  "next-webpack",
] as const;
type FixtureName = (typeof FIXTURES)[number];

let previews: Previews;
const roots = {} as Record<FixtureName, string>;
const urls = {} as Record<FixtureName, string>;
const events: PreviewEvent[] = [];
const cleanups: (() => void)[] = [];

const CONFIGS: Record<FixtureName, Pick<Design, "router" | "styling" | "css">> = {
  "rr-spa": { router: "react-router", styling: "tailwind", css: ["src/index.css"] },
  "rr-framework": { router: "react-router", styling: "inline", css: [] },
  tanstack: { router: "tanstack", styling: "inline", css: [] },
  "next-app": { router: "next-app", styling: "tailwind", css: ["app/globals.css"] },
  "next-pages": { router: "next-pages", styling: "css-modules", css: ["src/styles/globals.css"] },
  "next-webpack": { router: "next-app", styling: "tailwind", css: ["app/globals.css"] },
};
/** The App Router fixtures: `next-app` runs on Turbopack, `next-webpack` on webpack. */
const NEXT_APPS = ["next-app", "next-webpack"] as const;

function design(name: FixtureName): Design {
  return {
    id: name,
    name,
    root: roots[name],
    origin: "connected",
    ...CONFIGS[name],
    brandDir: "src/assets/brand",
  };
}

async function get(url: string, accept = "text/html") {
  const response = await fetch(url, { headers: { accept } });
  return { status: response.status, text: await response.text() };
}

beforeAll(async () => {
  previews = createPreviews({ host: "127.0.0.1", graceMs: 100 });
  previews.on("rr-spa", (event) => events.push(event));
  await Promise.all(
    FIXTURES.map(async (name) => {
      const fixture = await prepareFixture(name);
      cleanups.push(fixture.remove);
      roots[name] = fixture.root;
      urls[name] = (await previews.ensure(design(name))).url;
    }),
  );
}, 240_000);

// Each fixture copy has its own node_modules to delete.
afterAll(async () => {
  await previews?.close();
  for (const cleanup of cleanups) cleanup();
}, 60_000);

describe("previews", () => {
  test("answers cross-origin requests only from the Finite shell's hosts", async () => {
    const origin = async (from: string) => {
      const response = await fetch(`${urls["rr-spa"]}/__finite/routes`, {
        headers: { origin: from },
      });
      await response.body?.cancel();
      return response.headers.get("access-control-allow-origin");
    };
    expect(await origin("http://localhost:3000")).toBe("http://localhost:3000");
    expect(await origin("http://127.0.0.1:4100")).toBe("http://127.0.0.1:4100");
    expect(await origin("https://evil.example")).toBeNull();
  });

  test("reports starting, then ready with the URL", () => {
    const states = events.filter((e) => e.type === "preview").map((e) => e.status);
    expect(states.slice(0, 2)).toEqual(["starting", "ready"]);
    expect(previews.state("rr-spa")).toEqual({ status: "ready", url: urls["rr-spa"] });
  });

  test("lists React Router data routes from createBrowserRouter", async () => {
    expect(await previews.routes("rr-spa")).toEqual([
      { path: "/", params: [], file: "src/pages/Home.tsx" },
      { path: "/about", params: [], file: "src/pages/About.tsx" },
      { path: "/users/:userId", params: ["userId"], file: "src/pages/User.tsx" },
    ]);
    expect(events).toContainEqual({ type: "routes", routes: await previews.routes("rr-spa") });
  });

  test("lists React Router framework routes from app/routes.ts", async () => {
    expect(await previews.routes("rr-framework")).toEqual([
      { path: "/", params: [], file: "app/routes/home.tsx" },
      { path: "/about", params: [], file: "app/routes/about.tsx" },
      { path: "/posts/:postId", params: ["postId"], file: "app/routes/post.tsx" },
    ]);
  });

  test("lists TanStack routes from the generated route tree", async () => {
    expect(await previews.routes("tanstack")).toEqual([
      { path: "/", params: [], file: "src/routes/index.tsx" },
      { path: "/about", params: [], file: "src/routes/about.tsx" },
      { path: "/posts/$postId", params: ["postId"], file: "src/routes/posts.$postId.tsx" },
    ]);
  });

  test("gives frame URLs for routes and files", () => {
    const url = urls["rr-spa"];
    expect(
      previews.frameUrl("rr-spa", {
        kind: "route",
        path: "/users/:userId",
        params: { userId: "a b" },
      }),
    ).toBe(`${url}/users/a%20b`);
    expect(
      previews.frameUrl("rr-spa", { kind: "file", file: ".finite/boards/demo/Hero.tsx" }),
    ).toBe(`${url}/__finite/frame?file=.finite%2Fboards%2Fdemo%2FHero.tsx`);
    // The browser builds the same URL: both use the protocol's frameHref.
    expect(
      previews.frameUrl("rr-spa", { kind: "route", path: "/posts/{-$id}", params: { id: "42" } }),
    ).toBe(`${url}/posts/42`);
    expect(() => previews.frameUrl("nope", { kind: "route", path: "/" })).toThrow(/isn't ready/);
  });

  test("serves a file frame with the bridge and the design's stylesheet", async () => {
    const url = previews.frameUrl("rr-spa", {
      kind: "file",
      file: "src/components/Card.tsx",
      exportName: "Card",
    });
    const page = await get(url);
    expect(page.status).toBe(200);
    expect(page.text).toContain(`src="/@finite/bridge"`);
    expect(page.text).toContain("/@react-refresh");
    const entry = await get(
      `${urls["rr-spa"]}/@finite/frame?file=src/components/Card.tsx&export=Card`,
      "*/*",
    );
    expect(entry.text).toContain(`import "/src/index.css"`);
    expect(entry.text).toContain(`import Wrapper from "/.finite/Wrapper.tsx"`);
    expect(entry.text).toContain("createMemoryRouter");
  });

  test("refuses a frame file outside the design", async () => {
    const entry = await get(`${urls["rr-spa"]}/@finite/frame?file=../../etc/passwd`, "*/*");
    expect(entry.text).toContain("outside the design folder");
  });

  test("serves a route page with the bridge, and stamps its modules", async () => {
    const page = await get(`${urls["rr-spa"]}/about`);
    expect(page.text).toContain(`src="/@finite/bridge"`);
    const module = await get(`${urls["rr-spa"]}/src/pages/About.tsx`, "*/*");
    expect(module.text).toMatch(/"data-finite-loc": "src\/pages\/About\.tsx:2:9"/);
    expect(module.text).toMatch(/"data-finite-rev": "[0-9a-f]{8}"/);
  });

  test("makes .finite a Tailwind source without touching the stylesheet", async () => {
    const css = await get(`${urls["rr-spa"]}/src/index.css?direct`, "text/css");
    expect(css.text).toContain("bg-\\[\\#0a7f3e\\]");
    expect(fs.readFileSync(path.join(roots["rr-spa"], "src/index.css"), "utf8")).toBe(
      '@import "tailwindcss";\n',
    );
  });

  test("adds the bridge to framework-rendered HTML", async () => {
    const page = await get(`${urls["rr-framework"]}/about`);
    expect(page.status).toBe(200);
    expect(page.text).toContain(`<script type="module" src="/@finite/bridge"></script>`);
    expect(page.text.match(/@finite\/bridge/g)).toHaveLength(1);
  });

  test("keeps frame errors per frame", () => {
    previews.reportError("rr-spa", { frameId: "f1", kind: "console", message: "boom", at: 1 });
    expect(previews.errors("rr-spa", "f1")).toEqual([
      { frameId: "f1", kind: "console", message: "boom", at: 1 },
    ]);
    expect(previews.errors("rr-spa", "f2")).toEqual([]);
  });
});

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
  }, 60_000);

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
  }, 60_000);

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
  }, 60_000);

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
    60_000,
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
      fs.writeFileSync(path.join(root, BRAND_BOARD), brandBoard(design(name)));
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

  test("lists a brand asset added on its own on the brand board", async () => {
    // Only an image, once the preview's own writes have settled, so no source change syncs too.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const root = roots["next-app"];
    fs.mkdirSync(path.join(root, "assets/brand"), { recursive: true });
    fs.writeFileSync(path.join(root, "assets/brand/mark.png"), Buffer.from([0x89, 0x50]));
    await expect
      .poll(() => fs.readFileSync(path.join(root, ".finite/runtime/brand.ts"), "utf8"), {
        timeout: 10_000,
      })
      .toContain("mark.png");
  }, 30_000);

  test("drops the brand assets from the brand board when the brand folder is renamed away", async () => {
    // The watcher reports the folder itself, not the files that moved with it.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const root = roots["next-app"];
    fs.mkdirSync(path.join(root, "assets/brand"), { recursive: true });
    fs.writeFileSync(path.join(root, "assets/brand/gone.png"), Buffer.from([0x89, 0x50]));
    const runtime = () => fs.readFileSync(path.join(root, ".finite/runtime/brand.ts"), "utf8");
    await expect.poll(runtime, { timeout: 10_000 }).toContain("gone.png");
    await new Promise((resolve) => setTimeout(resolve, 1000));
    fs.renameSync(path.join(root, "assets/brand"), path.join(root, "assets/brand-old"));
    try {
      await expect.poll(runtime, { timeout: 10_000 }).not.toContain("gone.png");
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

  test.each(["turbopack", "webpack"])(
    "generates Tailwind v3 classes used only in .finite/, without touching the project (%s)",
    async (bundler) => {
      const fixture = await prepareFixture("next-tailwind3");
      cleanups.push(fixture.remove);
      const at = (file: string) => path.join(fixture.root, file);
      if (bundler === "webpack") {
        const pkg = fs.readFileSync(at("package.json"), "utf8");
        fs.writeFileSync(at("package.json"), pkg.replace(`"next dev"`, `"next dev --webpack"`));
      }
      const project = ["app/globals.css", "tailwind.config.ts", "postcss.config.mjs"];
      const before = project.map((file) => fs.readFileSync(at(file), "utf8"));
      const board = (file: string, className: string) => {
        fs.mkdirSync(path.dirname(at(file)), { recursive: true });
        fs.writeFileSync(at(file), `export default () => <section className="${className}" />;\n`);
      };
      board(".finite/boards/demo/Hero.tsx", "bg-[#0a7f3e] p-[13px] text-brand");
      board(".finite/runtime/Stray.tsx", "bg-[#999001]");
      const copy = {
        ...design("next-app"),
        id: `next-tailwind3-${bundler}`,
        root: fixture.root,
        css: ["app/globals.css"],
      };
      const { url } = await previews.ensure(copy);
      const css = async () => {
        const page = await get(
          previews.frameUrl(copy.id, { kind: "file", file: ".finite/boards/demo/Hero.tsx" }),
        );
        expect(page.status).toBe(200);
        const sheets = [...page.text.matchAll(/<link rel="stylesheet" href="([^"]+\.css[^"]*)"/g)];
        const css = await Promise.all(sheets.map(([, href]) => get(url + href, "text/css")));
        return css.map((sheet) => sheet.text).join("\n");
      };
      const first = await css();
      expect(first).toContain("bg-\\[\\#0a7f3e\\]");
      expect(first).toContain(".text-brand");
      // The project's own content globs still apply.
      expect(first).toContain(".bg-slate-50");
      expect(first).not.toContain("999001");

      // A board written while the preview runs gets its classes too.
      board(".finite/boards/later/Late.tsx", "bg-[#0b8f4e]");
      await expect.poll(css, { timeout: 15_000 }).toContain("bg-\\[\\#0b8f4e\\]");
      expect(project.map((file) => fs.readFileSync(at(file), "utf8"))).toEqual(before);
      await previews.stop(copy.id);
    },
    90_000,
  );
});

describe("preview lifecycle", () => {
  test("says why when the project has no Vite installed", async () => {
    const fixture = await prepareFixture("tanstack", { install: false });
    cleanups.push(fixture.remove);
    const bare = { ...design("tanstack"), id: "bare", root: fixture.root };
    await expect(previews.ensure(bare)).rejects.toThrow(/Vite isn't installed/);
    expect(previews.state("bare")).toMatchObject({ status: "error" });
    expect(previews.state("bare").log).toContain("Vite isn't installed");
  }, 30_000);

  test("sends the routes again when the source adds one", async () => {
    // Its own copy: editing main.tsx reloads every page of that dev server.
    const fixture = await prepareFixture("rr-spa");
    cleanups.push(fixture.remove);
    const copy = { ...design("rr-spa"), id: "routes", root: fixture.root };
    const seen: string[][] = [];
    const off = previews.on(copy.id, (e) => {
      if (e.type === "routes") seen.push(e.routes.map((r) => r.path));
    });
    await previews.ensure(copy);
    const main = path.join(fixture.root, "src/main.tsx");
    const source = fs.readFileSync(main, "utf8");
    fs.writeFileSync(
      main,
      source.replace(
        `{ path: "about",`,
        `{ path: "contact", element: <About /> },\n      { path: "about",`,
      ),
    );
    await expect.poll(() => seen.at(-1), { timeout: 10_000 }).toContain("/contact");
    off();
    await previews.stop(copy.id);
  }, 30_000);

  test("a Next.js preview leaves the project's files alone, and sends routes on a change", async () => {
    const fixture = await prepareFixture("next-app");
    cleanups.push(fixture.remove);
    const copy = { ...design("next-app"), id: "next-copy", root: fixture.root };
    const read = (file: string) => fs.readFileSync(path.join(fixture.root, file), "utf8");
    const before = { tsconfig: read("tsconfig.json"), env: read("next-env.d.ts") };
    const seen: string[][] = [];
    const off = previews.on(copy.id, (e) => {
      if (e.type === "routes") seen.push(e.routes.map((r) => r.path));
    });
    await previews.ensure(copy);
    const mount = path.join(fixture.root, "app/%5F%5Ffinite/frame/page.tsx");
    expect(fs.existsSync(mount)).toBe(true);
    expect({ tsconfig: read("tsconfig.json"), env: read("next-env.d.ts") }).toEqual(before);
    expect(fs.existsSync(path.join(fixture.root, ".next"))).toBe(false);

    fs.mkdirSync(path.join(fixture.root, "app/contact"));
    fs.writeFileSync(
      path.join(fixture.root, "app/contact/page.tsx"),
      "export default () => <h1>Contact</h1>;\n",
    );
    await expect.poll(() => seen.at(-1), { timeout: 10_000 }).toContain("/contact");
    off();
    await previews.stop(copy.id);
    expect(fs.existsSync(path.join(fixture.root, "app/%5F%5Ffinite"))).toBe(false);
  }, 60_000);

  test("won't overwrite a project's own file where Next.js file frames go", async () => {
    const fixture = await prepareFixture("next-pages");
    cleanups.push(fixture.remove);
    const mine = path.join(fixture.root, "src/pages/__finite/frame.tsx");
    fs.mkdirSync(path.dirname(mine), { recursive: true });
    fs.writeFileSync(mine, "export default () => null;\n");
    const copy = { ...design("next-pages"), id: "next-taken", root: fixture.root };
    await expect(previews.ensure(copy)).rejects.toThrow(/project's own file/);
    expect(fs.readFileSync(mine, "utf8")).toBe("export default () => null;\n");
  }, 60_000);

  test("keeps a Next.js frame mount someone edited, and won't overwrite it on the next start", async () => {
    const fixture = await prepareFixture("next-pages");
    cleanups.push(fixture.remove);
    const copy = { ...design("next-pages"), id: "next-edited", root: fixture.root };
    await previews.ensure(copy);
    const mount = path.join(fixture.root, "src/pages/__finite/frame.tsx");
    const edited = `${fs.readFileSync(mount, "utf8")}// mine\n`;
    fs.writeFileSync(mount, edited);
    await previews.stop(copy.id);
    expect(fs.readFileSync(mount, "utf8")).toBe(edited);
    await expect(previews.ensure(copy)).rejects.toThrow(/changed since Finite wrote it/);
    expect(fs.readFileSync(mount, "utf8")).toBe(edited);
  }, 60_000);

  test("mounts Next.js file frames inside the route group that holds the root layout", async () => {
    const fixture = await prepareFixture("next-app");
    cleanups.push(fixture.remove);
    const at = (file: string) => path.join(fixture.root, file);
    // Only app/(site)/layout.tsx: every page sits in a group with a root layout.
    fs.mkdirSync(at("app/(site)"));
    for (const name of ["page.tsx", "about", "(marketing)", "blog", "docs", "shop"]) {
      fs.renameSync(at(`app/${name}`), at(`app/(site)/${name}`));
    }
    fs.writeFileSync(
      at("app/(site)/layout.tsx"),
      fs.readFileSync(at("app/layout.tsx"), "utf8").replace("./globals.css", "../globals.css"),
    );
    fs.rmSync(at("app/layout.tsx"));
    const copy = { ...design("next-app"), id: "next-groups", root: fixture.root };
    const { url } = await previews.ensure(copy);
    expect(fs.existsSync(at("app/(site)/%5F%5Ffinite/frame/page.tsx"))).toBe(true);
    expect(fs.existsSync(at("app/%5F%5Ffinite"))).toBe(false);
    expect((await get(`${url}/about`)).status).toBe(200);
    const frame = await get(
      `${url}/__finite/frame?file=app%2F_components%2FCounter.tsx&export=Counter`,
    );
    expect(frame.status).toBe(200);
    expect(frame.text).toContain(`data-finite-loc="app/_components/Counter.tsx`);
    expect((await previews.routes(copy.id)).map((r) => r.path)).not.toContain("/__finite/frame");
    await previews.stop(copy.id);
    expect(fs.existsSync(at("app/(site)/%5F%5Ffinite"))).toBe(false);
    expect(fs.existsSync(at("app/(site)/layout.tsx"))).toBe(true);
  }, 60_000);

  test("runs a Pages Router project on webpack when its dev script says --webpack", async () => {
    const fixture = await prepareFixture("next-pages");
    cleanups.push(fixture.remove);
    const pkg = path.join(fixture.root, "package.json");
    fs.writeFileSync(
      pkg,
      fs.readFileSync(pkg, "utf8").replace(`"next dev"`, `"next dev --webpack"`),
    );
    const copy = { ...design("next-pages"), id: "next-pages-webpack", root: fixture.root };
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
  }, 60_000);

  test("runs a project on webpack when its config has webpack() and no turbopack", async () => {
    const fixture = await prepareFixture("next-webpack");
    cleanups.push(fixture.remove);
    const pkg = path.join(fixture.root, "package.json");
    fs.writeFileSync(
      pkg,
      fs.readFileSync(pkg, "utf8").replace(`"next dev --webpack"`, `"next dev"`),
    );
    const copy = { ...design("next-webpack"), id: "next-webpack-config", root: fixture.root };
    const { url } = await previews.ensure(copy);
    expect((await get(`${url}/`)).text).toContain("Built with <!-- -->webpack");
    await previews.stop(copy.id);
  }, 60_000);

  test("renders Next.js file frames for a project with output: export", async () => {
    const fixture = await prepareFixture("next-pages");
    cleanups.push(fixture.remove);
    const config = path.join(fixture.root, "next.config.ts");
    fs.writeFileSync(config, fs.readFileSync(config, "utf8").replace("{}", `{ output: "export" }`));
    const copy = { ...design("next-pages"), id: "next-export", root: fixture.root };
    const { url } = await previews.ensure(copy);
    const frame = await get(`${url}/__finite/frame?file=src%2Fpages%2Fabout.tsx`);
    expect(frame.status).toBe(200);
    expect((await get(`${url}/about`)).status).toBe(200);
    await previews.stop(copy.id);
  }, 60_000);

  test("follows a Next.js project's pageExtensions and basePath", async () => {
    const fixture = await prepareFixture("next-pages");
    cleanups.push(fixture.remove);
    const at = (file: string) => path.join(fixture.root, file);
    fs.writeFileSync(
      at("next.config.ts"),
      fs
        .readFileSync(at("next.config.ts"), "utf8")
        .replace("{}", `{ basePath: "/docs", pageExtensions: ["page.tsx", "mdx"] }`),
    );
    for (const page of ["_app", "_document", "about", "index", "posts/[id]"]) {
      fs.renameSync(at(`src/pages/${page}.tsx`), at(`src/pages/${page}.page.tsx`));
    }
    // Not a page with these pageExtensions, so not a route either.
    fs.writeFileSync(
      at("src/pages/posts/Card.tsx"),
      "export function Card() {\n  return <p>Card</p>;\n}\n",
    );
    const copy = { ...design("next-pages"), id: "next-settings", root: fixture.root };
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
  }, 90_000);

  test("serves an App Router project's frames and brand files under its basePath", async () => {
    const fixture = await prepareFixture("next-app");
    cleanups.push(fixture.remove);
    const at = (file: string) => path.join(fixture.root, file);
    fs.writeFileSync(
      at("next.config.ts"),
      fs.readFileSync(at("next.config.ts"), "utf8").replace("{}", `{ basePath: "/base" }`),
    );
    // The fixture's design.json puts the brand folder in assets/brand.
    fs.mkdirSync(at("assets/brand"), { recursive: true });
    fs.writeFileSync(at("assets/brand/logo.svg"), `<svg xmlns="http://www.w3.org/2000/svg"/>`);
    const copy = { ...design("next-app"), id: "next-base", root: fixture.root };
    const { url } = await previews.ensure(copy);
    expect(url).toMatch(/:\d+\/base$/);
    expect((await previews.routes(copy.id)).map((r) => r.path)).toContain("/about");

    const about = await get(previews.frameUrl(copy.id, { kind: "route", path: "/about" }));
    expect(about.status).toBe(200);
    expect(about.text).toContain(`src="/base/__finite/bridge.js"`);
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
  }, 90_000);

  test("previews a Next.js project with its own adapter, running its modifyConfig too", async () => {
    const fixture = await prepareFixture("next-app");
    cleanups.push(fixture.remove);
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
    const config = at("next.config.ts");
    fs.writeFileSync(
      config,
      fs
        .readFileSync(config, "utf8")
        .replace("{}", `{ adapterPath: ${JSON.stringify(at("adapter.mjs"))} }`),
    );
    fs.writeFileSync(
      at("app/about/page.tsx"),
      "export default () => <h1>{process.env.MINE}</h1>;\n",
    );
    const copy = { ...design("next-app"), id: "next-adapter", root: fixture.root };
    const { url } = await previews.ensure(copy);
    const about = await get(`${url}/about`);
    expect(about.status).toBe(200);
    expect(about.text).toMatch(/<h1 data-finite-loc="app\/about\/page.tsx:[^"]*"[^>]*>ran<\/h1>/);
    expect(fs.existsSync(at("mine"))).toBe(false);
    expect(fs.existsSync(at(".finite/runtime/next"))).toBe(true);
    await previews.stop(copy.id);
  }, 60_000);

  test("stops after the grace period once idle, and restarts on ensure", async () => {
    const tanstack = design("tanstack");
    previews.idle(tanstack.id);
    await expect
      .poll(() => previews.state(tanstack.id).status, { timeout: 10_000 })
      .toBe("stopped");
    const { url } = await previews.ensure(tanstack);
    urls.tanstack = url;
    expect(previews.state(tanstack.id).status).toBe("ready");
  }, 60_000);
});

// The browser half: a parent page that does the parent side of the bridge handshake.

const chromePath = (() => {
  try {
    return getChromePath();
  } catch {
    return undefined;
  }
})();

const PARENT = `<!doctype html><html><body style="margin:0">
<script>
  window.bridge = { events: [], pending: new Map(), id: 0, port: null, hellos: 0 };
  window.bridge.connected = new Promise((resolve) => {
    addEventListener("message", (event) => {
      if (event.data?.type !== "finite:hello") return;
      bridge.hellos++;
      const channel = new MessageChannel();
      bridge.port = channel.port1;
      channel.port1.onmessage = ({ data }) => {
        if (data.type === "reply" || data.type === "refused") bridge.pending.get(data.id)?.(data);
        else bridge.events.push(data);
      };
      event.source.postMessage({ type: "finite:connect", frameId: "f1" }, "*", [channel.port2]);
      resolve();
    });
  });
  window.ask = (type, params) => new Promise((resolve) => {
    const id = ++bridge.id;
    bridge.pending.set(id, resolve);
    bridge.port.postMessage({ type, id, ...params });
  });
</script>
<iframe id="frame" style="border:0;width:800px;height:600px"></iframe>
</body></html>`;

describe.skipIf(!chromePath)("bridge in Chrome", () => {
  let browser: Browser;
  /** The parent page, served on loopback like the Finite shell. */
  let parentServer: http.Server;
  let parentUrl: string;

  beforeAll(async () => {
    browser = await puppeteer.launch({
      executablePath: chromePath!,
      headless: true,
      // CI's Ubuntu runners block the user namespaces Chrome's sandbox needs.
      args: process.env.CI ? ["--no-sandbox"] : [],
    });
    parentServer = http.createServer((_, res) => {
      res.setHeader("content-type", "text/html");
      res.end(PARENT);
    });
    await new Promise<void>((resolve) => parentServer.listen(0, "127.0.0.1", resolve));
    parentUrl = `http://127.0.0.1:${(parentServer.address() as AddressInfo).port}/`;
  }, 30_000);

  afterAll(async () => {
    await browser?.close();
    parentServer?.close();
  });

  async function open(
    src: string,
    selector = "[data-finite-loc]",
  ): Promise<{ page: Page; frame: Frame }> {
    const page = await browser.newPage();
    await page.setViewport({ width: 800, height: 600 });
    await page.goto(parentUrl);
    await page.evaluate((url) => {
      (document.getElementById("frame") as HTMLIFrameElement).src = url;
    }, src);
    await page.waitForFunction(
      () => (window as unknown as { bridge: { port: unknown } }).bridge.port,
      {
        timeout: 30_000,
      },
    );
    const frame = page
      .frames()
      .find((f) => f !== page.mainFrame() && f.url().startsWith(new URL(src).origin))!;
    await frame.waitForSelector(selector, { timeout: 30_000 });
    return { page, frame };
  }

  test("connects only to a parent page on an allowed host", async () => {
    const src = previews.frameUrl("rr-spa", { kind: "route", path: "/about" });
    const { page } = await open(src);
    await vi.waitFor(async () => expect((await bridgeEvents(page)).length).toBeGreaterThan(0));
    await page.close();

    // The same page from another origin (here `null`) says hello but never gets a port.
    const stranger = await browser.newPage();
    await stranger.setContent(PARENT);
    await stranger.evaluate((url) => {
      (document.getElementById("frame") as HTMLIFrameElement).src = url;
    }, src);
    await stranger.waitForFunction(
      () => (window as unknown as { bridge: { hellos: number } }).bridge.hellos > 0,
      { timeout: 30_000 },
    );
    await new Promise((r) => setTimeout(r, 1_000));
    expect(await bridgeEvents(stranger)).toEqual([]);
    await stranger.close();
  }, 60_000);

  const ask = (page: Page, type: string, params: Record<string, unknown> = {}) =>
    page.evaluate(
      (t, p) =>
        (window as unknown as { ask: (t: string, p: unknown) => Promise<unknown> }).ask(t, p),
      type,
      params,
    ) as Promise<{ type: string; value: never }>;
  const bridgeEvents = (page: Page) =>
    page.evaluate(
      () => (window as unknown as { bridge: { events: { type: string }[] } }).bridge.events,
    ) as Promise<({ type: string } & Record<string, unknown>)[]>;

  test("inspect reads a size its insets give and the zoom above an element", async () => {
    const { page, frame } = await open(`${urls["rr-spa"]}/`);
    await frame.evaluate(() => {
      const add = (parent: Element, loc: string, css: string) => {
        const el = document.createElement("div");
        el.setAttribute("data-finite-loc", loc);
        el.setAttribute("data-finite-rev", "test");
        el.style.cssText = css;
        parent.append(el);
        return el;
      };
      const box = add(document.body, "t:1:0", "position:relative;width:400px;height:200px");
      add(box, "t:2:0", "position:absolute;left:20px;top:20px;right:20px;bottom:20px");
      const zoomed = add(box, "t:3:0", "zoom:2");
      add(zoomed, "t:4:0", "position:absolute;left:10px;top:0;width:5px;height:5px");
      add(
        box,
        "t:5:0",
        "position:absolute;inset:20px;box-sizing:content-box;padding:10px;border:2px solid;transform:scale(2)",
      );
    });
    const read = async (loc: string) =>
      (
        (await ask(page, "inspect", { loc, index: 0 })).value as {
          computed: Record<string, string>;
        }
      ).computed;
    expect(await read("t:2:0")).toMatchObject({ sizedWidth: "auto", sizedHeight: "auto" });
    expect(await read("t:4:0")).toMatchObject({
      sizedWidth: "fixed",
      effectiveZoom: "2",
      width: "5px",
    });
    // Its box is 360×160 and scaled twice over; its own width and height are what's left inside.
    expect(await read("t:5:0")).toMatchObject({
      width: "336px",
      height: "136px",
      sizedWidth: "auto",
      sizedHeight: "auto",
    });
  });

  test("hit, rects, inspect, layers, errors and HMR on a route frame", async () => {
    const { page, frame } = await open(`${urls["rr-spa"]}/`);
    const heading = await frame.$eval("h1", (h) => {
      const r = h.getBoundingClientRect();
      return { x: r.x + 4, y: r.y + 4, loc: h.getAttribute("data-finite-loc") };
    });
    expect(heading.loc).toBe("src/pages/Home.tsx:8:6");

    const hit = await ask(page, "hit", { x: heading.x, y: heading.y });
    expect(hit.value).toMatchObject({
      loc: "src/pages/Home.tsx:8:6",
      tag: "h1",
      index: 0,
      count: 1,
      path: [
        { loc: "src/pages/Home.tsx:7:4", tag: "main" },
        { loc: "src/Layout.tsx:5:4", tag: "div" },
      ],
    });

    const card = "src/components/Card.tsx:5:4";
    const rects = (await ask(page, "rects", { locs: [card] })).value as Record<string, unknown[]>;
    expect(rects[card]).toHaveLength(3);

    const inspection = (await ask(page, "inspect", { loc: card, index: 1 })).value as {
      className: string;
      computed: Record<string, string>;
      parent: { display: string; flexDirection: string };
    };
    expect(inspection.className).toBe("rounded-lg border p-4");
    expect(inspection.computed.borderTopLeftRadius).toBe("8px");
    expect(inspection.parent).toEqual({ display: "flex", flexDirection: "column" });

    const layers = (await ask(page, "layers")).value as LayerNode[];
    const main = layers[0]!.children.find((layer) => layer.loc === "src/pages/Home.tsx:7:4")!;
    expect(main.children.map((layer) => [layer.loc, layer.index])).toEqual([
      ["src/pages/Home.tsx:8:6", 0],
      [card, 0],
      [card, 1],
      [card, 2],
    ]);

    await page.evaluate(() =>
      (window as unknown as { bridge: { port: MessagePort } }).bridge.port.postMessage({
        type: "preview",
        loc: "src/pages/Home.tsx:8:6",
        styles: { color: "rgb(255, 0, 0)" },
      }),
    );
    await expect
      .poll(() => frame.$eval("h1", (h) => getComputedStyle(h).color))
      .toBe("rgb(255, 0, 0)");

    await frame.evaluate(() => console.error("boom", { at: 1 }));
    await frame.evaluate(() =>
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true })),
    );
    await expect
      .poll(() => bridgeEvents(page))
      .toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "size" }),
          { type: "error", kind: "console", message: 'boom {"at":1}' },
          expect.objectContaining({ type: "key", key: "k", meta: true }),
        ]),
      );

    const revBefore = await frame.$eval("h1", (h) => h.getAttribute("data-finite-rev"));
    const home = path.join(roots["rr-spa"], "src/pages/Home.tsx");
    fs.writeFileSync(home, fs.readFileSync(home, "utf8").replace("Welcome home", "Welcome back"));
    await expect
      .poll(() => bridgeEvents(page).then((list) => list.some((e) => e.type === "updated")), {
        timeout: 15_000,
      })
      .toBe(true);
    expect(await frame.$eval("h1", (h) => h.textContent)).toBe("Welcome back");
    expect(await frame.$eval("h1", (h) => h.getAttribute("data-finite-rev"))).not.toBe(revBefore);
    // The preview is cleared by the update.
    expect(await frame.$eval("h1", (h) => h.style.color)).toBe("");
    await page.close();
  }, 60_000);

  test("renders a prototype file frame with its wrapper, router and Tailwind classes", async () => {
    const src = previews.frameUrl("rr-spa", { kind: "file", file: ".finite/boards/demo/Hero.tsx" });
    const { page, frame } = await open(src);
    expect(await frame.$eval("section", (s) => getComputedStyle(s).backgroundColor)).toBe(
      "rgb(10, 127, 62)",
    );
    expect(await frame.$eval("[data-wrapper] section a", (a) => a.getAttribute("href"))).toBe(
      "/about",
    );
    await page.close();

    // A prototype written after the dev server started gets its classes too.
    fs.writeFileSync(
      path.join(roots["rr-spa"], ".finite/boards/demo/Fresh.tsx"),
      `export default () => <p className="bg-[#123456] p-[13px]">fresh</p>;\n`,
    );
    const fresh = await open(
      previews.frameUrl("rr-spa", { kind: "file", file: ".finite/boards/demo/Fresh.tsx" }),
    );
    await expect
      .poll(() => fresh.frame.$eval("p", (p) => getComputedStyle(p).backgroundColor))
      .toBe("rgb(18, 52, 86)");

    // Not a Fast Refresh boundary (anonymous export), so the frame entry re-renders it in place.
    const file = path.join(roots["rr-spa"], ".finite/boards/demo/Fresh.tsx");
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(">fresh<", ">fresher<"));
    await expect.poll(() => fresh.frame.$eval("p", (p) => p.textContent)).toBe("fresher");
    await expect
      .poll(() => bridgeEvents(fresh.page).then((list) => list.some((e) => e.type === "updated")))
      .toBe(true);
    expect(
      await fresh.page.evaluate(
        () => (window as unknown as { bridge: { hellos: number } }).bridge.hellos,
      ),
    ).toBe(1);
    await fresh.page.close();
  }, 60_000);

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
    120_000,
  );

  test("connects in React Router framework mode and in TanStack frames", async () => {
    for (const src of [
      `${urls["rr-framework"]}/posts/7`,
      previews.frameUrl("rr-framework", { kind: "file", file: "app/routes/about.tsx" }),
      `${urls.tanstack}/about`,
      previews.frameUrl("tanstack", {
        kind: "file",
        file: "src/components/Badge.tsx",
        exportName: "Badge",
      }),
    ]) {
      const { page } = await open(src, "h1[data-finite-loc], span[data-finite-loc]");
      const errors = (await bridgeEvents(page)).filter((e) => e.type === "error");
      expect(errors, src).toEqual([]);
      await page.close();
    }
  }, 120_000);
});
