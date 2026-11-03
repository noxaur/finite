import { describe, expect, it } from "vite-plus/test";
import type { Node } from "../schema";
import { type Facts, flowOf, moveAbsolute, moveArtboards, resize, slotBefore } from "./geometry";

const node = (styles: Record<string, string> = {}): Node => ({
  id: "n",
  parent: "board",
  index: "V",
  type: "element",
  tag: "div",
  name: null,
  text: null,
  x: null,
  y: null,
  styles,
  attrs: {},
});

const facts = (patch: Partial<Facts> = {}): Facts => ({
  position: "absolute",
  left: 10,
  top: 20,
  right: 70,
  bottom: 60,
  rect: { left: 0, top: 0, right: 40, bottom: 40, width: 40, height: 40 },
  scale: 2,
  ...patch,
});

describe("moving", () => {
  it("moves artboards to whole pixels", () => {
    expect(moveArtboards([{ id: "a", x: 10, y: 10 }], { x: 4.6, y: -2.2 })).toEqual({
      kind: "setPosition",
      moves: [{ id: "a", x: 15, y: 8 }],
    });
  });

  it("moves a positioned element by left and top", () => {
    expect(moveAbsolute(node(), facts(), { x: 5, y: -5 })).toEqual({
      kind: "setStyles",
      ids: ["n"],
      styles: { left: "15px", top: "15px" },
    });
  });

  it("keeps an element pinned by right and bottom pinned by them", () => {
    const pinned = node({ right: "70px", bottom: "60px" });
    expect(moveAbsolute(pinned, facts(), { x: 5, y: 5 }).styles).toEqual({
      right: "65px",
      bottom: "55px",
    });
  });
});

it("moves both insets of an element they size, so it keeps its size", () => {
  const stretched = node({ left: "10px", right: "70px" });
  expect(moveAbsolute(stretched, facts(), { x: 20, y: 0 }).styles).toEqual({
    left: "30px",
    right: "50px",
    top: "20px",
  });
});

describe("resizing", () => {
  it("keeps the left edge of an element pinned by right still when the right edge moves", () => {
    const start = { ...facts(), flexGrow: 0, frameX: 0, frameY: 0 };
    expect(resize(node({ right: "70px" }), start, "e", { x: 10, y: 0 }).styles).toEqual({
      width: "30px",
      right: "60px",
    });
  });

  it("gives the element a fixed size in CSS pixels, whatever the zoom", () => {
    // 40 page pixels at zoom 2 is 20 CSS pixels.
    const edit = resize(
      node(),
      { ...facts({ position: "static" }), flexGrow: 0, frameX: 0, frameY: 0 },
      "se",
      {
        x: 10,
        y: 5,
      },
    );
    expect(edit).toEqual({
      kind: "setStyles",
      ids: ["n"],
      styles: { width: "30px", height: "25px" },
    });
  });

  it("moves the left edge of a positioned element, and stops a flex item growing", () => {
    const edit = resize(node(), { ...facts(), flexGrow: 1, frameX: 0, frameY: 0 }, "w", {
      x: 5,
      y: 0,
    });
    expect(edit.kind === "setStyles" && edit.styles).toEqual({
      width: "15px",
      left: "15px",
      "flex-grow": "0",
    });
  });

  it("leaves a content-box element's padding and borders out of its size", () => {
    const start = { ...facts({ position: "static" }), flexGrow: 0, frameX: 6, frameY: 4 };
    expect(resize(node(), start, "se", { x: 10, y: 10 }).styles).toEqual({
      width: "24px",
      height: "26px",
    });
  });
});

describe("finding where a dragged element goes", () => {
  const box = (left: number, top: number) => ({ left, top, right: left + 10, bottom: top + 10 });
  const row = [
    { id: "a", rect: box(0, 0) },
    { id: "b", rect: box(20, 0) },
    { id: "c", rect: box(40, 0) },
  ];

  it("reads the flow from computed styles", () => {
    expect(flowOf("block", "row", "nowrap")).toBe("column");
    expect(flowOf("flex", "row", "nowrap")).toBe("row");
    expect(flowOf("inline-flex", "column-reverse", "nowrap")).toBe("column-reverse");
    expect(flowOf("flex", "row", "wrap")).toBe("wrap");
    expect(flowOf("grid", "row", "nowrap")).toBe("wrap");
  });

  it("goes before the first child the pointer is before", () => {
    expect(slotBefore("row", row, { x: 22, y: 5 })).toBe("b");
    expect(slotBefore("row", row, { x: 26, y: 5 })).toBe("c");
    expect(slotBefore("row", row, { x: 90, y: 5 })).toBeNull();
    expect(slotBefore("row-reverse", row, { x: 22, y: 5 })).toBe("a");
  });

  it("goes row by row in a grid", () => {
    const grid = [
      { id: "a", rect: box(0, 0) },
      { id: "b", rect: box(20, 0) },
      { id: "c", rect: box(0, 20) },
      { id: "d", rect: box(20, 20) },
    ];
    expect(slotBefore("wrap", grid, { x: 30, y: 5 })).toBe("c");
    expect(slotBefore("wrap", grid, { x: 21, y: 25 })).toBe("d");
  });
});
