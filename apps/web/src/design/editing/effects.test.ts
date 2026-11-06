import { describe, expect, it } from "vite-plus/test";
import { effectName, filterText, parseFilter, parseShadow, shadowText } from "./effects";

describe("shadows", () => {
  it("takes one shadow apart and back", () => {
    const shadow = parseShadow("inset 0 1px 2px rgba(0, 0, 0, 0.08)");
    expect(shadow).toEqual({
      inset: true,
      x: "0",
      y: "1px",
      blur: "2px",
      spread: "0",
      color: "rgba(0, 0, 0, 0.08)",
    });
    expect(shadowText({ ...shadow!, inset: false })).toBe("0 1px 2px 0 rgba(0, 0, 0, 0.08)");
    expect(shadowText(shadow!, true)).toBe("0 1px 2px rgba(0, 0, 0, 0.08)");
    expect(parseShadow("rgba(0, 0, 0, 0.1) 0px 4px 12px 0px")?.color).toBe("rgba(0, 0, 0, 0.1)");
    expect(parseShadow("0 1px red, 0 2px blue")).toBeNull();
    expect(parseShadow("0 0 calc(2px + 1px) red")).toBeNull();
    expect(parseShadow("none")).toBeNull();
  });
});

describe("filters", () => {
  it("reads amounts in the unit each filter shows", () => {
    expect(parseFilter("blur(4px)")).toEqual({ fn: "blur", amount: 4 });
    expect(parseFilter("brightness(1.2)")).toEqual({ fn: "brightness", amount: 120 });
    expect(parseFilter("grayscale(50%)")).toEqual({ fn: "grayscale", amount: 50 });
    expect(parseFilter("hue-rotate(0.5turn)")).toEqual({ fn: "hue-rotate", amount: 180 });
    expect(parseFilter("url(#f)")).toBeNull();
    expect(parseFilter("blur(calc(1px + 2px))")).toBeNull();
    expect(filterText({ fn: "saturate", amount: 150 })).toBe("saturate(150%)");
  });

  it("names each row", () => {
    expect(effectName("box-shadow", parseShadow("inset 0 1px red"), "")).toBe("Inner shadow");
    expect(effectName("filter", parseFilter("blur(2px)"), "blur(2px)")).toBe("Layer blur");
    expect(effectName("backdrop-filter", null, "blur(8px)")).toBe("Background blur");
  });
});
