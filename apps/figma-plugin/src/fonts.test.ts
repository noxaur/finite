import { describe, expect, it } from "vite-plus/test";
import { FALLBACK, isItalic, pickFont, styleOf, weightOf, type FontName } from "./fonts.ts";

describe("weightOf", () => {
  it("maps style names from Thin to Black", () => {
    const cases: Array<[string, number]> = [
      ["Thin", 100],
      ["Extra Light", 200],
      ["ExtraLight", 200],
      ["Light", 300],
      ["Regular", 400],
      ["Medium", 500],
      ["Semi Bold", 600],
      ["SemiBold", 600],
      ["Bold", 700],
      ["Extra Bold", 800],
      ["Black", 900],
    ];
    for (const [style, weight] of cases) expect(weightOf(style), style).toBe(weight);
  });

  it("ignores slant and defaults to Regular", () => {
    expect(weightOf("Semi Bold Italic")).toBe(600);
    expect(weightOf("Italic")).toBe(400);
    expect(weightOf("Condensed")).toBe(400);
  });
});

describe("isItalic", () => {
  it("finds Italic and Oblique in a style name", () => {
    expect(isItalic("Bold Italic")).toBe(true);
    expect(isItalic("Light Oblique")).toBe(true);
    expect(isItalic("Bold")).toBe(false);
  });
});

describe("styleOf", () => {
  it("names a weight and slant the way Figma does", () => {
    expect(styleOf(400, false)).toBe("Regular");
    expect(styleOf(400, true)).toBe("Italic");
    expect(styleOf(600, true)).toBe("Semi Bold Italic");
    expect(styleOf(650, false)).toBe("Bold");
    expect(styleOf(1200, false)).toBe("Black");
  });

  it("agrees with weightOf", () => {
    for (let weight = 100; weight <= 900; weight += 100) {
      expect(weightOf(styleOf(weight, true))).toBe(weight);
    }
  });
});

describe("pickFont", () => {
  const font = (family: string, style: string): FontName => ({ family, style });
  const available = [
    font("Inter", "Regular"),
    font("Inter", "Bold"),
    font("Inter", "Bold Italic"),
    font("Inter", "Medium"),
    font("Lora", "Regular"),
    font("Lora", "SemiBold"),
  ];

  it("takes the exact style", () => {
    expect(
      pickFont({ family: "Lora", style: "SemiBold", weight: 600, italic: false }, available),
    ).toEqual({ font: font("Lora", "SemiBold"), replaced: false });
  });

  it("takes the same weight under another spelling", () => {
    expect(
      pickFont({ family: "Lora", style: "Semi Bold", weight: 600, italic: false }, available),
    ).toEqual({ font: font("Lora", "SemiBold"), replaced: false });
    expect(pickFont({ family: "Inter", weight: 700, italic: true }, available).font).toEqual(
      font("Inter", "Bold Italic"),
    );
  });

  it("moves to the nearest weight in the family and says so", () => {
    expect(pickFont({ family: "Lora", weight: 800, italic: false }, available)).toEqual({
      font: font("Lora", "SemiBold"),
      replaced: true,
    });
  });

  it("falls back to Inter at the same weight when the family isn't there", () => {
    expect(pickFont({ family: "Nope Sans", weight: 700, italic: false }, available)).toEqual({
      font: font("Inter", "Bold"),
      replaced: true,
    });
  });

  it("falls back to Inter Regular when Inter isn't listed either", () => {
    expect(pickFont({ family: "Nope Sans", weight: 700, italic: false }, [])).toEqual({
      font: FALLBACK,
      replaced: true,
    });
  });
});
