import { describe, expect, it } from "vite-plus/test";
import {
  autoLayoutStyles,
  barelyMoved,
  boundsOf,
  changedPadding,
  draggedPadding,
  draggedZoom,
  gapBands,
  inferAutoLayout,
  movedInsets,
  paddingStyles,
  reorderShifts,
  wrapperTagFor,
} from "./autoLayout";

const box = (x: number, y: number, width = 40, height = 40) => ({ x, y, width, height });
const zero = { top: 0, right: 0, bottom: 0, left: 0 };

describe("inferAutoLayout", () => {
  const parent = box(0, 0, 400, 400);

  it("reads a row and the gap between its boxes", () => {
    const rects = [box(100, 10), box(10, 10), box(200, 10)];
    const inferred = inferAutoLayout(rects, boundsOf(rects));
    expect(inferred.direction).toBe("row");
    expect(inferred.order).toEqual([1, 0, 2]);
    expect(inferred.gap).toBe(50);
    expect(inferred.padding).toEqual(zero);
  });

  it("reads a column", () => {
    const rects = [box(10, 100), box(10, 10), box(10, 190)];
    const inferred = inferAutoLayout(rects, boundsOf(rects));
    expect(inferred.direction).toBe("column");
    expect(inferred.order).toEqual([1, 0, 2]);
    expect(inferred.gap).toBe(50);
  });

  it("takes the median gap, ignoring one outlier", () => {
    const rects = [box(0, 0), box(50, 0), box(100, 0), box(300, 0)];
    expect(inferAutoLayout(rects, boundsOf(rects)).gap).toBe(10);
  });

  it("clamps overlapping boxes' gap to zero", () => {
    const rects = [box(0, 0), box(30, 0), box(60, 0)];
    expect(inferAutoLayout(rects, boundsOf(rects)).gap).toBe(0);
  });

  it("breaks a diagonal's tie by the wider span", () => {
    expect(inferAutoLayout([box(0, 0), box(100, 50)], parent).direction).toBe("row");
    expect(inferAutoLayout([box(0, 0), box(50, 100)], parent).direction).toBe("column");
  });

  it("measures padding as the room around the boxes", () => {
    expect(inferAutoLayout([box(10, 20), box(60, 20)], box(0, 0, 200, 100)).padding).toEqual({
      top: 20,
      right: 100,
      bottom: 40,
      left: 10,
    });
  });

  it("reads how a row's boxes line up across it", () => {
    const top = [box(0, 0, 40, 20), box(50, 0, 40, 40)];
    const center = [box(0, 10, 40, 20), box(50, 0, 40, 40)];
    const bottom = [box(0, 20, 40, 20), box(50, 0, 40, 40)];
    const same = [box(0, 0, 40, 40), box(50, 0, 40, 40)];
    expect(inferAutoLayout(top, boundsOf(top)).align).toBe("flex-start");
    expect(inferAutoLayout(center, boundsOf(center)).align).toBe("center");
    expect(inferAutoLayout(bottom, boundsOf(bottom)).align).toBe("flex-end");
    expect(inferAutoLayout(same, boundsOf(same)).align).toBe("stretch");
  });

  it("gives one box in a container its room as padding", () => {
    const inferred = inferAutoLayout([box(16, 8, 100, 40)], box(0, 0, 132, 56));
    expect(inferred).toMatchObject({ direction: "row", gap: 0 });
    expect(inferred.padding).toEqual({ top: 8, right: 16, bottom: 8, left: 16 });
    expect(inferred.align).toBe("flex-start");
  });

  it("stretches a box that fills the container, and handles none", () => {
    expect(inferAutoLayout([box(0, 0, 100, 40)], box(0, 0, 100, 40)).align).toBe("stretch");
    expect(inferAutoLayout([], parent)).toMatchObject({ gap: 0, padding: zero, order: [] });
  });
});

