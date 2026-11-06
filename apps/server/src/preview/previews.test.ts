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
import { prepareFixture } from "./fixtures.ts";
import { createPreviews } from "./index.ts";

const FIXTURES = ["rr-spa", "rr-framework", "tanstack"] as const;
type FixtureName = (typeof FIXTURES)[number];

let previews: Previews;
const roots = {} as Record<FixtureName, string>;
const urls = {} as Record<FixtureName, string>;
const events: PreviewEvent[] = [];
const cleanups: (() => void)[] = [];

function design(name: FixtureName): Design {
  return {
    id: name,
    name,
    root: roots[name],
    origin: "connected",
    router: name === "tanstack" ? "tanstack" : "react-router",
    styling: name === "rr-spa" ? "tailwind" : "inline",
    css: name === "rr-spa" ? ["src/index.css"] : [],
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

afterAll(async () => {
  await previews?.close();
  for (const cleanup of cleanups) cleanup();
});

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
    // The browser builds the same URL: both use the protocol's routeHref.
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
    browser = await puppeteer.launch({ executablePath: chromePath!, headless: true });
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
