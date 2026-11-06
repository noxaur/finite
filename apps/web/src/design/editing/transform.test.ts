import { describe, expect, it } from "vite-plus/test";
import {
  flipsOf,
  flipStyles,
  isFlip,
  NO_TRANSFORM,
  originCell,
  originValue,
  parseRotate,
  parseScale,
  parseTransform,
  parseTranslate,
  readTransform,
  rotationOf,
  transformResets,
  transformStyles,
  turned,
  withRotation,
  withSheet,
} from "./transform";

describe("individual properties", () => {
  it("reads a move, a scale and a turn", () => {
    expect(parseTranslate("10px")).toEqual(["10px", "0"]);
    expect(parseTranslate("10px -50%")).toEqual(["10px", "-50%"]);
    expect(parseTranslate("none")).toEqual(["0", "0"]);
    expect(parseTranslate("var(--s-3) 0")).toEqual(["var(--s-3)", "0"]);
    expect(parseTranslate("1px 2px 3px")).toBeNull();
    expect(parseTranslate("calc(1px + 2px)")).toBeNull();
    expect(parseScale("120%")).toEqual([1.2, 1.2]);
    expect(parseScale("-1 1")).toEqual([-1, 1]);
    expect(parseRotate("0.25turn")).toBe(90);
    expect(parseRotate("x 45deg")).toBeNull();
  });
});

describe("transform", () => {
  it("takes functions in translate, rotate, scale, skew order", () => {
    expect(parseTransform("translateY(-2px) scale(1.05)")?.value).toEqual({
      ...NO_TRANSFORM,
      y: "-2px",
      scaleX: 1.05,
      scaleY: 1.05,
    });
    expect(parseTransform("skew(10deg, 5deg)")?.value).toMatchObject({ skewX: 10, skewY: 5 });
    expect(parseTransform("scale(2) translate(10px)")).toBeNull();
    expect(parseTransform("translateX(1px) translateX(2px)")).toBeNull();
    expect(parseTransform("matrix(1, 0.2, 0, 1, 0, 0)")).toBeNull();
    expect(parseTransform("rotateX(45deg)")).toBeNull();
  });

  it("folds a transform into the individual properties where it's the same picture", () => {
    expect(
      readTransform({ translate: "10px", transform: "translateX(5px) rotate(45deg)" }),
    ).toEqual({ value: { ...NO_TRANSFORM, x: "15px", rotate: 45 }, custom: false });
    // A move after a scale would move by the scaled amount.
    expect(readTransform({ scale: "2", transform: "translateX(5px)" }).custom).toBe(true);
    expect(readTransform({ translate: "1em", transform: "translateX(5px)" }).custom).toBe(true);
    expect(readTransform({ transform: "matrix(1, 0.2, 0, 1, 0, 0)" })).toEqual({
      value: NO_TRANSFORM,
      custom: true,
    });
  });

  it("writes the individual properties, and transform only for a skew", () => {
    const styles = { transform: "translateY(-2px) scale(1.05)" };
    const { value } = readTransform(styles);
    expect(transformStyles(styles, { ...value!, x: "8px" })).toEqual({
      translate: "8px -2px",
      scale: "1.05",
      transform: null,
    });
    expect(transformStyles({}, { ...NO_TRANSFORM, scaleX: -1, skewX: 10 })).toEqual({
      scale: "-1 1",
      transform: "skewX(10deg)",
    });
    expect(transformStyles({ translate: "4px" }, NO_TRANSFORM)).toEqual({ translate: null });
    // A move a class draws is covered, not uncovered.
    expect(transformStyles({}, NO_TRANSFORM, { translate: "4px" })).toEqual({ translate: "none" });
    // A transform the controls can't say stays.
    expect(
      transformStyles({ transform: "matrix(1, 0.2, 0, 1, 0, 0)" }, { ...NO_TRANSFORM, x: "1px" }),
    ).toEqual({ translate: "1px" });
  });

  it("turns a quarter at a time, within -180 to 180", () => {
    expect(turned(0, 90)).toBe(90);
    expect(turned(135, 90)).toBe(-135);
    expect(turned(-90, 90)).toBe(0);
    expect(turned(90, 90)).toBe(180);
  });

  it("flips along one axis, keeping the rest of the transform", () => {
    expect(flipStyles({}, "x")).toEqual({ scale: "-1 1" });
    expect(flipStyles({ scale: "-1 1" }, "x")).toEqual({ scale: null });
    expect(flipStyles({ scale: "2", rotate: "10deg" }, "y")).toEqual({ scale: "2 -2" });
    expect(flipsOf({ scale: "-1 1" })).toEqual({ x: true, y: false });
    expect(isFlip("-1 1")).toBe(true);
    expect(isFlip("none")).toBe(true);
    expect(isFlip("1.05")).toBe(false);
  });

  it("reads and writes the rotation Layout shows", () => {
    expect(rotationOf({ transform: "rotate(30deg)" })).toBe(30);
    expect(rotationOf({ rotate: "15deg" })).toBe(15);
    expect(withRotation({ transform: "translateX(4px) rotate(30deg)" }, 60)).toEqual({
      translate: "4px",
      rotate: "60deg",
      transform: null,
    });
    expect(withRotation({ transform: "matrix(1, 0.2, 0, 1, 0, 0)" }, 0)).toEqual({ rotate: null });
  });
});

