import { describe, expect, it } from "vite-plus/test";
import { ownStyle, routeStyles } from "./inspect";
import {
  flexParts,
  ratioOf,
  type SizeContext,
  sizeContextOf,
  sizeModeOf,
  sizeModeStyles,
} from "./sizing";

const inColumn: SizeContext = {
  parent: "column",
  parentAlign: "normal",
  display: "block",
  grow: 0,
  alignSelf: "auto",
};

describe("size modes", () => {
  it("reads Hug and Fill from a flex parent's axes", () => {
    expect(sizeModeOf("width", {}, inColumn)).toBe("fill");
    expect(sizeModeOf("height", {}, inColumn)).toBe("hug");
    expect(sizeModeOf("width", {}, { ...inColumn, parentAlign: "center" })).toBe("hug");
    expect(sizeModeOf("height", { flex: "1 1 0" }, { ...inColumn, grow: 1 })).toBe("fill");
    expect(sizeModeOf("width", { width: "fit-content" }, inColumn)).toBe("hug");
    expect(sizeModeOf("width", { width: "240px" }, inColumn)).toBe("fixed");
  });

  it("reads block flow and elements out of it", () => {
    const block = { ...inColumn, parent: "block" as const };
    expect(sizeModeOf("width", {}, block)).toBe("fill");
    expect(sizeModeOf("width", {}, { ...block, display: "inline-block" })).toBe("hug");
    expect(sizeModeOf("width", { width: "100%" }, block)).toBe("fill");
    expect(sizeModeOf("width", {}, { ...block, parent: "none" })).toBe("hug");
  });

  it("writes Fill along and across a flex parent, and 100% elsewhere", () => {
    expect(sizeModeStyles("height", "fill", { height: "40px" }, inColumn, 40)).toEqual({
      flex: "1 1 0",
      height: null,
    });
    expect(sizeModeStyles("width", "fill", { width: "fit-content" }, inColumn, 80)).toEqual({
      "align-self": "stretch",
      width: null,
    });
    const block = { ...inColumn, parent: "block" as const };
    expect(sizeModeStyles("width", "fill", {}, block, 80)).toEqual({ width: "100%" });
  });

  it("takes off what made it fill when it hugs or gets a fixed size", () => {
    const grown = { ...inColumn, grow: 1 };
    expect(sizeModeStyles("height", "fixed", { flex: "1 1 0" }, grown, 99.6)).toEqual({
      flex: null,
      "flex-shrink": "0",
      height: "100px",
    });
    // A stylesheet makes it grow.
    expect(sizeModeStyles("height", "hug", {}, grown, 10)).toEqual({
      "flex-grow": "0",
      "flex-shrink": "0",
      height: "fit-content",
    });
    expect(sizeModeStyles("width", "hug", { "align-self": "stretch" }, inColumn, 10)).toEqual({
      "align-self": null,
      width: "fit-content",
    });
  });

  it("keeps a fixed or hugging size from shrinking along the main axis", () => {
    expect(sizeModeStyles("height", "fixed", {}, inColumn, 40)).toEqual({
      "flex-shrink": "0",
      height: "40px",
    });
    expect(sizeModeStyles("height", "hug", { "flex-shrink": "0" }, inColumn, 40)).toEqual({
      height: "fit-content",
    });
    // Across the line, shrinking doesn't apply.
    expect(sizeModeStyles("width", "fixed", {}, inColumn, 80)).toEqual({ width: "80px" });
    // Fill takes it off again.
    expect(sizeModeStyles("height", "fill", { "flex-shrink": "0" }, inColumn, 40)).toEqual({
      flex: "1 1 0",
      "flex-shrink": null,
    });
  });

  it("reads the context from computed styles", () => {
    const own = { display: "block", position: "static", flexGrow: "1", alignSelf: "auto" };
    const parent = { display: "flex", flexDirection: "row", alignItems: "center" };
    expect(sizeContextOf(own, parent)).toEqual({
      parent: "row",
      parentAlign: "center",
      display: "block",
      grow: 1,
      alignSelf: "auto",
    });
    expect(sizeContextOf({ ...own, position: "absolute" }, parent).parent).toBe("none");
  });
});

describe("flex", () => {
  it("takes a flex shorthand apart the way the browser does", () => {
    expect(flexParts("1")).toEqual(["1", "1", "0%"]);
    expect(flexParts("2 0")).toEqual(["2", "0", "0%"]);
    expect(flexParts("1 1 0")).toEqual(["1", "1", "0"]);
    expect(flexParts("2 200px")).toEqual(["2", "1", "200px"]);
    expect(flexParts("auto")).toEqual(["1", "1", "auto"]);
    expect(flexParts("none")).toEqual(["0", "0", "auto"]);
    expect(flexParts("var(--grow)")).toBeNull();
  });

  it("reads and writes grow and shrink inside an inline flex", () => {
    expect(ownStyle({ flex: "2" }, "flex-grow")).toBe("2");
    expect(ownStyle({ flex: "2" }, "flex-shrink")).toBe("1");
    expect(routeStyles({ flex: "2" }, { "flex-shrink": "0" })).toEqual({ flex: "2 0 0%" });
    expect(routeStyles({ flex: "2", "flex-grow": "1" }, { "flex-shrink": "0" })).toEqual({
      "flex-shrink": "0",
    });
  });
});

