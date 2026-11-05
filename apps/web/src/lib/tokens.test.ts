import { describe, expect, test } from "vite-plus/test";
import { aliasOf, bezierOf, displayName } from "./tokens";

describe("aliasOf", () => {
  test("names the token a whole-value var() points at", () => {
    expect(aliasOf("var(--blue-500)")).toBe("--blue-500");
    expect(aliasOf(" var( --blue-500 ) ")).toBe("--blue-500");
  });

  test("is undefined for raw values and var() inside a larger value", () => {
    expect(aliasOf("#3478ba")).toBeUndefined();
    expect(aliasOf("0 1px var(--shadow)")).toBeUndefined();
    expect(aliasOf("var(--a, red)")).toBeUndefined();
    expect(aliasOf(undefined)).toBeUndefined();
  });
});

test("displayName drops only the leading dashes", () => {
  expect(displayName("--brand-text")).toBe("brand-text");
});

describe("bezierOf", () => {
  test("reads cubic-bezier() and the named easings", () => {
    expect(bezierOf("cubic-bezier(.23, 1, .32, 1)")).toEqual([0.23, 1, 0.32, 1]);
    expect(bezierOf("ease-out")).toEqual([0, 0, 0.58, 1]);
  });

  test("is undefined for durations and malformed curves", () => {
    expect(bezierOf("200ms")).toBeUndefined();
    expect(bezierOf("cubic-bezier(1, 2)")).toBeUndefined();
  });
});