describe("origin", () => {
  it("reads the 3×3 cell either way round", () => {
    expect(originCell(undefined)).toEqual({ x: 1, y: 1 });
    expect(originCell("left top")).toEqual({ x: 0, y: 0 });
    expect(originCell("top left")).toEqual({ x: 0, y: 0 });
    expect(originCell("top center")).toEqual({ x: 1, y: 0 });
    expect(originCell("bottom")).toEqual({ x: 1, y: 2 });
    expect(originCell("100% 50% 0")).toEqual({ x: 2, y: 1 });
    expect(originCell("10px 20px")).toBeNull();
    expect(originCell("left left")).toBeNull();
    expect(originValue(2, 0)).toBe("right top");
    expect(originValue(1, 1)).toBe("center");
  });
});

describe("reset", () => {
  it("takes off whatever the controls can't read", () => {
    expect(transformResets({ translate: "calc(1px + 2px)" })).toEqual({ translate: null });
    expect(transformResets({ transform: "matrix(1, 0.2, 0, 1, 0, 0)", scale: "2" })).toEqual({
      transform: null,
    });
    expect(transformResets({ scale: "2", transform: "translateX(5px)" })).toEqual({
      transform: null,
    });
    expect(transformResets({}, { translate: "1px 2px 3px" })).toEqual({ translate: "none" });
    const fixed = { translate: "calc(1px + 2px)", transform: "matrix(1, 0.2, 0, 1, 0, 0)" };
    const out = transformResets(fixed);
    expect(readTransform({ ...fixed, ...out } as Record<string, string>).custom).toBe(false);
  });
});

describe("a transform from a class", () => {
  it("reads the browser's matrix for a move and a scale", () => {
    expect(parseTransform("matrix(1.05, 0, 0, 1.05, 0, -2)")?.value).toEqual({
      ...NO_TRANSFORM,
      y: "-2px",
      scaleX: 1.05,
      scaleY: 1.05,
    });
    expect(parseTransform("matrix(0.9, 0.4, -0.4, 0.9, 0, 0)")).toBeNull();
  });

  it("folds a readable one into the edit, and never covers one it can't read", () => {
    const sheet = { transform: "matrix(1, 0, 0, 1, 0, -2)" };
    const { value } = readTransform(withSheet({}, sheet));
    expect(transformStyles({}, { ...value!, x: "8px" }, sheet)).toEqual({
      translate: "8px -2px",
      transform: "none",
    });
    const skewed = { transform: "matrix(1, 0.2, 0, 1, 0, 0)" };
    expect(transformStyles({}, { ...NO_TRANSFORM, x: "8px" }, skewed)).toEqual({
      translate: "8px",
    });
    expect(withRotation({}, 30, skewed)).toEqual({ rotate: "30deg" });
    expect(transformResets({}, skewed)).toEqual({ transform: "none" });
  });
});