describe("boxes and gaps", () => {
  it("writes a side into the padding, margin or inset it has", () => {
    expect(ownStyle({ padding: "8px 16px" }, "padding-left")).toBe("16px");
    expect(routeStyles({ padding: "var(--s-5)" }, { "padding-top": "10px" })).toEqual({
      padding: "10px var(--s-5) var(--s-5)",
    });
    expect(routeStyles({ margin: "0" }, { "margin-left": "auto" })).toEqual({
      margin: "0 0 0 auto",
    });
    expect(routeStyles({ inset: "20px auto auto 30px" }, { top: null })).toEqual({
      inset: "auto auto auto 30px",
    });
  });

  it("keeps padding a shorthand when an axis writes both its sides", () => {
    const axis = (styles: Record<string, string>, left: string, right: string) =>
      routeStyles(styles, { "padding-left": left, "padding-right": right });
    expect(axis({ padding: "12px" }, "24px", "24px")).toEqual({ padding: "12px 24px" });
    expect(axis({ padding: "12px 24px" }, "6px", "6px")).toEqual({ padding: "12px 6px" });
    expect(axis({ padding: "1px 2px 3px 4px" }, "9px", "9px")).toEqual({ padding: "1px 9px 3px" });
    expect(axis({ padding: "var(--s-5)" }, "24px", "24px")).toEqual({
      padding: "var(--s-5) 24px",
    });
    // Without a shorthand to write into, each side is a longhand.
    expect(axis({}, "6px", "6px")).toEqual({ "padding-left": "6px", "padding-right": "6px" });
  });

  it("reads and writes row and column gaps inside a gap", () => {
    expect(ownStyle({ gap: "var(--s-3) 12px" }, "row-gap")).toBe("var(--s-3)");
    expect(ownStyle({ gap: "8px" }, "column-gap")).toBe("8px");
    expect(routeStyles({ gap: "24px" }, { "row-gap": "8px" })).toEqual({ gap: "8px 24px" });
    expect(routeStyles({ gap: "8px 24px" }, { "row-gap": "24px" })).toEqual({ gap: "24px" });
  });
});

describe("aspect ratio", () => {
  it("reads width over height", () => {
    expect(ratioOf("16 / 9")).toBeCloseTo(1.778, 3);
    expect(ratioOf("2")).toBe(2);
    expect(ratioOf("auto 4/3")).toBeCloseTo(1.333, 3);
    expect(ratioOf("auto")).toBeNull();
  });
});

describe("sizes the bridge measured", () => {
  const flexRow = {
    parent: "row" as const,
    parentAlign: "stretch",
    display: "block",
    grow: 0,
    alignSelf: "auto",
  };

  it("tells a fixed size from a hugging one along the row", () => {
    const fixed = { ...flexRow, sized: { width: "fixed", height: "auto" } };
    const hug = { ...flexRow, sized: { width: "hug", height: "auto" } };
    expect(sizeModeOf("width", {}, fixed)).toBe("fixed");
    expect(sizeModeOf("width", {}, hug)).toBe("hug");
    expect(sizeModeOf("height", {}, hug)).toBe("fill");
  });

  it("still reads a growing child as Fill, and needs both axes", () => {
    expect(
      sizeModeOf("width", {}, { ...flexRow, grow: 1, sized: { width: "fixed", height: "auto" } }),
    ).toBe("fill");
    expect(
      sizeContextOf({ display: "flex", position: "static", flexGrow: "0", alignSelf: "auto" }, null)
        .sized,
    ).toBeUndefined();
    expect(
      sizeContextOf(
        {
          display: "flex",
          position: "static",
          flexGrow: "0",
          alignSelf: "auto",
          sizedWidth: "hug",
          sizedHeight: "fixed",
        },
        null,
      ).sized,
    ).toEqual({ width: "hug", height: "fixed" });
  });
});

describe("leaving Hug for Fill", () => {
  it("clears the size that held it, across a flex row", () => {
    const ctx = {
      parent: "row" as const,
      parentAlign: "stretch",
      display: "block",
      grow: 0,
      alignSelf: "auto",
      sized: { width: "auto", height: "hug" },
    };
    expect(sizeModeStyles("height", "fill", {}, ctx, 18)).toEqual({
      "align-self": "stretch",
      height: null,
    });
  });
});
