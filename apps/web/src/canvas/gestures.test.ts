import type { Frame, Hit } from "@finite/protocol";
import { describe, expect, it } from "vite-plus/test";
import {
  detachTarget,
  drillInto,
  fileOf,
  flowAxis,
  movedFrames,
  reorderBefore,
  resizedFrame,
  resizeEdit,
  resizeStyles,
  revsOf,
} from "./gestures";

const rect = { x: 10, y: 20, width: 100, height: 40 };

describe("resizing an element", () => {
  it("writes the width a side handle changes, in whole pixels", () => {
    expect(resizeStyles(rect, "e", { x: 12.4, y: 99 })).toEqual({ width: "112px" });
    expect(resizeStyles(rect, "w", { x: 30, y: 0 })).toEqual({ width: "70px" });
  });

  it("writes both sizes from a corner, never below one pixel", () => {
    expect(resizeStyles(rect, "se", { x: -500, y: 10 })).toEqual({ width: "1px", height: "50px" });
    expect(resizeStyles(rect, "n", { x: 0, y: -10 })).toEqual({ height: "50px" });
  });

  it("moves a positioned element's top and left with the handles that drag them", () => {
    const at = { left: 40, top: 80, zoom: 1 };
    expect(resizeStyles(rect, "n", { x: 0, y: -10 }, at)).toEqual({ height: "50px", top: "70px" });
    expect(resizeStyles(rect, "w", { x: 30, y: 0 }, at)).toEqual({ width: "70px", left: "70px" });
    expect(resizeStyles(rect, "nw", { x: 5, y: 5 }, at)).toEqual({
      width: "95px",
      height: "35px",
      left: "45px",
      top: "85px",
    });
    expect(resizeStyles(rect, "se", { x: 5, y: 5 }, at)).toEqual({
      width: "105px",
      height: "45px",
    });
  });

  it("scales a positioned element's inset by its zoom, and stops at the smallest size", () => {
    expect(resizeStyles(rect, "n", { x: 0, y: -10 }, { left: 0, top: 80, zoom: 2 })).toMatchObject({
      top: "75px",
    });
    expect(resizeStyles(rect, "n", { x: 0, y: 999 }, { left: 0, top: 80, zoom: 1 })).toMatchObject({
      height: "1px",
      top: "119px",
    });
  });

  it("carries the insets into the edit for a positioned element", () => {
    const el = { loc: "src/App.tsx:4:6", rev: "0123abcd", tag: "svg" };
    const at = { left: 0, top: 80, zoom: 1 };
    expect(resizeEdit(el, rect, "n", { x: 0, y: -10 }, at)).toMatchObject({
      styles: { height: "50px", top: "70px" },
    });
  });

  it("ends in one style edit carrying the file's rev, or none for no travel", () => {
    const el = { loc: "src/App.tsx:4:6", rev: "0123abcd", tag: "div" };
    expect(resizeEdit(el, rect, "e", { x: 0.2, y: 0 })).toBeNull();
    expect(resizeEdit(el, rect, "s", { x: 0, y: 5 })).toEqual({
      kind: "style",
      locs: ["src/App.tsx:4:6"],
      tag: "div",
      styles: { height: "45px" },
      revs: { "src/App.tsx": "0123abcd" },
    });
  });
});

describe("frames", () => {
  const frame: Frame = {
    id: "f",
    name: "Home",
    x: 0,
    y: 0,
    width: 400,
    height: 300,
    hug: true,
    source: { kind: "route", path: "/" },
  };

  it("moves to whole canvas units", () => {
    expect(movedFrames([frame], { x: 10.6, y: -3.2 })).toEqual([{ id: "f", x: 11, y: -3 }]);
  });

  it("resizes from the top-left, keeping the far corner, and stops hugging once its height is set", () => {
    expect(resizedFrame(frame, "nw", { x: 50, y: 20 })).toEqual({
      id: "f",
      x: 50,
      y: 20,
      width: 350,
      height: 280,
      hug: false,
    });
    expect(resizedFrame(frame, "e", { x: 10, y: 0 }).hug).toBe(true);
  });
});

describe("reordering", () => {
  const siblings = [
    { loc: "a.tsx:1:1", rect: { x: 0, y: 0, width: 100, height: 20 } },
    { loc: "a.tsx:2:1", rect: { x: 0, y: 20, width: 100, height: 20 } },
    { loc: "a.tsx:3:1", rect: { x: 0, y: 40, width: 100, height: 20 } },
  ];

  it("reorders only in a flex or grid parent", () => {
    expect(flowAxis({ display: "flex", flexDirection: "row" })).toBe("x");
    expect(flowAxis({ display: "inline-flex", flexDirection: "column" })).toBe("y");
    expect(flowAxis({ display: "grid", flexDirection: "row" })).toBe("y");
    expect(flowAxis({ display: "block", flexDirection: "row" })).toBeNull();
  });

  it("lands before the first sibling whose middle is past the pointer", () => {
    expect(reorderBefore("a.tsx:3:1", siblings, { x: 5, y: 5 }, "y")).toBe("a.tsx:1:1");
    expect(reorderBefore("a.tsx:1:1", siblings, { x: 5, y: 55 }, "y")).toBeNull();
  });

  it("says nothing when it would stay where it is", () => {
    expect(reorderBefore("a.tsx:2:1", siblings, { x: 5, y: 25 }, "y")).toBeUndefined();
    expect(reorderBefore("a.tsx:3:1", siblings, { x: 5, y: 59 }, "y")).toBeUndefined();
  });
});

describe("hits", () => {
  const hit: Hit = {
    loc: "src/Button.tsx:3:4",
    rev: "aaaaaaaa",
    tag: "span",
    rect,
    index: 0,
    count: 1,
    path: [
      { loc: "src/Button.tsx:2:2", rev: "aaaaaaaa", tag: "button" },
      { loc: ".finite/boards/c1/Card.tsx:5:4", rev: "bbbbbbbb", tag: "div" },
      { loc: ".finite/boards/c1/Card.tsx:3:2", rev: "bbbbbbbb", tag: "main" },
    ],
  };

  it("drills one level down from the selection toward the hit", () => {
    expect(drillInto(hit, undefined)?.tag).toBe("main");
    expect(drillInto(hit, ".finite/boards/c1/Card.tsx:5:4")?.tag).toBe("button");
    expect(drillInto(hit, "src/Button.tsx:3:4")).toBeNull();
  });

  it("finds the prototype file that imports a production one, to copy it in", () => {
    const chain = [...hit.path].reverse().concat({ loc: hit.loc, rev: hit.rev, tag: hit.tag });
    expect(detachTarget(chain, "src/Button.tsx:2:2")).toEqual({
      file: "src/Button.tsx",
      importer: ".finite/boards/c1/Card.tsx",
    });
    expect(
      detachTarget([{ loc: "src/A.tsx:1:1", rev: "aaaaaaaa", tag: "a" }], "src/A.tsx:1:1"),
    ).toBeNull();
  });

  it("names files and revs by loc", () => {
    expect(fileOf("src/pages/Home.tsx:12:4")).toBe("src/pages/Home.tsx");
    expect(revsOf([hit, ...hit.path])).toEqual({
      "src/Button.tsx": "aaaaaaaa",
      ".finite/boards/c1/Card.tsx": "bbbbbbbb",
    });
  });
});
