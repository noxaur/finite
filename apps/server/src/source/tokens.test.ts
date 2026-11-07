import type { Styling } from "@finite/protocol";
import { describe, expect, it } from "vite-plus/test";
import { hasToken, lightTheme, readTokens, writeToken } from "./tokens.ts";

const read = (...sheets: string[]) => readTokens(sheets.map((css) => ({ file: "app.css", css })));
const write = (
  css: string,
  name: string,
  mode: "light" | "dark",
  value: string | null,
  file = "app.css",
  styling: Styling = "tailwind",
) => writeToken(file, css, name, mode, value, styling);

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
    expect(read(CSS)).toEqual([
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
    expect(read(css)).toEqual([
      { name: "--color-bg", light: "white", dark: "black" },
      { name: "--color-fg", dark: "gray" },
    ]);
  });

  it("follows var() references for theme matching", () => {
    expect(lightTheme(read(CSS))["--color-surface"]).toBe("#f7f9fa");
  });

  it("changes a value in place and round-trips", () => {
    const next = write(CSS, "--color-primary", "light", "#a0d8e0");
    expect(next).toBe(CSS.replace("--color-primary: #95ced7", "--color-primary: #a0d8e0"));
    expect(write(next, "--color-primary", "light", "#95ced7")).toBe(CSS);
    const dark = write(CSS, "--surface", "dark", "#000");
    expect(dark).toBe(CSS.replace("--surface: #11161a", "--surface: #000"));
  });

  it("adds new tokens to @theme and the dark block, and removes them", () => {
    let css = write(CSS, "--color-accent", "light", "#ff0");
    css = write(css, "--color-accent", "dark", "#880");
    expect(read(css).find((t) => t.name === "--color-accent")).toEqual({
      name: "--color-accent",
      light: "#ff0",
      dark: "#880",
    });
    expect(css).toContain(`.dark {
  --surface: #11161a;
  --color-accent: #880;
}`);
    css = write(write(css, "--color-accent", "dark", null), "--color-accent", "light", null);
    expect(css).toBe(CSS);
  });

  it("creates @theme after the imports and a .dark rule when a stylesheet has neither", () => {
    let css = write(`@import "tailwindcss";\n`, "--color-x", "light", "red");
    css = write(css, "--color-x", "dark", "blue");
    expect(read(css)).toEqual([{ name: "--color-x", light: "red", dark: "blue" }]);
    expect(css.indexOf("@theme")).toBeGreaterThan(css.indexOf("@import"));
    expect(css).toContain(".dark");
  });

  describe("in .scss and .less sheets", () => {
    const SCSS = `@use "sass:math";
@use "./tokens";

// Brand colours.
:root {
  --brand: #95ced7; // cyan
}

.dark {
  --brand: #4a8f99;
}

$gap: 4px;
`;
    const LESS = `@import (reference) "./mixins";
@gap: 4px;

// Brand colours.
:root {
  --brand: #95ced7; // cyan
}
`;

    it("reads custom properties and ignores $vars and @vars", () => {
      const scss = readTokens([{ file: "g.scss", css: SCSS }]);
      expect(scss).toEqual([{ name: "--brand", light: "#95ced7", dark: "#4a8f99" }]);
      expect(readTokens([{ file: "g.less", css: LESS }])).toEqual([
        { name: "--brand", light: "#95ced7" },
      ]);
    });

    it("changes a value in place and leaves the rest byte-identical", () => {
      const next = write(SCSS, "--brand", "light", "#fff", "g.scss", "inline");
      expect(next).toBe(SCSS.replace("#95ced7", "#fff"));
      const less = write(LESS, "--brand", "dark", "#000", "g.less", "inline");
      expect(less).toBe(`${LESS}\n.dark {\n  --brand: #000;\n}\n`);
    });

    it("adds a light token to the first :root rule, not @theme, unless the design is Tailwind", () => {
      const next = write(SCSS, "--ink", "light", "#111", "g.scss", "css-modules");
      expect(next).toBe(
        SCSS.replace(
          "  --brand: #95ced7; // cyan\n",
          "  --brand: #95ced7; // cyan\n  --ink: #111;\n",
        ),
      );
      expect(write(SCSS, "--ink", "light", "#111", "g.scss", "tailwind")).toContain("@theme {");
    });

    it("puts a new :root after @use, @forward and @import", () => {
      for (const [file, head] of [
        ["g.scss", `@use "sass:math";\n@forward "./b";\n@import "./c";\n`],
        ["g.less", `@import (reference) "./c";\n`],
        ["g.css", `@import "./c.css";\n`],
      ] as const) {
        const css = `${head}\n.a {\n  color: red;\n}\n`;
        const next = write(css, "--ink", "light", "#111", file, "inline");
        expect(next).toBe(`${head}\n:root {\n  --ink: #111;\n}\n\n.a {\n  color: red;\n}\n`);
        expect(read(next)).toEqual([{ name: "--ink", light: "#111" }]);
      }
    });

    it("puts a new :root first when there is nothing to come after", () => {
      expect(write(`.a {}\n`, "--ink", "light", "#111", "g.scss", "inline")).toBe(
        `:root {\n  --ink: #111;\n}\n\n.a {}\n`,
      );
    });

    it("finds a token in a .scss sheet", () => {
      expect(hasToken("g.scss", SCSS, "--brand", "dark")).toBe(true);
      expect(hasToken("g.scss", SCSS, "--gap", "light")).toBe(false);
    });
  });
});
