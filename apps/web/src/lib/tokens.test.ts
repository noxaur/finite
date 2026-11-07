import { describe, expect, test } from "vite-plus/test";
import { aliasOf, bezierOf, displayName, resolveToken, tokenRef } from "./tokens";

describe("aliasOf", () => {
  test("names the token a whole-value var() points at", () => {
    expect(aliasOf("var(--blue-500)")).toBe("--blue-500");
    expect(aliasOf(" var( --blue-500 ) ")).toBe("--blue-500");
  });

  test("names a whole-value Sass or Less variable", () => {
    expect(aliasOf("$brand")).toBe("$brand");
    expect(aliasOf(" @line ")).toBe("@line");
    expect(aliasOf("1px solid $line")).toBeUndefined();
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
  expect(displayName("$brand")).toBe("$brand");
});

test("tokenRef writes var() for a custom property and the bare name for a variable", () => {
  expect(tokenRef("--brand")).toBe("var(--brand)");
  expect(tokenRef("$brand")).toBe("$brand");
  expect(tokenRef("@brand")).toBe("@brand");
});

test("resolveToken follows a variable that names another", () => {
  const table = {
    modes: [{ id: "light", name: "Light" }],
    tokens: { $brand: { light: "$cyan" }, $cyan: { light: "#95ced7" } },
  };
  expect(resolveToken(table, "$brand", "dark")).toBe("#95ced7");
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
