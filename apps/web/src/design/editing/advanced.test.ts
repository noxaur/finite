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
