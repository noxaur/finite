import { describe, expect, it } from "vite-plus/test";
import { ArtboardIndex, Culler, overlaps, pageBox, visibleBounds } from "./culling";

const box = (x: number, y: number, width = 100, height = 100) => ({ x, y, width, height });

describe("visibleBounds", () => {
  it("grows the viewport by the margin on every side, in canvas pixels", () => {
    // Panned 200 right and 100 down at 2x: the canvas point (-100, -50) is at the corner.
    const area = visibleBounds({ x: 200, y: 100, zoom: 2 }, 800, 600, 0.5);
    expect(area).toEqual({ x: -100 - 200, y: -50 - 150, width: 800, height: 600 });
  });

  it("covers more of the canvas when zoomed out", () => {
    const area = visibleBounds({ x: -100, y: -50, zoom: 0.1 }, 1000, 500, 0);
    expect(area).toEqual({ x: 1000, y: 500, width: 10_000, height: 5000 });
  });
});

describe("overlaps", () => {
  it("is false for boxes that only touch", () => {
    expect(overlaps(box(0, 0), box(100, 0))).toBe(false);
    expect(overlaps(box(0, 0), box(99, 99))).toBe(true);
  });
});

describe("ArtboardIndex", () => {
  it("finds the artboards that overlap an area, and no others", () => {
    const index = new ArtboardIndex();
    index.set("a", box(0, 0));
    index.set("b", box(5000, 0));
    index.set("c", box(0, 9000, 100, 3000));
    expect(index.query(box(-50, -50, 200, 200))).toEqual(new Set(["a"]));
    expect(index.query(box(0, 0, 6000, 10_000))).toEqual(new Set(["a", "b", "c"]));
    expect(index.query(box(0, 11_000, 10, 10))).toEqual(new Set(["c"]));
    expect(index.query(box(2000, 2000, 500, 500))).toEqual(new Set());
  });

  it("finds an artboard spanning several cells from any of them", () => {
    const index = new ArtboardIndex();
    index.set("wide", box(0, 0, 10_000, 100));
    expect(index.query(box(9000, 0, 10, 10))).toEqual(new Set(["wide"]));
  });

  it("moves and removes artboards", () => {
    const index = new ArtboardIndex();
    index.set("a", box(0, 0));
    index.set("a", box(8000, 8000));
    expect(index.query(box(0, 0, 50, 50))).toEqual(new Set());
    expect(index.query(box(8000, 8000, 50, 50))).toEqual(new Set(["a"]));
    index.delete("a");
    expect(index.query(box(8000, 8000, 50, 50))).toEqual(new Set());
    expect(index.get("a")).toBeUndefined();
  });

  it("handles negative coordinates", () => {
    const index = new ArtboardIndex();
    index.set("a", box(-3000, -3000));
    expect(index.query(box(-3050, -3050, 100, 100))).toEqual(new Set(["a"]));
    expect(index.query(box(0, 0, 100, 100))).toEqual(new Set());
  });

  it("answers a query over thousands of cells without walking them", () => {
    const index = new ArtboardIndex();
    for (let i = 0; i < 240; i++) index.set(`b${i}`, box(i * 900, 0, 800, 1000));
    // Zoomed far out: 4 million canvas pixels wide is about 2,000 cells across.
    const found = index.query(box(-1_000_000, -1_000_000, 4_000_000, 4_000_000));
    expect(found.size).toBe(240);
    expect(index.query(box(0, 5000, 4_000_000, 10)).size).toBe(0);
  });
});

/** A host with settable sizes, that records what the culler did. */
function setup(sizes: Record<string, { width: number; height: number } | null>) {
  const culled = new Set<string>();
  const measured: string[] = [];
  const queue: Array<() => void> = [];
  const culler = new Culler(
    {
      measure: (id) => {
        measured.push(id);
        return sizes[id] ?? null;
      },
      setCulled: (id, value) => void (value ? culled.add(id) : culled.delete(id)),
    },
    (run) => queue.push(run),
  );
  /** Runs the passes scheduled so far, as frames would. */
  const frame = () => {
    for (let run = queue.shift(); run; run = queue.shift()) run();
  };
  return { culler, culled, measured, sizes, frame, queue };
}

const view = box(0, 0, 1000, 1000);

