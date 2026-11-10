/// <reference lib="dom" />
// The DOM types are for the code these tests run in Chrome.

import fs from "node:fs";
import path from "node:path";
import type { LayerNode, PreviewEvent } from "@finite/protocol";
import { describe, expect, test, vi } from "vite-plus/test";
import { createScreenshots } from "../agent/screenshot.ts";
import { chromeArgs, describeChrome } from "./fixtures.ts";
import { bridgeChrome, designOf, get, PARENT, sharedPreviews } from "./harness.ts";

const events: PreviewEvent[] = [];
const { previews, prepare, roots, urls } = sharedPreviews(
  ["rr-spa", "rr-framework", "tanstack"],
  (previews) => void previews.on("rr-spa", (event) => events.push(event)),
);

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

describe("preview lifecycle", () => {
  test("says why when the project has no Vite installed", async () => {
    const fixture = await prepare("tanstack", { install: false });
    const bare = { ...designOf("tanstack", fixture.root), id: "bare" };
    await expect(previews.ensure(bare)).rejects.toThrow(/Vite isn't installed/);
    expect(previews.state("bare")).toMatchObject({ status: "error" });
    expect(previews.state("bare").log).toContain("Vite isn't installed");
  }, 30_000);

  test("sends the routes again when the source adds one", async () => {
    // Its own copy: editing main.tsx reloads every page of that dev server.
    const fixture = await prepare("rr-spa");
    const copy = { ...designOf("rr-spa", fixture.root), id: "routes" };
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
    const tanstack = designOf("tanstack", roots.tanstack);
    previews.idle(tanstack.id);
    await expect
      .poll(() => previews.state(tanstack.id).status, { timeout: 10_000 })
      .toBe("stopped");
    const { url } = await previews.ensure(tanstack);
    urls.tanstack = url;
    expect(previews.state(tanstack.id).status).toBe("ready");
  }, 60_000);
});

describeChrome("bridge in Chrome", () => {
  const { browser, open, ask, bridgeEvents } = bridgeChrome();

  test("connects only to a parent page on an allowed host", async () => {
    const src = previews.frameUrl("rr-spa", { kind: "route", path: "/about" });
    const { page } = await open(src);
    await vi.waitFor(async () => expect((await bridgeEvents(page)).length).toBeGreaterThan(0));
    await page.close();

    // The same page from another origin (here `null`) says hello but never gets a port.
    const stranger = await browser().newPage();
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

  test("measureArea reports what overlaps a rect, with the right index of each loc", async () => {
    const { page, frame } = await open(`${urls["rr-spa"]}/`);
    await frame.evaluate(() => {
      const box = (css: string, loc?: string, parent: Element = document.body) => {
        const el = document.createElement("div");
        if (loc) el.setAttribute("data-finite-loc", loc);
        el.style.cssText = `position:fixed;${css}`;
        parent.append(el);
        return el;
      };
      box("left:500px;top:500px;width:20px;height:20px", "a:1:0");
      box("left:500px;top:530px;width:20px;height:20px", "a:1:0");
      box("left:510px;top:560px;width:40px;height:20px"); // Unstamped and partly inside.
      box("left:500px;top:590px;width:20px;height:20px;visibility:hidden", "a:2:0");
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("style", "position:fixed;left:500px;top:620px;width:20px;height:20px");
      svg.append(document.createElementNS("http://www.w3.org/2000/svg", "rect"));
      document.body.append(svg);
    });
    const { value } = await ask(page, "measureArea", {
      rect: { x: 495, y: 495, width: 30, height: 190 },
      props: [],
      max: 150,
    });
    const { elements, total } = value as {
      elements: { tag: string; loc?: string; index: number; count: number }[];
      total: number;
    };
    const fixed = elements.filter((el) => el.loc === "a:1:0" || el.tag === "svg" || !el.loc);
    expect(fixed.map((el) => [el.tag, el.loc, el.index, el.count])).toEqual([
      ["div", "a:1:0", 0, 2],
      ["div", "a:1:0", 1, 2],
      ["div", undefined, 0, 1],
      ["svg", undefined, 0, 1],
    ]);
    expect(elements.some((el) => el.tag === "rect")).toBe(false);
    expect(total).toBe(elements.length);
    const capped = await ask(page, "measureArea", {
      rect: { x: 495, y: 495, width: 30, height: 190 },
      props: [],
      max: 1,
    });
    const reply = capped.value as { elements: unknown[]; total: number };
    expect(reply.elements).toHaveLength(1);
    expect(reply.total).toBe(total);
    await page.close();
  }, 60_000);

  test("measureArea leaves out what an ancestor's overflow cuts away", async () => {
    const { page, frame } = await open(`${urls["rr-spa"]}/`);
    await frame.evaluate(() => {
      const clip = document.createElement("div");
      clip.style.cssText =
        "position:fixed;left:700px;top:500px;width:100px;height:100px;overflow:hidden";
      const child = (css: string, loc: string, parent: Element = clip) => {
        const el = document.createElement("div");
        el.setAttribute("data-finite-loc", loc);
        el.style.cssText = `width:50px;height:50px;${css}`;
        parent.append(el);
      };
      child("position:absolute;left:200px;top:0", "cut:1:0");
      child("position:absolute;left:10px;top:0", "kept:1:0");
      child("position:fixed;left:900px;top:520px", "fixed:1:0");
      const plain = document.createElement("div");
      plain.style.cssText = "position:static;width:10px;height:10px;overflow:hidden";
      clip.append(plain);
      child("position:absolute;left:220px;top:10px", "cut2:1:0", plain);
      document.body.append(clip);
    });
    const { value } = await ask(page, "measureArea", {
      rect: { x: 705, y: 495, width: 300, height: 90 },
      props: [],
      max: 150,
    });
    const locs = (value as { elements: { loc?: string }[] }).elements.map((el) => el.loc);
    expect(locs).toContain("kept:1:0");
    expect(locs).toContain("fixed:1:0");
    expect(locs).not.toContain("cut:1:0");
    expect(locs).not.toContain("cut2:1:0");
    await page.close();
  }, 60_000);

  test("measureArea follows containing blocks, padding edges and boxless wrappers", async () => {
    const { page, frame } = await open(`${urls["rr-spa"]}/`);
    await frame.evaluate(() => {
      const box = (css: string, loc: string, parent: Element = document.body) => {
        const el = document.createElement("div");
        el.setAttribute("data-finite-loc", loc);
        el.style.cssText = css;
        parent.append(el);
        return el;
      };
      const held = box(
        "position:fixed;left:700px;top:100px;width:100px;height:100px;overflow:hidden;transform:translateZ(0)",
        "held:1:0",
      );
      box("position:fixed;left:200px;top:0;width:50px;height:50px", "fixedcut:1:0", held);
      const contained = box(
        "position:fixed;left:700px;top:300px;width:100px;height:100px;overflow:hidden;contain:layout",
        "contained:1:0",
      );
      box("position:absolute;left:200px;top:0;width:50px;height:50px", "abscut:1:0", contained);
      const bordered = box(
        "position:fixed;left:700px;top:500px;width:100px;height:100px;overflow:hidden;border:20px solid;box-sizing:border-box",
        "bordered:1:0",
      );
      box("position:absolute;left:60px;top:0;width:15px;height:50px", "edge:1:0", bordered);
      const wrapper = box("display:contents;overflow:hidden", "wrapper:1:0");
      box("position:fixed;left:1000px;top:100px;width:50px;height:50px", "shown:1:0", wrapper);
    });
    const measure = async (x: number, y: number) => {
      const rect = { x, y, width: 8, height: 8 };
      const { value } = await ask(page, "measureArea", { rect, props: [], max: 150 });
      return (value as { elements: { loc?: string }[] }).elements.map((el) => el.loc);
    };
    expect(await measure(905, 110)).not.toContain("fixedcut:1:0");
    expect(await measure(905, 310)).not.toContain("abscut:1:0");
    expect(await measure(782, 525)).not.toContain("edge:1:0");
    expect(await measure(1010, 110)).toContain("shown:1:0");
    await page.close();
  }, 60_000);

  test("a headless region measure returns elements and a PNG", async () => {
    const screenshots = createScreenshots(chromeArgs);
    try {
      const got = await screenshots.measureRegion(`${urls["rr-spa"]}/`, 800, 600, {
        region: { x: 0, y: 0, width: 200, height: 200 },
        max: 5,
        image: true,
      });
      expect(got.elements.length).toBeGreaterThan(0);
      expect(got.elements.length).toBeLessThanOrEqual(5);
      expect(got.total).toBeGreaterThanOrEqual(got.elements.length);
      expect(got.png?.byteLength).toBeGreaterThan(0);
    } finally {
      await screenshots.close();
    }
  }, 60_000);

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
      .poll(() => fresh.frame.$eval("p", (p) => getComputedStyle(p).backgroundColor), {
        timeout: 15_000,
      })
      .toBe("rgb(18, 52, 86)");

    // Not a Fast Refresh boundary (anonymous export), so the frame entry re-renders it in place.
    const file = path.join(roots["rr-spa"], ".finite/boards/demo/Fresh.tsx");
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(">fresh<", ">fresher<"));
    await expect
      .poll(() => fresh.frame.$eval("p", (p) => p.textContent), { timeout: 15_000 })
      .toBe("fresher");
    await expect
      .poll(() => bridgeEvents(fresh.page).then((list) => list.some((e) => e.type === "updated")), {
        timeout: 15_000,
      })
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
