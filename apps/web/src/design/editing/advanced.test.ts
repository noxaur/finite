import { describe, expect, it } from "vite-plus/test";
import { isClaimed, propName, summary, unclaimed } from "./advanced";

describe("advanced", () => {
  it("leaves out what a control shows", () => {
    expect(isClaimed("border-top-width")).toBe(true);
    expect(isClaimed("--finite-off-box-shadow")).toBe(true);
    expect(isClaimed("outline-offset")).toBe(true);
    expect(unclaimed({ gap: "4px", "clip-path": "circle(50%)", position: "absolute" })).toEqual([
      ["clip-path", "circle(50%)"],
    ]);
  });

  it("claims only the values a control can show", () => {
    const shown = (styles: Record<string, string>, position?: string) =>
      unclaimed(styles, position).map(([p]) => p);
    // What the W and H modes write.
    expect(shown({ flex: "1 1 0", "flex-shrink": "0", "align-self": "stretch" })).toEqual([]);
    expect(shown({ flex: "none", "flex-basis": "auto", "align-self": "auto" })).toEqual([]);
    expect(shown({ flex: "2", "flex-grow": "3", "flex-basis": "120px" })).toEqual([
      "flex",
      "flex-grow",
      "flex-basis",
    ]);
    expect(shown({ "align-self": "center" })).toEqual(["align-self"]);
    // A scale that only mirrors is a flip.
    expect(shown({ scale: "-1 1" })).toEqual([]);
    expect(shown({ scale: "1.05" })).toEqual(["scale"]);
    // Insets are the position's only when they place the element.
    expect(shown({ position: "absolute", top: "4px", left: "0" })).toEqual([]);
    expect(shown({ top: "4px" }, "sticky")).toEqual([]);
    expect(shown({ position: "relative", top: "4px", inset: "0" })).toEqual(["top", "inset"]);
    expect(shown({ left: "4px" })).toEqual(["left"]);
    // No control shows a stacking order.
    expect(shown({ "z-index": "2" })).toEqual(["z-index"]);
    // By name alone, a property with a control is claimed.
    expect(isClaimed("flex")).toBe(true);
  });

  it("says what a declaration holds without CSS", () => {
    expect(propName("clip-path")).toBe("Clip path");
    expect(propName("-webkit-line-clamp")).toBe("Line clamp");
    expect(summary("clip-path", "circle(50%)")).toBe("Shape");
    expect(summary("mask-image", "url(a.png), linear-gradient(red, blue)")).toBe("2 layers");
    expect(summary("position", "absolute")).toBe("Absolute");
    expect(summary("z-index", "10")).toBe("10");
    expect(summary("margin", "8px 16px")).toBe("8 16");
    expect(summary("margin", "var(--s-2)")).toBe("--s-2");
    expect(summary("inset", "calc(50% - 4px)")).toBe("Custom value");
  });
});
