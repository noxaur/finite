import { describe, expect, it } from "vite-plus/test";
import { mostVisible } from "./camera";

const view = { x: 0, y: 0, width: 1000, height: 800 };

describe("mostVisible", () => {
  it("picks the artboard covering the most of the view", () => {
    const bounds = new Map([
      ["left", { x: -900, y: 0, width: 1000, height: 800 }],
      ["middle", { x: 200, y: 100, width: 600, height: 600 }],
    ]);
    expect(mostVisible(bounds, view)).toBe("middle");
  });

  it("counts only the part inside the view", () => {
    const bounds = new Map([
      ["huge", { x: 900, y: 0, width: 5000, height: 5000 }],
      ["small", { x: 0, y: 0, width: 300, height: 300 }],
    ]);
    expect(mostVisible(bounds, view)).toBe("small");
  });

  it("returns null when no artboard is in view", () => {
    const bounds = new Map([["away", { x: 2000, y: 2000, width: 100, height: 100 }]]);
    expect(mostVisible(bounds, view)).toBeNull();
    expect(mostVisible(new Map(), view)).toBeNull();
  });
});
