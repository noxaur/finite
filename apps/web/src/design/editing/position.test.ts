import { describe, expect, it } from "vite-plus/test";
import { degreesOf, positionKindOf, positionStyles } from "./position";

describe("position", () => {
  it("reads the kind", () => {
    expect(positionKindOf(undefined)).toBe("static");
    expect(positionKindOf("absolute")).toBe("absolute");
    expect(positionKindOf("-webkit-sticky")).toBeNull();
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
