/// <reference lib="dom" />
// The DOM types are for the code these tests run in Chrome.

import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Design, Previews } from "@finite/protocol";
import type { Browser, Page } from "puppeteer-core";
import { afterAll, beforeAll } from "vite-plus/test";
import {
  closeChrome,
  LAUNCH_HOOK_TIMEOUT_MS,
  prepareFixture,
  sharedChrome,
  viewed,
  warmChrome,
} from "./fixtures.ts";
import { createPreviews } from "./index.ts";

export type FixtureName =
  | "rr-spa"
  | "rr-framework"
  | "tanstack"
  | "next-app"
  | "next-pages"
  | "next-webpack";

const CONFIGS: Record<FixtureName, Pick<Design, "router" | "styling" | "css">> = {
  "rr-spa": { router: "react-router", styling: "tailwind", css: ["src/index.css"] },
  "rr-framework": { router: "react-router", styling: "inline", css: [] },
  tanstack: { router: "tanstack", styling: "inline", css: [] },
  "next-app": { router: "next-app", styling: "tailwind", css: ["app/globals.css"] },
  "next-pages": { router: "next-pages", styling: "css-modules", css: ["src/styles/globals.css"] },
  "next-webpack": { router: "next-app", styling: "tailwind", css: ["app/globals.css"] },
};

/** A connected design that runs `fixture`'s project from `root`, under the id `id`. */
export function designOf(fixture: FixtureName, root: string, id: string = fixture): Design {
  return {
    id,
    name: id,
    root,
    origin: "connected",
    ...CONFIGS[fixture],
    brandDir: "src/assets/brand",
  };
}

export async function get(url: string, accept = "text/html") {
  const response = await fetch(url, { headers: { accept } });
  return { status: response.status, text: await response.text() };
}

/**
 * Previews for a test file, closed after it, and a `prepare` that installs a fixture into a
 * folder of its own and deletes it with the file. The copies are deleted side by side, since
 * deleting a `node_modules` takes seconds.
 */
export function previewHarness() {
  const previews: Previews = viewed(createPreviews({ host: "127.0.0.1", graceMs: 100 }));
  const removals: (() => Promise<void>)[] = [];

  afterAll(async () => {
    await previews.close();
    await Promise.all(removals.map((remove) => remove()));
  }, 120_000);

  async function prepare(fixture: string, options: { install?: boolean } = {}) {
    const prepared = await prepareFixture(fixture, options);
    removals.push(prepared.remove);
    return prepared;
  }

  return { previews, prepare };
}

/**
 * Fixtures that every test in a file reads, each installed and previewed once in `beforeAll`
 * (side by side, with the file's Chrome launching beside them). `setup` runs first, to listen
 * for events before a preview starts.
 */
export function sharedPreviews<N extends FixtureName>(
  names: readonly N[],
  setup: (previews: Previews) => void = () => {},
) {
  const harness = previewHarness();
  const roots = {} as Record<N, string>;
  const urls = {} as Record<N, string>;

  beforeAll(async () => {
    warmChrome();
    setup(harness.previews);
    await Promise.all(
      names.map(async (name) => {
        const fixture = await harness.prepare(name);
        roots[name] = fixture.root;
        urls[name] = (await harness.previews.ensure(designOf(name, fixture.root))).url;
      }),
    );
  }, 240_000);

  return { ...harness, roots, urls };
}

/** The parent page's half of the bridge handshake, for a frame to connect to. */
export const PARENT = `<!doctype html><html><body style="margin:0">
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

/**
 * Chrome and a parent page served on loopback like the Finite shell, for the tests of a
 * `describeChrome` block. `open` loads a frame URL in an iframe of the parent and waits for the
 * bridge to connect.
 */
export function bridgeChrome() {
  let browser: Browser;
  let parentServer: http.Server;
  let parentUrl: string;

  beforeAll(async () => {
    browser = await sharedChrome();
    parentServer = http.createServer((_, res) => {
      res.setHeader("content-type", "text/html");
      res.end(PARENT);
    });
    await new Promise<void>((resolve) => parentServer.listen(0, "127.0.0.1", resolve));
    parentUrl = `http://127.0.0.1:${(parentServer.address() as AddressInfo).port}/`;
  }, LAUNCH_HOOK_TIMEOUT_MS);

  afterAll(async () => {
    parentServer?.close();
    await closeChrome();
  }, 30_000);

  async function open(src: string, selector = "[data-finite-loc]") {
    const page = await browser.newPage();
    await page.setViewport({ width: 800, height: 600 });
    await page.goto(parentUrl);
    await page.evaluate((url) => {
      (document.getElementById("frame") as HTMLIFrameElement).src = url;
    }, src);
    await page.waitForFunction(
      () => (window as unknown as { bridge: { port: unknown } }).bridge.port,
      { timeout: 30_000 },
    );
    const frame = page
      .frames()
      .find((f) => f !== page.mainFrame() && f.url().startsWith(new URL(src).origin))!;
    await frame.waitForSelector(selector, { timeout: 30_000 });
    return { page, frame };
  }

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

  return { browser: () => browser, open, ask, bridgeEvents };
}
