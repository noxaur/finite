import { describe, expect, it } from "vite-plus/test";
import { clampInside } from "./geometry.ts";

describe("clampInside", () => {
  const bounds = { width: 300, height: 200 };

  it("keeps a box inside both bounds", () => {
    expect(clampInside({ x: -20, y: 190, width: 100, height: 50 }, bounds)).toEqual({
      x: 0,
      y: 150,
      width: 100,
      height: 50,
    });
    expect(clampInside({ x: 250, y: 0, width: 100, height: 10 }, bounds)).toEqual({
      x: 200,
      y: 0,
      width: 100,
      height: 24,
    });
    expect(clampInside({ x: 0, y: 0, width: 900, height: 900 }, bounds)).toEqual({
      x: 0,
      y: 0,
      width: 300,
      height: 200,
    });
  });

  it("shifts a slice left when its frame was narrowed, instead of squeezing it to a sliver", () => {
    expect(
      clampInside({ x: 300, y: 0, width: 100, height: 50 }, { width: 200, height: 200 }),
    ).toEqual({
      x: 100,
      y: 0,
      width: 100,
      height: 50,
    });
  });

  it("leaves the vertical bounds open for an infinite height", () => {
    expect(
      clampInside({ x: 10, y: 900, width: 50, height: 40 }, { width: 100, height: Infinity }),
    ).toEqual({ x: 10, y: 900, width: 50, height: 40 });
  });
});
