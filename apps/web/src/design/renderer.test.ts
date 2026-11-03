// @vitest-environment happy-dom
import "./wasm.node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { bitmapScale } from "./lod";
import { Replica } from "./replica";
import { Renderer } from "./renderer";
import type { Node } from "./schema";

// With a `window`, wasm.ts starts fetching the module as soon as it loads;
// `wasm.node` supplies it from disk instead, so the fetch is refused up front.
vi.hoisted(() => {
  globalThis.fetch = () => Promise.reject(new Error("tests load finite.wasm from disk"));
});

// Styles are compiled by a build step that tests don't run.
vi.mock("@stylexjs/stylex", () => ({
  create: (styles: unknown) => styles,
  props: () => ({ className: "" }),
}));
vi.mock("@/styles/tokens.stylex", () => ({ colors: {} }));

const SIZE = { width: 800, height: 1000 };
// Pixels a bitmap of an artboard holds at 10% zoom and a pixel ratio of 1.
const scaleAt = (zoom: number) => bitmapScale(SIZE.width, SIZE.height, 1, zoom);
const PIXELS = Math.round(SIZE.width * scaleAt(0.1)) * Math.round(SIZE.height * scaleAt(0.1));

const node = (id: string, parent: string | null, x = 0): Node => ({
  id,
  parent,
  index: "V",
  type: "element",
  tag: "div",
  name: null,
  text: null,
  x: parent === null ? x : null,
  y: parent === null ? 0 : null,
  styles: {},
  attrs: {},
});

/** The area around the artboard at `x`, with a margin of nothing. */
const around = (x: number) => ({ x, y: 0, width: SIZE.width, height: SIZE.height });

const frames = () => new Promise((r) => setTimeout(r, 50));

/** Stands in for the browser: no layout engine, so sizes come from here, and a rasterizer that waits to be told. */
function setup(ids: ReadonlyArray<string>, options: { budget?: number; script?: boolean } = {}) {
  const replica = new Replica();
  replica.load({
    meta: { id: "d", name: "D", createdAt: 0, updatedAt: 0 },
    seq: 0,
    nodes: [
      ...ids.map((id, i) => ({
        ...node(id, null, i * 100_000),
        index: String.fromCharCode(86 + i),
      })),
      node(`${ids[0]}-child`, ids[0]!),
      ...(options.script
        ? [{ ...node(`${ids[0]}-script`, ids[0]!), tag: "script", index: "W" }]
        : []),
    ],
    comments: [],
  });
  const world = document.createElement("div");
  document.body.append(world);
  const drawn: Array<{ html: string; finish: () => void; fail: (e: Error) => void }> = [];
  const renderer = new Renderer(world, replica, {
    live: true,
    ...(options.budget === undefined ? {} : { bitmapBudget: options.budget }),
    rasterize: (html, _css, width, height, scale) =>
      new Promise((resolve, reject) => {
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(width * scale);
        canvas.height = Math.round(height * scale);
        drawn.push({ html, finish: () => resolve(canvas), fail: reject });
      }),
  });
  renderer.reset();
  const frame = (id: string) => world.querySelector<HTMLElement>(`[data-artboard="${id}"]`)!;
  /** Lets the queued builds start and finish, which they do one at a time, until none are left. */
  const build = async () => {
    for (let idle = 0; idle < 3;) {
      await frames();
      const waiting = drawn.splice(0);
      for (const d of waiting) d.finish();
      idle = waiting.length === 0 ? idle + 1 : 0;
    }
  };
  return { replica, renderer, world, frame, drawn, build };
}

beforeEach(() => {
  // No layout engine: an artboard is as big as SIZE says, and a box is as wide as its inline width.
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get: () => SIZE.width,
  });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get: () => SIZE.height,
  });
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    const width = Number.parseFloat(this.style.width) || 0;
    const height = Number.parseFloat(this.style.height) || 0;
    return { left: 0, top: 0, right: width, bottom: height, x: 0, y: 0, width, height } as DOMRect;
  };
});

afterEach(() => {
  document.body.replaceChildren();
});

