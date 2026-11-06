import { describe, expect, it } from "vite-plus/test";
import {
  centerOffset,
  hasBorder,
  moveStroke,
  outlinePart,
  outlinePosition,
  strokePosition,
} from "./stroke";

const reader = (styles: Record<string, string>) => (prop: string) => styles[prop];

describe("stroke position", () => {
  it("reads inside, center and outside", () => {
    expect(strokePosition(reader({ "border-style": "solid" }))).toBe("inside");
    const outline = { "outline-style": "solid", "outline-width": "2px" };
    expect(strokePosition(reader({ ...outline, "outline-offset": "-1px" }))).toBe("center");
    expect(strokePosition(reader({ ...outline, "outline-offset": "0px" }))).toBe("outside");
    expect(strokePosition(reader({ "border-style": "none" }))).toBeNull();
    // A border on one side only, like a divider's, is inside too.
    expect(strokePosition(reader({ "border-style": "none none solid" }))).toBe("inside");
    expect(strokePosition(reader({ "border-bottom-style": "solid" }))).toBe("inside");
    expect(centerOffset("var(--b-1)")).toBe("calc(var(--b-1) / -2)");
  });

  it("moves a border to an outline in one edit", () => {
    const own = { border: "2px solid var(--line)" };
    expect(
      moveStroke(own, "inside", "center", { width: "2px", style: "solid", color: "var(--line)" }),
    ).toEqual({
      border: null,
      "outline-offset": "-1px",
      "outline-width": "2px",
      "outline-style": "solid",
      "outline-color": "var(--line)",
    });
  });

  it("covers a border a class draws, and moves back inside", () => {
    expect(
      moveStroke({}, "inside", "outside", { width: "1px", style: "solid", color: "red" }),
    ).toMatchObject({
      "border-style": "none",
      "outline-offset": "0px",
    });
    const own = {
      "outline-width": "1px",
      "outline-style": "solid",
      "outline-color": "red",
      "outline-offset": "0px",
    };
    expect(
      moveStroke(own, "outside", "inside", { width: "1px", style: "solid", color: "red" }),
    ).toEqual({
      "outline-width": null,
      "outline-style": null,
      "outline-color": null,
      "outline-offset": null,
      "border-width": "1px",
      "border-style": "solid",
      "border-color": "red",
    });
  });
});

describe("an outline shorthand", () => {
  it("reads its width, style and color", () => {
    const own = { outline: "2px dotted blue", "outline-offset": "0" };
    expect(outlinePart(own, "outline-width")).toBe("2px");
    expect(outlinePart(own, "outline-style")).toBe("dotted");
    expect(outlinePart(own, "outline-color")).toBe("blue");
    expect(strokePosition((p) => outlinePart(own, p) ?? own[p as keyof typeof own])).toBe(
      "outside",
    );
  });
});

describe("a border beside an outline", () => {
  it("reads both", () => {
    const own: Record<string, string> = {
      "border-style": "solid",
      "outline-style": "dashed",
      "outline-width": "4px",
      "outline-offset": "8px",
    };
    expect(hasBorder(reader(own))).toBe(true);
    expect(outlinePosition(reader(own))).toBe("outside");
    expect(outlinePosition(reader({ "border-style": "solid" }))).toBeNull();
  });
});