describe("Culler", () => {
  it("hides artboards outside the area once they're measured, and not before", () => {
    const t = setup({ near: { width: 500, height: 500 }, far: { width: 500, height: 500 } });
    t.culler.add("near", 0, 0);
    t.culler.add("far", 9000, 0);
    t.culler.setArea(view);
    expect(t.culled.size).toBe(0);
    t.frame();
    expect([...t.culled]).toEqual(["far"]);
    expect(t.culler.isCulled("far")).toBe(true);
    expect(t.culler.isCulled("near")).toBe(false);
  });

  it("runs one pass per frame however many things change", () => {
    const t = setup({ a: { width: 10, height: 10 } });
    t.culler.add("a", 0, 0);
    t.culler.setArea(view);
    for (let i = 0; i < 50; i++) t.culler.setArea(box(i, 0, 1000, 1000));
    t.culler.touch("a");
    expect(t.queue.length).toBe(1);
    t.frame();
    expect(t.measured).toEqual(["a"]);
  });

  it("does nothing without an area, and shows everything again when it's cleared", () => {
    const t = setup({ far: { width: 10, height: 10 } });
    t.culler.add("far", 9000, 0);
    t.culler.touch("far");
    expect(t.queue.length).toBe(0);
    t.culler.setArea(view);
    t.frame();
    expect(t.culled.has("far")).toBe(true);
    t.culler.setArea(null);
    t.frame();
    expect(t.culled.size).toBe(0);
  });

  it("keeps the measured size of a hidden artboard", () => {
    const t = setup({ far: { width: 600, height: 900 } });
    t.culler.add("far", 9000, 100);
    t.culler.setArea(view);
    t.frame();
    expect(t.culler.size("far")).toEqual({ width: 600, height: 900 });
    expect(t.culler.box("far")).toEqual({ x: 9000, y: 100, width: 600, height: 900 });
  });

  it("measures an artboard again when it's edited while hidden, once it's shown", () => {
    const t = setup({ far: { width: 600, height: 900 } });
    t.culler.add("far", 9000, 0);
    t.culler.setArea(view);
    t.frame();
    t.sizes.far = { width: 600, height: 1500 };
    t.culler.touch("far");
    t.frame();
    // Hidden, so it isn't laid out and isn't measured.
    expect(t.culler.size("far")?.height).toBe(900);
    t.culler.setArea(box(8500, 0, 1000, 1000));
    t.frame();
    expect(t.culled.size).toBe(0);
    t.frame();
    expect(t.culler.size("far")?.height).toBe(1500);
  });

  it("hides what a taller artboard no longer fits after it grows (auto height)", () => {
    const t = setup({ a: { width: 500, height: 400 }, b: { width: 500, height: 400 } });
    t.culler.add("a", 0, 0);
    t.culler.add("b", 0, 1100);
    t.culler.setArea(view);
    t.frame();
    expect(t.culled.has("b")).toBe(true);
    // Late content (an image) makes `a` fill the view; `b` is measured as shown below it.
    t.sizes.a = { width: 500, height: 3000 };
    t.sizes.b = { width: 500, height: 400 };
    t.culler.touch("a");
    t.frame();
    expect(t.culler.size("a")?.height).toBe(3000);
    // The grown box now overlaps a view further down, which shows it.
    t.culler.setArea(box(0, 2500, 1000, 1000));
    t.frame();
    expect(t.culled.has("a")).toBe(false);
  });

  it("shows an artboard that was measured small and then grows into the view", () => {
    const t = setup({ a: { width: 500, height: 100 } });
    t.culler.add("a", 0, 0);
    t.culler.setArea(box(0, 500, 1000, 1000));
    t.frame();
    expect(t.culled.has("a")).toBe(true);
    // It is hidden so it can't be re-measured; moving the area back shows it.
    t.culler.setArea(view);
    t.frame();
    expect(t.culled.has("a")).toBe(false);
  });

  it("moves a hidden artboard: its box follows, and it shows if it lands in view", () => {
    const t = setup({ a: { width: 500, height: 500 } });
    t.culler.add("a", 9000, 0);
    t.culler.setArea(view);
    t.frame();
    expect(t.culled.has("a")).toBe(true);
    t.culler.move("a", 100, 100);
    expect(t.culler.box("a")).toEqual({ x: 100, y: 100, width: 500, height: 500 });
    t.frame();
    expect(t.culled.has("a")).toBe(false);
  });

  it("forgets artboards that leave, as when the page changes", () => {
    const t = setup({ a: { width: 500, height: 500 }, b: { width: 500, height: 500 } });
    t.culler.add("a", 0, 0);
    t.culler.setArea(view);
    t.frame();
    t.culler.clear();
    t.culler.add("b", 0, 0);
    t.frame();
    expect(t.culler.box("a")).toBeUndefined();
    expect(t.culler.box("b")).toBeDefined();
    t.culler.remove("b");
    expect(t.culler.box("b")).toBeUndefined();
    expect(t.culler.isCulled("b")).toBe(false);
  });

  it("keeps an artboard shown while it has no layout", () => {
    const t = setup({ a: null });
    t.culler.add("a", 9000, 0);
    t.culler.setArea(view);
    t.frame();
    expect(t.culled.size).toBe(0);
  });
});

describe("pageBox", () => {
  it("maps a hidden artboard's box to the page, not to the origin", () => {
    // 2x zoom, panned by (10, 20) on a viewport that starts at (5, 5).
    const toPage = (x: number, y: number) => ({ x: 5 + 10 + x * 2, y: 5 + 20 + y * 2 });
    const rect = pageBox(box(1000, 500, 300, 200), toPage);
    expect(rect).toEqual({ x: 2015, y: 1025, width: 600, height: 400 });
  });
});
