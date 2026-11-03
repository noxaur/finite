import { describe, expect, it } from "vite-plus/test";
import { ArtboardIndex, overlaps, visibleBounds } from "./culling";

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
});
