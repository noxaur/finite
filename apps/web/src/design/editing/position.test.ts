import { describe, expect, it } from "vite-plus/test";
import {
  constraintOf,
  constraintStyles,
  containersFor,
  degreesOf,
  POSITIONS,
  positionKindOf,
  positionStyles,
  stickyEdgeOf,
  stickyEdgeStyles,
} from "./position";

describe("position", () => {
  it("reads the kind", () => {
    expect(positionKindOf(undefined)).toBe("static");
    expect(positionKindOf("absolute")).toBe("absolute");
    expect(positionKindOf("-webkit-sticky")).toBeNull();
    // Relative still reads, but isn't offered.
    expect(positionKindOf("relative")).toBe("relative");
    expect(POSITIONS.map(([k]) => k)).toEqual(["static", "absolute", "fixed", "sticky"]);
  });

  it("makes a static parent the container of a child that goes absolute", () => {
    const positions: Record<string, string> = { a: "static", b: "relative" };
    const of = (id: string) => positions[id];
    const targets = [
      { id: "1", parent: "a" },
      { id: "2", parent: "a" },
      { id: "3", parent: "b" },
      { id: "4", parent: null },
    ];
    expect(containersFor("absolute", targets, of)).toEqual(["a"]);
    // A parent that's selected too gets its own change.
    expect(
      containersFor(
        "absolute",
        [
          { id: "a", parent: "1" },
          { id: "1", parent: "a" },
        ],
        of,
      ),
    ).toEqual([]);
    expect(containersFor("fixed", targets, of)).toEqual([]);
    expect(containersFor("sticky", targets, of)).toEqual([]);
  });

  it("pins by its constraints, keeping it where it is", () => {
    const box = { near: 10, far: 30, size: 60 };
    expect(constraintOf({}, "x")).toBe("near");
    expect(constraintOf({ right: "0" }, "x")).toBe("far");
    expect(constraintOf({ top: "1px", bottom: "2px" }, "y")).toBe("both");
    expect(constraintStyles("x", "far", { left: "10px" }, box)).toEqual({
      left: "auto",
      right: "30px",
    });
    // Both insets size it, so its own width comes off.
    expect(constraintStyles("x", "both", { left: "10px", width: "60px" }, box)).toEqual({
      left: "10px",
      right: "30px",
      width: null,
    });
    // Leaving both, it keeps the size the insets gave it.
    expect(constraintStyles("y", "near", { top: "10px", bottom: "30px" }, box)).toEqual({
      top: "10px",
      bottom: "auto",
      height: "60px",
    });
  });

  it("lets go of an edge an inset shorthand pins", () => {
    // 100px wide, 10px from the left of a 500px parent.
    const box = { near: 10, far: 390, size: 100 };
    expect(constraintStyles("x", "far", { inset: "10px", width: "100px" }, box)).toEqual({
      inset: null,
      top: "10px",
      bottom: "10px",
      left: "auto",
      right: "390px",
    });
    // Each side as `margin` reads it, and an edge set on its own wins.
    expect(
      constraintStyles("y", "near", { inset: "1px calc(2px + 3px) 4px", left: "9px" }, box),
    ).toEqual({
      inset: null,
      top: "10px",
      right: "calc(2px + 3px)",
      bottom: "auto",
      height: "100px",
    });
    expect(constraintStyles("x", "near", { "inset-inline": "10px 390px" }, box)).toEqual({
      "inset-inline": null,
      left: "10px",
      right: "auto",
      width: "100px",
    });
  });

  it("pins by the left edge after both", () => {
    const box = { near: 10, far: 390, size: 100 };
    expect(constraintStyles("x", "near", { left: "10px", right: "390px" }, box)).toEqual({
      left: "10px",
      right: "auto",
      width: "100px",
    });
  });

  it("overrides a left inset that a stylesheet sets", () => {
    // No inline insets: the stylesheet's `left` would still pin it.
    expect(constraintStyles("x", "far", {}, { near: 10, far: 390, size: 100 })).toEqual({
      left: "auto",
      right: "390px",
    });
  });

  it("moves a sticky element's distance to another edge", () => {
    expect(stickyEdgeOf({ position: "sticky", bottom: "8px" })).toBe("bottom");
    expect(stickyEdgeOf({})).toBe("top");
    expect(stickyEdgeStyles("top", "bottom", { top: "8px" })).toEqual({
      top: null,
      bottom: "8px",
    });
    expect(stickyEdgeStyles("top", "left", {})).toEqual({ left: "0px" });
  });

  it("takes the insets off going back into the flow", () => {
    const own = { position: "absolute", inset: "20px auto auto 30px", "z-index": "2" };
    expect(positionStyles("static", own, "absolute")).toEqual({ position: null, inset: null });
    // Only a stylesheet positions it.
    expect(positionStyles("static", {}, "relative")).toEqual({ position: "static" });
    expect(positionStyles("static", {}, "static")).toEqual({});
  });

  it("gives a sticky element an inset to stick by", () => {
    expect(positionStyles("sticky", {}, "static")).toEqual({ position: "sticky", top: "0px" });
    expect(positionStyles("sticky", { bottom: "0" }, "static")).toEqual({ position: "sticky" });
    expect(positionStyles("absolute", { top: "4px" }, "static")).toEqual({ position: "absolute" });
  });

  it("reads and writes rotation in degrees", () => {
    expect(degreesOf("45deg")).toBe(45);
    expect(degreesOf("0.25turn")).toBe(90);
    expect(degreesOf("none")).toBe(0);
    expect(degreesOf("x 45deg")).toBeNull();
  });
});
