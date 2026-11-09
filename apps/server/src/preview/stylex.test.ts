import fs from "node:fs";
import path from "node:path";
import type { Design, Previews } from "@finite/protocol";
import type { Browser, Page } from "puppeteer-core";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { rev } from "../source/files.ts";
import {
  chromePath,
  LAUNCH_HOOK_TIMEOUT_MS,
  launchChrome,
  prepareFixture,
  viewed,
} from "./fixtures.ts";
import { createPreviews } from "./index.ts";

const FIXTURES = ["stylex", "stylex-framework"] as const;
type FixtureName = (typeof FIXTURES)[number];

let previews: Previews;
const roots = {} as Record<FixtureName, string>;
const urls = {} as Record<FixtureName, string>;
const cleanups: (() => void)[] = [];

beforeAll(async () => {
  previews = viewed(createPreviews({ host: "127.0.0.1", graceMs: 100 }));
  await Promise.all(
    FIXTURES.map(async (name) => {
      const fixture = await prepareFixture(name);
      cleanups.push(fixture.remove);
      roots[name] = fixture.root;
      const design: Design = {
        id: name,
        name,
        root: fixture.root,
        origin: "connected",
        router: "react-router",
        styling: "stylex",
        css: name === "stylex" ? ["src/index.css"] : [],
        brandDir: "src/assets/brand",
      };
      urls[name] = (await previews.ensure(design)).url;
    }),
  );
}, 240_000);

afterAll(async () => {
  await previews?.close();
  for (const cleanup of cleanups) cleanup();
});

async function get(url: string, accept = "*/*") {
  const response = await fetch(url, { headers: { accept } });
  return response.text();
}

/** Checks that each file's module is stamped as the file is on disk, with `create` compiled away. */
async function expectStamped(name: FixtureName, files: [file: string, loc: string][]) {
  for (const [file, loc] of files) {
    const module = await get(`${urls[name]}/${file}`);
    const onDisk = fs.readFileSync(path.join(roots[name], file), "utf8");
    expect(module).toContain(`"data-finite-loc": "${file}:${loc}"`);
    expect(module).toContain(`"data-finite-rev": "${rev(onDisk)}"`);
    expect(module).not.toContain("create(");
  }
}

describe("a StyleX project's preview", () => {
  test("stamps the file as it is on disk, before StyleX compiles it", async () => {
    await expectStamped("stylex", [
      ["src/components/Card.tsx", "28:4"],
      [".finite/boards/demo/Hero.tsx", "16:4"],
    ]);
    const css = await get(`${urls.stylex}/virtual:stylex.css`, "text/css");
    expect(css).toContain("padding: 16px");
    expect(css).toContain("padding: 32px");
    // Card's border uses a defineVars token from src/tokens.stylex.ts.
    expect(css).toContain("#c8d3d6");
    expect(css).toMatch(/border-color: ?var\(--/);
  });

  test("gives file frames StyleX's stylesheet", async () => {
    const frame = await get(
      `${urls.stylex}/__finite/frame?file=.finite/boards/demo/Hero.tsx`,
      "text/html",
    );
    expect(frame).toContain(`href="/virtual:stylex.css"`);
    expect(frame).toContain("virtual:stylex:runtime");
  });
});

describe("a StyleX project in React Router framework mode", () => {
  test("stamps route and prototype modules as they are on disk", async () => {
    await expectStamped("stylex-framework", [
      ["app/routes/home.tsx", "19:4"],
      [".finite/boards/demo/Hero.tsx", "12:4"],
    ]);
  });

  test("server-renders StyleX class names with the bridge and StyleX's stylesheet", async () => {
    const html = await get(`${urls["stylex-framework"]}/`, "text/html");
    expect(html).toContain(`<script type="module" src="/@finite/bridge"></script>`);
    expect(html).toContain(`href="/virtual:stylex.css"`);
    expect(html).toMatch(/<h1 data-finite-loc="app\/routes\/home.tsx:20:6"[^>]* class="x[^"]+"/);
    const css = await get(`${urls["stylex-framework"]}/virtual:stylex.css`, "text/css");
    expect(css).toContain("font-size: 28px");
  });
});

describe.skipIf(!chromePath)("StyleX framework mode in Chrome", () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await launchChrome();
  }, LAUNCH_HOOK_TIMEOUT_MS);

  afterAll(async () => {
    await browser?.close();
  });

  const color = (page: Page) =>
    page.evaluate(() => getComputedStyle(document.querySelector("h1")!).color);

  test("styles route and file frames, and updates them over HMR", async () => {
    const route = await browser.newPage();
    const errors: string[] = [];
    route.on("pageerror", (e) => void errors.push(String(e)));
    route.on("console", (m) => {
      // The fixture has no favicon.
      if (m.type() === "error" && !m.location().url?.endsWith("/favicon.ico"))
        errors.push(m.text());
    });
    await route.goto(`${urls["stylex-framework"]}/`, { waitUntil: "networkidle0" });
    await expect.poll(() => color(route)).toBe("rgb(10, 127, 62)");
    // StyleX's runtime disables its dev link before hydration; the fixture's root allows that.
    expect(errors).toEqual([]);

    const frame = await browser.newPage();
    await frame.goto(
      previews.frameUrl("stylex-framework", { kind: "file", file: "app/routes/home.tsx" }),
    );
    await expect.poll(() => color(frame)).toBe("rgb(10, 127, 62)");

    const home = path.join(roots["stylex-framework"], "app/routes/home.tsx");
    fs.writeFileSync(home, fs.readFileSync(home, "utf8").replace("#0a7f3e", "#123456"));
    for (const page of [route, frame])
      await expect.poll(() => color(page), { timeout: 15_000 }).toBe("rgb(18, 52, 86)");
    await route.close();
    await frame.close();
  }, 60_000);
});
