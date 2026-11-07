import { describe, expect, it } from "vite-plus/test";
import { lightTheme, readTokens, writeToken } from "./tokens.ts";

const CSS = `@import "tailwindcss";

@custom-variant dark (&:where(.dark, .dark *));

:root {
  --surface: #f7f9fa;
}

.dark {
  --surface: #11161a;
}

@theme inline {
  --color-surface: var(--surface);
  --color-primary: #95ced7;
}
`;

describe("tokens", () => {
  it("reads @theme and :root as light, .dark as dark", () => {
    expect(readTokens([CSS])).toEqual([
      { name: "--surface", light: "#f7f9fa", dark: "#11161a" },
      { name: "--color-surface", light: "var(--surface)" },
      { name: "--color-primary", light: "#95ced7" },
    ]);
  });

  it("reads @media (prefers-color-scheme: dark) and @variant dark", () => {
    const css = `@theme { --color-bg: white; }
@media (prefers-color-scheme: dark) { :root { --color-bg: black; } }
:root { @variant dark { --color-fg: gray; } }
`;
    expect(readTokens([css])).toEqual([
      { name: "--color-bg", light: "white", dark: "black" },
      { name: "--color-fg", dark: "gray" },
    ]);
  });

  it("follows var() references for theme matching", () => {
    expect(lightTheme(readTokens([CSS]))["--color-surface"]).toBe("#f7f9fa");
  });

  it("changes a value in place and round-trips", () => {
    const next = writeToken(CSS, "--color-primary", "light", "#a0d8e0");
    expect(next).toBe(CSS.replace("--color-primary: #95ced7", "--color-primary: #a0d8e0"));
    expect(writeToken(next, "--color-primary", "light", "#95ced7")).toBe(CSS);
    const dark = writeToken(CSS, "--surface", "dark", "#000");
    expect(dark).toBe(CSS.replace("--surface: #11161a", "--surface: #000"));
  });

  it("adds new tokens to @theme and the dark block, and removes them", () => {
    let css = writeToken(CSS, "--color-accent", "light", "#ff0");
    css = writeToken(css, "--color-accent", "dark", "#880");
    expect(readTokens([css]).find((t) => t.name === "--color-accent")).toEqual({
      name: "--color-accent",
      light: "#ff0",
      dark: "#880",
    });
    expect(css).toContain(`.dark {
  --surface: #11161a;
  --color-accent: #880;
}`);
    css = writeToken(
      writeToken(css, "--color-accent", "dark", null),
      "--color-accent",
      "light",
      null,
    );
    expect(css).toBe(CSS);
  });

  it("creates @theme after the imports and a .dark rule when a stylesheet has neither", () => {
    let css = writeToken(`@import "tailwindcss";\n`, "--color-x", "light", "red");
    css = writeToken(css, "--color-x", "dark", "blue");
    expect(readTokens([css])).toEqual([{ name: "--color-x", light: "red", dark: "blue" }]);
    expect(css.indexOf("@theme")).toBeGreaterThan(css.indexOf("@import"));
    expect(css).toContain(".dark");
  });
});
