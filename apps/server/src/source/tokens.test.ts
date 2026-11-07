import type { Styling } from "@finite/protocol";
import { describe, expect, it } from "vite-plus/test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import less from "less";
import * as sass from "sass";
import {
  hasToken,
  lightTheme,
  readTokens,
  tokenName,
  useVariables,
  variableSheets,
  writeToken,
} from "./tokens.ts";

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

    it("reads custom properties and the top-level $vars and @vars, in order", () => {
      const scss = readTokens([{ file: "g.scss", css: SCSS }]);
      expect(scss).toEqual([
        { name: "--brand", light: "#95ced7", dark: "#4a8f99" },
        { name: "$gap", light: "4px" },
      ]);
      expect(readTokens([{ file: "g.less", css: LESS }])).toEqual([
        { name: "@gap", light: "4px" },
        { name: "--brand", light: "#95ced7" },
      ]);
    });

    it("leaves out nested variables, Sass flags, Less rulesets and the other dialect's sigil", () => {
      const scss = `$a: 1px !default;\n.x {\n  $local: 2px;\n}\n`;
      expect(readTokens([{ file: "g.scss", css: scss }])).toEqual([{ name: "$a", light: "1px" }]);
      const less = `@a: 1px;\n@set: { color: red; };\n.x {\n  @local: 2px;\n}\n`;
      expect(readTokens([{ file: "g.less", css: less }])).toEqual([{ name: "@a", light: "1px" }]);
      expect(
        variableSheets([
          { file: "g.scss", css: scss },
          { file: "t.less", css: less },
        ]),
      ).toEqual({
        $a: { file: "g.scss", emitsCss: true },
        "@a": { file: "t.less", emitsCss: false },
      });
    });

    it("reads only the $vars of a partial, and knows a partial that outputs no CSS", () => {
      const partial = `@use "sass:math";
// spacing
$gap: 4px !default;
@mixin pad { padding: $gap; }
@function half($x) { @return math.div($x, 2); }
:root {
  --skip: 1px;
}
`;
      const quiet = partial.replace(/:root[^}]*}\n/, "");
      expect(readTokens([{ file: "_t.scss", css: partial, partial: true }])).toEqual([
        { name: "$gap", light: "4px" },
      ]);
      expect(variableSheets([{ file: "_t.scss", css: quiet, partial: true }])).toEqual({
        $gap: { file: "_t.scss", emitsCss: false },
      });
      expect(variableSheets([{ file: "_t.scss", css: partial }]).$gap?.emitsCss).toBe(true);
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