describe("bitmaps", () => {
  it("shows a bitmap in place of live DOM below the threshold, and live DOM above it", async () => {
    const t = setup(["a"]);
    t.renderer.setViewport(around(0), 0.1);
    await t.build();
    expect(t.frame("a").dataset.lod).toBe("bitmap");
    expect(t.frame("a").querySelector("canvas")).not.toBeNull();
    t.renderer.setViewport(around(0), 1);
    expect(t.frame("a").dataset.lod).toBeUndefined();
    expect(t.frame("a").querySelector("canvas")).toBeNull();
  });

  it("rebuilds a stale bitmap instead of showing it when the artboard was hidden at the edit", async () => {
    const t = setup(["a", "b"]);
    // Far zoomed out with only b in view: a is hidden once measured, and keeps its bitmap.
    t.renderer.setViewport({ x: -50_000, y: 0, width: 200_000, height: 1000 }, 0.1);
    await t.build();
    t.renderer.setViewport(around(100_000), 0.1);
    await frames();
    expect(t.frame("a").style.display).toBe("none");

    // An edit while hidden makes that bitmap out of date.
    t.renderer.apply(t.replica.apply({ op: "set", id: "a", key: "style:color", value: "red" })!);

    t.renderer.setViewport(around(0), 0.1);
    await frames();
    // It isn't shown stale: it's live DOM until the new bitmap is built.
    expect(t.frame("a").dataset.lod).toBeUndefined();
    await t.build();
    expect(t.frame("a").dataset.lod).toBe("bitmap");
  });

  it("keeps a current bitmap when the artboard comes back into view", async () => {
    const t = setup(["a", "b"]);
    t.renderer.setViewport({ x: -50_000, y: 0, width: 200_000, height: 1000 }, 0.1);
    await t.build();
    t.renderer.setViewport(around(100_000), 0.1);
    await frames();
    t.renderer.setViewport(around(0), 0.1);
    expect(t.frame("a").dataset.lod).toBe("bitmap");
    expect(t.drawn).toHaveLength(0);
  });

  it("drops a bitmap whose build finishes after the zoom crossed the threshold", async () => {
    const t = setup(["a"]);
    t.renderer.setViewport(around(0), 0.1);
    for (let i = 0; i < 40 && t.drawn.length < 1; i++) await frames();
    // Zoomed back in while the build is in flight: the artboard stays live.
    t.renderer.setViewport(around(0), 1);
    t.drawn[0]!.finish();
    await frames();
    expect(t.frame("a").dataset.lod).toBeUndefined();
    expect(t.frame("a").querySelector("canvas")).toBeNull();
    // Zooming out again uses the bitmap that finished, without drawing another.
    t.renderer.setViewport(around(0), 0.1);
    expect(t.frame("a").dataset.lod).toBe("bitmap");
  });

  it("ignores a bitmap built for an artboard that was edited meanwhile", async () => {
    const t = setup(["a"]);
    t.renderer.setViewport(around(0), 0.1);
    for (let i = 0; i < 40 && t.drawn.length < 1; i++) await frames();
    t.renderer.apply(t.replica.apply({ op: "set", id: "a", key: "style:color", value: "red" })!);
    t.drawn[0]!.finish();
    await frames();
    expect(t.frame("a").dataset.lod).toBeUndefined();
  });

  it("leaves an artboard live when the browser can't draw it, and doesn't retry until it's edited", async () => {
    const t = setup(["a"]);
    t.renderer.setViewport(around(0), 0.1);
    for (let i = 0; i < 40 && t.drawn.length < 1; i++) await frames();
    t.drawn.shift()!.fail(new Error("no"));
    await frames();
    t.renderer.setViewport(around(0), 0.1);
    t.renderer.setViewport(around(0), 0.1);
    await frames();
    expect(t.drawn).toHaveLength(0);
    expect(t.frame("a").dataset.lod).toBeUndefined();
  });

  it("draws a bitmap again, sharper, once the zoom outgrows it, and shows the old one meanwhile", async () => {
    const t = setup(["a"]);
    t.renderer.setViewport(around(0), 0.05);
    await t.build();
    const small = t.frame("a").querySelector("canvas")!;
    expect(small.width).toBe(Math.round(SIZE.width * scaleAt(0.05)));
    t.renderer.setViewport(around(0), 0.2);
    expect(t.frame("a").querySelector("canvas")).toBe(small);
    await t.build();
    const sharp = t.frame("a").querySelector("canvas")!;
    expect(sharp).not.toBe(small);
    expect(sharp.width).toBe(Math.round(SIZE.width * scaleAt(0.2)));
    expect(t.frame("a").dataset.lod).toBe("bitmap");
  });

  it("drops the bitmaps farthest from the view once they pass the budget", async () => {
    // Room for one bitmap and a half.
    const t = setup(["a", "b", "c"], { budget: PIXELS * 1.5 });
    const all = { x: -50_000, y: 0, width: 400_000, height: 1000 };
    t.renderer.setViewport(all, 0.1);
    await t.build();
    // Look at a: b and c are hidden, so they can go, c (farthest) first.
    t.renderer.setViewport({ x: 0, y: 0, width: 800, height: 1000 }, 0.1);
    await frames();
    const held = Number(t.world.dataset.bitmapPixels);
    expect(held).toBeLessThanOrEqual(PIXELS * 1.5);
    expect(t.frame("a").dataset.lod).toBe("bitmap");
    expect(t.frame("c").querySelector("canvas")).toBeNull();
  });
});

describe("a bitmapped artboard", () => {
  it("answers a hit test with the artboard, not a node in its hidden DOM", async () => {
    const t = setup(["a"]);
    t.renderer.setViewport(around(0), 0.1);
    await t.build();
    expect(t.renderer.hitTest(10, 10)).toEqual({ artboardId: "a", nodeId: "a" });
  });

  it("reports the artboard's box for a node inside it", async () => {
    const t = setup(["a"]);
    t.renderer.setViewport(around(0), 0.1);
    await t.build();
    const rect = t.renderer.nodeRect("a-child");
    expect([rect?.width, rect?.height]).toEqual([SIZE.width, SIZE.height]);
  });

  it("reports a node's own box again once the artboard is live", async () => {
    const t = setup(["a"]);
    t.renderer.setViewport(around(0), 0.1);
    await t.build();
    t.renderer.setViewport(around(0), 1);
    // The stub gives an element without an inline size no box.
    expect(t.renderer.nodeRect("a-child")?.width).toBe(0);
  });

  it("frees the bitmaps when the zoom goes back above the threshold", async () => {
    const t = setup(["a"]);
    t.renderer.setViewport(around(0), 0.1);
    await t.build();
    expect(Number(t.world.dataset.bitmapPixels)).toBeGreaterThan(0);
    t.renderer.setViewport(around(0), 1);
    expect(t.world.dataset.bitmapPixels).toBe("0");
  });

  it("keeps an artboard with a script live, since its script output isn't in the HTML", async () => {
    const t = setup(["a"], { script: true });
    t.renderer.setViewport(around(0), 0.1);
    await t.build();
    expect(t.drawn).toHaveLength(0);
    expect(t.frame("a").dataset.lod).toBeUndefined();
    expect(t.frame("a").querySelector("canvas")).toBeNull();
    expect(t.frame("a").querySelector("iframe")?.srcdoc).not.toBe("");
  });
});