describe("the styles", () => {
  it("writes only what's set", () => {
    expect(
      autoLayoutStyles({
        direction: "column",
        gap: 0,
        padding: zero,
        align: "stretch",
        order: [],
      }),
    ).toEqual({ display: "flex", "flex-direction": "column" });
    expect(
      autoLayoutStyles({
        direction: "row",
        gap: 12,
        padding: { top: 8, right: 8, bottom: 8, left: 8 },
        align: "center",
        order: [],
      }),
    ).toEqual({
      display: "flex",
      "flex-direction": "row",
      gap: "12px",
      padding: "8px",
      "align-items": "center",
    });
  });

  it("writes padding per side only when the sides differ, and skips zeros", () => {
    expect(paddingStyles({ top: 0, right: 0, bottom: 8, left: 0 })).toEqual({
      "padding-bottom": "8px",
    });
    expect(paddingStyles({ top: 1, right: 2, bottom: 3, left: 4 })).toEqual({
      "padding-top": "1px",
      "padding-right": "2px",
      "padding-bottom": "3px",
      "padding-left": "4px",
    });
    expect(changedPadding(zero, { ...zero, left: 4 })).toEqual({ "padding-left": "4px" });
  });

  it("wraps in a span where a div can't go, and refuses where nothing can", () => {
    expect(wrapperTagFor("main")).toBe("div");
    expect(wrapperTagFor(undefined)).toBe("div");
    expect(wrapperTagFor("p")).toBe("span");
    expect(wrapperTagFor("ul")).toBeNull();
    expect(wrapperTagFor("svg")).toBeNull();
  });
});

describe("the gestures", () => {
  const start = { top: 10, right: 20, bottom: 30, left: 40 };

  it("moves one side, then both with Alt, and all with Shift", () => {
    const plain = { alt: false, shift: false };
    expect(draggedPadding(start, "left", 5, plain)).toEqual({ ...start, left: 45 });
    expect(draggedPadding(start, "left", -100, plain).left).toBe(0);
    expect(draggedPadding(start, "top", 2, { alt: true, shift: false })).toEqual({
      ...start,
      top: 12,
      bottom: 12,
    });
    expect(draggedPadding(start, "right", 4, { alt: false, shift: true })).toEqual({
      top: 24,
      right: 24,
      bottom: 24,
      left: 24,
    });
  });

  it("places a band between neighbors", () => {
    expect(gapBands([box(0, 0, 40, 40), box(50, 10, 40, 20)], "x")).toEqual([
      { x: 40, y: 0, width: 10, height: 40 },
    ]);
    expect(gapBands([box(0, 0, 40, 40), box(0, 50, 60, 40)], "y")).toEqual([
      { x: 0, y: 40, width: 60, height: 10 },
    ]);
    expect(gapBands([box(0, 0)], "x")).toEqual([]);
  });

  it("slides siblings out of the way of a reorder", () => {
    const siblings = [
      { loc: "a", rect: box(0, 0, 40, 40) },
      { loc: "b", rect: box(50, 0, 40, 40) },
      { loc: "c", rect: box(100, 0, 40, 40) },
    ];
    expect(reorderShifts("a", siblings, "c", "x")).toEqual({ b: -50 });
    expect(reorderShifts("a", siblings, null, "x")).toEqual({ b: -50, c: -50 });
    expect(reorderShifts("c", siblings, "a", "x")).toEqual({ a: 50, b: 50 });
    expect(reorderShifts("a", siblings, undefined, "x")).toEqual({});
  });

  it("scales from a handle, never to nothing", () => {
    const r = box(0, 0, 100, 100);
    expect(draggedZoom(r, "se", { x: 50, y: 0 }, 1)).toBe(1.5);
    expect(draggedZoom(r, "nw", { x: 50, y: 50 }, 1)).toBe(0.5);
    expect(draggedZoom(r, "e", { x: 100, y: 0 }, 2)).toBe(4);
    expect(draggedZoom(r, "se", { x: -500, y: -500 }, 1)).toBe(0.05);
  });

  it("moves by insets, in the element's own zoom", () => {
    expect(movedInsets({ left: 10, top: 20, zoom: 1 }, { x: 5, y: -5 })).toEqual({
      left: "15px",
      top: "15px",
      right: null,
      bottom: null,
    });
    expect(movedInsets({ left: 0, top: 0, zoom: 2 }, { x: 10, y: 4 })).toMatchObject({
      left: "5px",
      top: "2px",
    });
    expect(barelyMoved({ x: 0.2, y: 0.1 })).toBe(true);
    expect(barelyMoved({ x: 3, y: 0 })).toBe(false);
  });
});
