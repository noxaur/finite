import { describe, expect, it } from "vite-plus/test";
import { alphaOf, hexOf, isOtherMix, opaque, paintedHex, resolveVars, setAlpha } from "./colors";

describe("alpha", () => {
  it("edits a literal's alpha in its own notation", () => {
    expect(setAlpha("#3b82f6", 50)).toBe("#3b82f680");
    expect(setAlpha("#3b82f680", 100)).toBe("#3b82f6");
    expect(setAlpha("#0003", 100)).toBe("#000");
    expect(alphaOf("#0003")).toBe(20);
    expect(setAlpha("rgb(0 0 0)", 50)).toBe("rgb(0 0 0 / 50%)");
    expect(setAlpha("rgb(0 0 0 / 0.2)", 40)).toBe("rgb(0 0 0 / 0.4)");
    expect(setAlpha("rgba(0, 0, 0, 0.12)", 30)).toBe("rgba(0, 0, 0, 0.3)");
    expect(setAlpha("rgba(0, 0, 0, 0.12)", 100)).toBe("rgb(0, 0, 0)");
    expect(setAlpha("hsl(210 50% 40%)", 25)).toBe("hsl(210 50% 40% / 25%)");
    expect(setAlpha("oklch(0.7 0.1 200 / 80%)", 100)).toBe("oklch(0.7 0.1 200)");
  });

  it("reads alpha in any notation", () => {
    expect(alphaOf("rgb(0 0 0 / 50%)")).toBe(50);
    expect(alphaOf("rgba(0,0,0,.25)")).toBe(25);
    expect(alphaOf("hsla(0, 0%, 0%, 0.6)")).toBe(60);
    expect(alphaOf("red")).toBe(100);
    expect(alphaOf("transparent")).toBe(0);
  });

  it("keeps a token's name under color-mix", () => {
    const mixed = setAlpha("var(--fg)", 40);
    expect(mixed).toBe("color-mix(in srgb, var(--fg) 40%, transparent)");
    expect(alphaOf(mixed)).toBe(40);
    expect(opaque(mixed)).toBe("var(--fg)");
    expect(setAlpha(mixed, 100)).toBe("var(--fg)");
    expect(setAlpha("red", 100)).toBe("red");
  });

  it("tells a mix of two colors from an opacity", () => {
    expect(isOtherMix("color-mix(in oklch, red, blue)")).toBe(true);
    expect(isOtherMix("color-mix(in srgb, red 50%, transparent)")).toBe(false);
  });
});

describe("hexOf", () => {
  it("reads hex and rgb for the picker, without alpha", () => {
    expect(hexOf("#ABC")).toBe("#aabbcc");
    expect(hexOf("#11223380")).toBe("#112233");
    expect(hexOf("rgb(255 0 0 / 50%)")).toBe("#ff0000");
    expect(hexOf("rgba(0, 128, 255, 0.5)")).toBe("#0080ff");
    expect(hexOf("var(--fg)")).toBeNull();
  });
});

describe("colors only the browser reads", () => {
  it("resolves tokens inside a color", () => {
    const lookup = (n: string) => ({ "--a": "var(--b)", "--b": "#ff0000" })[n];
    expect(resolveVars("color-mix(in srgb, var(--a) 40%, var(--x, blue))", lookup)).toBe(
      "color-mix(in srgb, #ff0000 40%, var(--x, blue))",
    );
  });

  it("keeps an hsl or oklch color's notation when its opacity changes", () => {
    expect(setAlpha("hsl(210 50% 40%)", 50)).toBe("hsl(210 50% 40% / 50%)");
    expect(setAlpha("oklch(0.7 0.1 200 / 0.4)", 100)).toBe("oklch(0.7 0.1 200)");
    expect(alphaOf("lab(50% 20 30 / 25%)")).toBe(25);
    expect(paintedHex("#abc")).toBe("#aabbcc");
  });
});
