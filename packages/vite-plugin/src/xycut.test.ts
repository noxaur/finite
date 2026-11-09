import { describe, expect, test } from "vite-plus/test";
import { type Cut, xyCut } from "./client/bridge.ts";

const rect = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });
const summary = (cuts: Cut[]) => cuts.map((c) => [c.axis, c.size, ...c.between]);
const sorted = (rows: (string | number)[][]) =>
  rows.map((row) => row.join(" ")).sort((a, b) => a.localeCompare(b));

describe("xyCut", () => {
  test("has nothing to cut in empty or single input", () => {
    expect(xyCut([])).toEqual([]);
    expect(xyCut([rect(0, 0, 10, 10)])).toEqual([]);
  });

  test("flex row", () => {
    const cuts = xyCut([rect(0, 0, 40, 20), rect(48, 0, 40, 30), rect(96, 5, 40, 10)]);
    expect(summary(cuts)).toEqual([
      ["x", 8, 0, 1],
      ["x", 8, 1, 2],
    ]);
    expect(cuts[0]?.rect).toEqual(rect(40, 0, 8, 30));
  });

  test("flex column", () => {
    const cuts = xyCut([rect(0, 0, 40, 20), rect(0, 32, 40, 20), rect(0, 64, 40, 20)]);
    expect(summary(cuts)).toEqual([
      ["y", 12, 0, 1],
      ["y", 12, 1, 2],
    ]);
    expect(cuts[1]?.rect).toEqual(rect(0, 52, 40, 12));
  });

  test("flex wrap: the rows, then each row", () => {
    const cuts = xyCut([
      rect(0, 0, 40, 20),
      rect(48, 0, 40, 20),
      rect(96, 0, 40, 20),
      rect(0, 32, 40, 20),
      rect(48, 32, 40, 20),
    ]);
    expect(summary(cuts)).toEqual([
      ["y", 12, 0, 3],
      ["x", 8, 0, 1],
      ["x", 8, 1, 2],
      ["x", 8, 3, 4],
    ]);
    expect(cuts[0]?.rect).toEqual(rect(0, 20, 136, 12));
  });

  test("grid", () => {
    const cells = [0, 1, 2, 3].map((i) => rect((i % 2) * 110, Math.floor(i / 2) * 58, 100, 50));
    expect(summary(xyCut(cells))).toEqual([
      ["y", 8, 0, 2],
      ["x", 10, 0, 1],
      ["x", 10, 2, 3],
    ]);
  });

  test("grid with a cell spanning two rows beside a 2-up column", () => {
    const cuts = xyCut([rect(0, 0, 100, 108), rect(110, 0, 100, 50), rect(110, 58, 100, 50)]);
    expect(summary(cuts)).toEqual([
      ["x", 10, 0, 1],
      ["y", 8, 1, 2],
    ]);
  });

  describe("pinwheel grid, where a spanning cell blocks every channel", () => {
    const cells = [
      rect(0, 0, 210, 50), // A spans two columns
      rect(220, 0, 100, 108), // B spans two rows
      rect(110, 116, 210, 50), // C spans two columns
      rect(0, 58, 100, 108), // D spans two rows
      rect(110, 58, 100, 50), // E is the middle cell
    ];
    const cuts = xyCut(cells);

    test("falls back to nearest neighbours", () => {
      expect(sorted(summary(cuts))).toEqual(
        sorted([
          ["x", 10, 3, 4],
          ["x", 10, 4, 1],
          ["x", 10, 0, 1],
          ["x", 10, 3, 2],
          ["y", 8, 0, 3],
          ["y", 8, 0, 4],
          ["y", 8, 1, 2],
          ["y", 8, 4, 2],
        ]),
      );
    });

    test("names each pair once", () => {
      const pairs = cuts.map((c) => c.between.join("-"));
      expect(new Set(pairs).size).toBe(pairs.length);
    });

    test("draws the strip over the two cells' shared span only", () => {
      const strip = cuts.find((c) => c.between[0] === 0 && c.between[1] === 1);
      expect(strip?.rect).toEqual(rect(210, 0, 10, 50));
    });
  });

  test("a neighbour with a third rect in the strip isn't a gap", () => {
    // The last rect spans every row and the rest chain across every column, so no channel exists.
    const cuts = xyCut([
      rect(0, 0, 50, 100),
      rect(40, 40, 30, 20), // pokes out of the first rect into the strip beside it
      rect(65, 99.7, 50, 70),
      rect(100, 0, 50, 300),
    ]);
    expect(cuts.find((c) => c.between[0] === 0 && c.between[1] === 3)).toBeUndefined();
  });

  test("a column of alternating left and right aligned children", () => {
    const cuts = xyCut([rect(0, 0, 80, 20), rect(120, 30, 80, 20), rect(0, 60, 80, 20)]);
    expect(summary(cuts)).toEqual([
      ["y", 10, 0, 1],
      ["y", 10, 1, 2],
    ]);
  });

  test("a block stack measures the distances its margins left", () => {
    expect(
      summary(xyCut([rect(0, 0, 100, 40), rect(0, 64, 100, 40), rect(0, 120, 100, 40)])),
    ).toEqual([
      ["y", 24, 0, 1],
      ["y", 16, 1, 2],
    ]);
  });

  test("space-between", () => {
    expect(
      summary(xyCut([rect(0, 0, 40, 20), rect(130, 0, 40, 20), rect(260, 0, 40, 20)])),
    ).toEqual([
      ["x", 90, 0, 1],
      ["x", 90, 1, 2],
    ]);
  });

  test("overlapping rects produce no cut", () => {
    expect(xyCut([rect(0, 0, 50, 50), rect(25, 25, 50, 50)])).toEqual([]);
    expect(xyCut([rect(0, 0, 50, 50), rect(0, 0, 50, 50)])).toEqual([]);
  });

  test("touching rects are a cut of size 0", () => {
    const cuts = xyCut([rect(0, 0, 50, 20), rect(50, 0, 50, 20)]);
    expect(summary(cuts)).toEqual([["x", 0, 0, 1]]);
  });

  test("a sub-pixel overlap from layout rounding still touches", () => {
    expect(summary(xyCut([rect(0, 0, 33.34, 20), rect(33.33, 0, 33.34, 20)]))).toEqual([
      ["x", 0, 0, 1],
    ]);
  });

  test("rounds fractional gaps to 2 decimals", () => {
    const cuts = xyCut([rect(0, 0, 10.1, 20), rect(10.33, 0, 10, 20)]);
    expect(cuts[0]?.size).toBe(0.23);
    expect(cuts[0]?.rect.x).toBe(10.1);
    expect(cuts[0]?.rect.width).toBe(0.23);
  });
});