describe("Sass and Less variable tokens", () => {
  const SCSS = `@use "sass:math";\n\n$brand: #95ced7 !default; // cyan\n$gap: 4px;\n\n.a {\n  color: $brand;\n}\n`;
  const LESS = `@import (reference) "./mixins";\n@brand: #95ced7; // cyan\n\n.a {\n  color: @brand;\n}\n`;

  it("takes $ and @ names as they are", () => {
    expect(tokenName("$brand")).toBe("$brand");
    expect(tokenName("@brand")).toBe("@brand");
    expect(tokenName("brand")).toBe("--brand");
    expect(() => tokenName("$1")).toThrow(/Sass variable/);
  });

  it("changes a value in place, keeping !default, and the sheet still compiles", async () => {
    const next = write(SCSS, "$brand", "light", "#111", "g.scss", "css-modules");
    expect(next).toBe(SCSS.replace("#95ced7 !default", "#111 !default"));
    expect(sass.compileString(next).css).toContain("color: #111");
    const nextLess = write(LESS, "@brand", "light", "#111", "g.less", "css-modules");
    expect(nextLess).toBe(LESS.replace("#95ced7", "#111"));
    expect((await less.render(nextLess.replace(/@import[^\n]*\n/, ""))).css).toContain(
      "color: #111",
    );
  });

  it("adds a new variable after the last one, else after the imports, and removes one", () => {
    expect(write(SCSS, "$ink", "light", "#222", "g.scss", "css-modules")).toBe(
      SCSS.replace("$gap: 4px;\n", "$gap: 4px;\n$ink: #222;\n"),
    );
    expect(write(`@use "x";\n\n.a {}\n`, "$ink", "light", "#222", "g.scss", "inline")).toBe(
      `@use "x";\n$ink: #222;\n\n.a {}\n`,
    );
    expect(write(`.a {}\n`, "@ink", "light", "#222", "g.less", "inline")).toBe(
      `@ink: #222;\n\n.a {}\n`,
    );
    expect(write(SCSS, "$gap", "light", null, "g.scss", "css-modules")).toBe(
      SCSS.replace("$gap: 4px;\n", ""),
    );
    expect(write(SCSS, "$none", "light", null, "g.scss", "css-modules")).toBe(SCSS);
  });

  it("refuses a dark value, and a variable in the wrong dialect", () => {
    expect(() => write(SCSS, "$brand", "dark", "#000", "g.scss", "css-modules")).toThrow(
      /\$brand is a Sass variable, which has one value and no dark mode.*--brand/,
    );
    expect(() => write(SCSS, "@brand", "light", "#000", "g.scss", "css-modules")).toThrow(
      /Less variable/,
    );
  });

  describe("used in a module sheet", () => {
    const vars = {
      $brand: { file: "src/styles/_theme.scss", emitsCss: false },
      $shade: { file: "src/styles/global.scss", emitsCss: true },
      "@brand": { file: "src/styles/theme.less", emitsCss: false },
    };
    const use = (file: string, css: string, value: string) =>
      useVariables(file, css, { color: value }, vars);
    const MODULE = `@use "../styles/tokens" as t;\n\n$accent: red;\n\n.card {\n  gap: t.$gap;\n}\n`;

    it("adds @use … as * after the module's own @use", () => {
      const { css, styles } = use("src/c/Card.module.scss", MODULE, "$brand");
      expect(styles).toEqual({ color: "$brand" });
      expect(css).toBe(MODULE.replace(` as t;\n`, ` as t;\n@use "../styles/theme" as *;\n`));
    });

    it("adds the import first when the module has none, and Less gets @import (reference)", () => {
      expect(use("src/c/Card.module.scss", `.card {}\n`, "1px solid $brand").css).toBe(
        `@use "../styles/theme" as *;\n\n.card {}\n`,
      );
      expect(use("src/c/Card.module.less", `@ink: #111; // ink\n.card {}\n`, "@brand").css).toBe(
        `@import (reference) "../styles/theme.less";\n\n@ink: #111; // ink\n.card {}\n`,
      );
      const lessModule = `@import "./mixins.less";\n.card {}\n`;
      expect(use("src/c/Card.module.less", lessModule, "@brand").css).toBe(
        `@import "./mixins.less";\n@import (reference) "../styles/theme.less";\n.card {}\n`,
      );
    });

    it("leaves a module that defines or imports the variable alone, and follows a namespace", () => {
      const own = `$brand: red;\n.card {}\n`;
      expect(use("src/c/Card.module.scss", own, "$brand").css).toBe(own);
      const star = `@use "../styles/theme" as *;\n.card {}\n`;
      expect(use("src/c/Card.module.scss", star, "$brand").css).toBe(star);
      const legacy = `@import "../styles/theme";\n.card {}\n`;
      expect(use("src/c/Card.module.scss", legacy, "$brand").css).toBe(legacy);
      const named = `@use "../styles/theme";\n.card {}\n`;
      expect(use("src/c/Card.module.scss", named, "1px solid $brand")).toEqual({
        css: named,
        styles: { color: "1px solid theme.$brand" },
      });
      const less = `@import (reference) "../styles/theme";\n.card {}\n`;
      expect(use("src/c/Card.module.less", less, "@brand").css).toBe(less);
    });

    it("refuses a $var from a sheet that outputs CSS, unless the module already loads it", () => {
      expect(() => use("src/c/Card.module.scss", `.card {}\n`, "$shade")).toThrow(
        expect.objectContaining({
          code: "unsupported-style",
          message: expect.stringMatching(
            /\$shade is defined in src\/styles\/global\.scss, which also outputs CSS.*Move the \$vars into a partial \(src\/styles\/_tokens\.scss\) that global\.scss @uses/,
          ),
        }),
      );
      const named = `@use "../styles/global" as g;\n.card {}\n`;
      expect(use("src/c/Card.module.scss", named, "$shade")).toEqual({
        css: named,
        styles: { color: "g.$shade" },
      });
    });

    it("refuses another dialect's variable, and one no global sheet defines", () => {
      expect(() => use("src/c/Card.module.less", `.card {}\n`, "$brand")).toThrow(
        expect.objectContaining({
          code: "unsupported-style",
          message: expect.stringMatching(/Sass variable/),
        }),
      );
      expect(() => use("src/c/Card.module.css", `.card {}\n`, "$brand")).toThrow(
        expect.objectContaining({ code: "unsupported-style" }),
      );
      expect(() => use("src/c/Card.module.scss", `.card {}\n`, "$nope")).toThrow(
        expect.objectContaining({ code: "not-found", message: expect.stringMatching(/Tokens/) }),
      );
    });

    it("compiles with sass and less once the import is added", async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "finite-vars-"));
      await mkdir(path.join(dir, "src/styles"), { recursive: true });
      await mkdir(path.join(dir, "src/c"), { recursive: true });
      await writeFile(path.join(dir, "src/styles/_tokens.scss"), `$gap: 4px;\n`);
      await writeFile(path.join(dir, "src/styles/_theme.scss"), `$brand: #95ced7;\n`);
      await writeFile(
        path.join(dir, "src/styles/theme.less"),
        `@brand: #95ced7;\n.global { a: b; }\n`,
      );
      const scss = use("src/c/Card.module.scss", MODULE, "$brand").css.replace(
        ".card {",
        ".card {\n  color: $brand;",
      );
      await writeFile(path.join(dir, "src/c/Card.module.scss"), scss);
      expect(sass.compile(path.join(dir, "src/c/Card.module.scss")).css).toContain(
        "color: #95ced7",
      );
      const lessCss = use("src/c/Card.module.less", `.card {\n  color: @brand;\n}\n`, "@brand").css;
      const out = await less.render(lessCss, {
        filename: path.join(dir, "src/c/Card.module.less"),
      });
      expect(out.css).toContain("color: #95ced7");
      expect(out.css).not.toContain(".global");
    });
  });
});
