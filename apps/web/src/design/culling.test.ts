import { describe, expect, it } from "vite-plus/test";
import { overlaps, visibleBounds } from "./culling";

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
