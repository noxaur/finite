import { describe, expect, it } from "vite-plus/test";
import { alphaOf, setAlpha } from "./colors";
import { hexOfHsv, hsvOf, hueHex, isHexLike, parseHex, typedHex } from "./hsv";

const hex = (r: number, g: number, b: number) =>
  `#${[r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("")}`;

describe("hsv", () => {
  it("reads the primaries and grays", () => {
    expect(hsvOf("#ff0000")).toEqual({ h: 0, s: 1, v: 1 });
    expect(hsvOf("#00ff00")).toEqual({ h: 120, s: 1, v: 1 });
    expect(hsvOf("#0000ff")).toEqual({ h: 240, s: 1, v: 1 });
    expect(hsvOf("#ffffff")).toEqual({ h: 0, s: 0, v: 1 });
    expect(hsvOf("#000")).toEqual({ h: 0, s: 0, v: 0 });
    expect(hsvOf("95ced7")?.h).toBeCloseTo(188.18, 2);
    expect(hsvOf("#12345")).toBeNull();
    expect(hsvOf("red")).toBeNull();
  });

  it("writes the primaries", () => {
    expect(hexOfHsv({ h: 0, s: 1, v: 1 })).toBe("#ff0000");
    expect(hexOfHsv({ h: 360, s: 1, v: 1 })).toBe("#ff0000");
    expect(hexOfHsv({ h: 60, s: 1, v: 1 })).toBe("#ffff00");
    expect(hexOfHsv({ h: 300, s: 1, v: 0.5 })).toBe("#800080");
    expect(hexOfHsv({ h: 200, s: 0, v: 1 })).toBe("#ffffff");
    expect(hexOfHsv({ h: 200, s: 2, v: -1 })).toBe("#000000");
    expect(hueHex(180)).toBe("#00ffff");
  });

  it("round-trips every hex through hsv", () => {
    const off: string[] = [];
    for (let r = 0; r < 256; r += 5)
      for (let g = 0; g < 256; g += 3)
        for (let b = 0; b < 256; b += 7) {
          const h = hex(r, g, b);
          if (hexOfHsv(hsvOf(h)!) !== h) off.push(h);
        }
    expect(off).toEqual([]);
  });

  it("keeps the hue and saturation a gray or black can't say", () => {
    const keep = { h: 210, s: 0.6, v: 0.8 };
    expect(hsvOf("#000000", keep)).toEqual({ h: 210, s: 0.6, v: 0 });
    expect(hsvOf("#808080", keep)).toEqual({ h: 210, s: 0, v: 128 / 255 });
    expect(hsvOf("#ff0000", keep)).toEqual({ h: 0, s: 1, v: 1 });
  });
});

describe("hex with alpha", () => {
  it("reads 3, 4, 6 and 8 digits, with or without #", () => {
    expect(parseHex("#ABC")).toEqual({ hex: "#aabbcc", alpha: null });
    expect(parseHex("abc8")).toEqual({ hex: "#aabbcc", alpha: 53 });
    expect(parseHex(" 95ced7 ")).toEqual({ hex: "#95ced7", alpha: null });
    expect(parseHex("#95ced780")).toEqual({ hex: "#95ced7", alpha: 50 });
    expect(parseHex("#95ced7ff")).toEqual({ hex: "#95ced7", alpha: 100 });
    expect(parseHex("#95ced700")).toEqual({ hex: "#95ced7", alpha: 0 });
    expect(parseHex("#95ced")).toBeNull();
    expect(parseHex("blue")).toBeNull();
  });

  it("round-trips every whole alpha through #rrggbbaa", () => {
    for (let a = 0; a <= 100; a++) {
      const written = setAlpha("#95ced7", a);
      expect(alphaOf(written)).toBe(a);
      expect(parseHex(written)?.alpha ?? 100).toBe(a);
    }
  });

  it("round-trips hsv and alpha together", () => {
    const hsv = { h: 188, s: 0.31, v: 0.84 };
    const written = setAlpha(hexOfHsv(hsv), 42);
    const read = parseHex(written)!;
    expect(read.alpha).toBe(42);
    expect(hexOfHsv(hsvOf(read.hex)!)).toBe(hexOfHsv(hsv));
  });
});

describe("typed hex", () => {
  it("reads only whole hex while typing, so a half-typed one isn't a short hex with alpha", () => {
    const steps = ["#", "#1", "#1f", "#1f3", "#1f3a", "#1f3a4"];
    for (const t of steps) expect(typedHex(t, false)).toBeNull();
    expect(typedHex("#1f3a44", false)).toEqual({ hex: "#1f3a44", alpha: null });
    expect(typedHex("1f3a44", false)).toEqual({ hex: "#1f3a44", alpha: null });
    expect(typedHex("#1f3a4480", false)).toEqual({ hex: "#1f3a44", alpha: 50 });
    expect(typedHex("#1f3a448", false)).toBeNull();
  });

  it("reads 3, 4, 6 and 8 digits once it's done", () => {
    expect(typedHex("#1f3", true)).toEqual({ hex: "#11ff33", alpha: null });
    expect(typedHex("#1f3a", true)).toEqual({ hex: "#11ff33", alpha: 67 });
    expect(typedHex("#1f3a44", true)).toEqual({ hex: "#1f3a44", alpha: null });
    expect(typedHex("#1f3a4480", true)).toEqual({ hex: "#1f3a44", alpha: 50 });
    expect(typedHex("#1f3a4", true)).toBeNull();
  });

  it("knows a hex by its #", () => {
    expect(isHexLike("#1f3a")).toBe(true);
    expect(isHexLike(" #1")).toBe(true);
    expect(isHexLike("1f3a")).toBe(false);
    expect(isHexLike("red")).toBe(false);
    expect(isHexLike("--brand")).toBe(false);
  });
});
