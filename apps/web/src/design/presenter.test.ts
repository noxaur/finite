import { describe, expect, it } from "vite-plus/test";
import { spring } from "./camera";
import { presentationOf } from "./presenter";

const free = { x: 0, y: 0, width: 1200, height: 800 };

describe("presentationOf", () => {
  it("shows a small artboard at 100%, centered in the free area", () => {
    const { view, window } = presentationOf({ x: 100, y: 50, width: 390, height: 600 }, free);
    expect(view.zoom).toBe(1);
    expect(window).toBeNull();
    expect(view.x + 100 + 390 / 2).toBe(600);
    expect(view.y + 50 + 600 / 2).toBe(400);
  });

  it("scales a large artboard down to fit, and never above 100%", () => {
    const { view, window } = presentationOf({ x: 0, y: 0, width: 1440, height: 900 }, free);
    expect(view.zoom).toBeCloseTo((1200 - 64) / 1440);
    expect(window).toBeNull();
  });

  it("fits a tall artboard by width, its top at the top, scrolling in a window", () => {
    const { view, window } = presentationOf({ x: 0, y: 0, width: 1440, height: 5000 }, free);
    expect(view.zoom).toBeCloseTo((1200 - 64) / 1440);
    expect(view.y).toBe(32);
    expect(window).toBe(Math.floor((800 - 64) / view.zoom));
  });

  it("uses only the free area, beside sidebars", () => {
    const beside = { x: 240, y: 0, width: 960, height: 800 };
    const { view } = presentationOf({ x: 0, y: 0, width: 390, height: 600 }, beside);
    expect(view.x + 390 / 2).toBe(240 + 480);
  });
});

describe("spring", () => {
  it("starts at 0, settles at 1, and overshoots only a little", () => {
    expect(spring(0)).toBe(0);
    expect(spring(1)).toBe(1);
    const peak = Math.max(...Array.from({ length: 100 }, (_, i) => spring(i / 100)));
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThan(1.05);
    expect(Math.abs(spring(0.99) - 1)).toBeLessThan(0.01);
  });
});
