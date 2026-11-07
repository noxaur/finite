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
  variableHome,
  variableRefs,
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

  describe("review edge cases", () => {
    const Module = "src/c/Card.module.scss";
    const sheetsOf = (files: Record<string, string>) =>
      Object.entries(files).map(([file, css]) => ({
        file,
        css,
        partial: !file.includes("global"),
      }));
    const pick = (files: Record<string, string>, name = "$brand") =>
      useVariables(Module, `.card {}\n`, { color: name }, variableSheets(sheetsOf(files)));
    const refused = (message: RegExp) =>
      expect.objectContaining({
        code: "unsupported-style",
        message: expect.stringMatching(message),
      });

    it("writes to the last declaration of a name, the one that reads", () => {
      const less = `@brand: red;\n@brand: blue;\n`;
      expect(readTokens([{ file: "g.less", css: less }])).toEqual([
        { name: "@brand", light: "blue" },
      ]);
      expect(write(less, "@brand", "light", "green", "g.less", "inline")).toBe(
        `@brand: red;\n@brand: green;\n`,
      );
      expect(write(less, "@brand", "light", null, "g.less", "inline")).toBe(`@brand: red;\n`);
      const scss = `$brand: red;\n$brand: blue;\n`;
      expect(write(scss, "$brand", "light", "green", "g.scss", "inline")).toBe(
        `$brand: red;\n$brand: green;\n`,
      );
    });

    it("sends a variable to the last file that declares it", () => {
      const sheets = [
        { file: "a.scss", css: `$brand: red;\n` },
        { file: "b.scss", css: `$brand: blue;\n` },
      ];
      expect(variableHome("$brand", sheets).file).toBe("b.scss");
      expect(variableSheets(sheets).$brand?.file).toBe("b.scss");
    });

    it("refuses a partial whose $vars come through a legacy @import chain", async () => {
      const files: Record<string, string> = {
        "src/styles/global.scss": `@import "base";\n@import "tokens";\n`,
        "src/styles/_base.scss": `$base: red;\n`,
        "src/styles/_tokens.scss": `$brand: $base;\n`,
      };
      expect(() => pick(files)).toThrow(
        refused(/\$brand is defined in src\/styles\/_tokens\.scss.*\$base.*@use "base" as \*/),
      );
      const dir = await mkdtemp(path.join(tmpdir(), "finite-chain-"));
      await mkdir(path.join(dir, "src/styles"), { recursive: true });
      await mkdir(path.join(dir, "src/c"), { recursive: true });
      const compile = async () => {
        for (const [file, css] of Object.entries(files)) await writeFile(path.join(dir, file), css);
        const css = `@use "../styles/tokens" as *;\n.card {\n  color: $brand;\n}\n`;
        await writeFile(path.join(dir, Module), css);
        return sass.compile(path.join(dir, Module)).css;
      };
      await expect(compile()).rejects.toThrow(/Undefined variable/);
      files["src/styles/_tokens.scss"] = `@use "base" as *;\n$brand: $base;\n`;
      const picked = pick(files);
      expect(picked.css).toBe(`@use "../styles/tokens" as *;\n\n.card {}\n`);
      expect(await compile()).toContain("color: red");
    });

    it("lists no private $vars", () => {
      const css = `$_hidden: 1px;\n$-also: 2px;\n$shown: 3px;\n`;
      expect(readTokens([{ file: "g.scss", css }])).toEqual([{ name: "$shown", light: "3px" }]);
      expect(Object.keys(variableSheets([{ file: "g.scss", css }]))).toEqual(["$shown"]);
      const own = `$_gap: 1px;\n.card {}\n`;
      expect(useVariables(Module, own, { padding: "$_gap" }, {}).css).toBe(own);
    });

    it("counts a module's own private $vars as defined", () => {
      const files = {
        "src/styles/global.scss": `@use "tokens";\n`,
        "src/styles/_tokens.scss": `$_base: red;\n$brand: $_base;\n`,
      };
      expect(variableSheets(sheetsOf(files)).$brand?.unresolved).toBeUndefined();
      expect(pick(files).css).toBe(`@use "../styles/tokens" as *;\n\n.card {}\n`);
      const hidden = {
        ...files,
        "src/styles/_other.scss": `$_base: blue;\n`,
        "src/styles/_tokens.scss": `@use "other" as *;\n$brand: $_base;\n`,
      };
      expect(variableSheets(sheetsOf(hidden)).$brand?.unresolved).toEqual({ name: "$_base" });
    });

    it("needs @use … as * for bare names, and follows @forward through it", () => {
      const files: Record<string, string> = {
        "src/styles/global.scss": `@use "tokens";\n`,
        "src/styles/_base.scss": `$base: red;\n`,
        "src/styles/_tokens.scss": `@use "base";\n$brand: $base;\n`,
      };
      expect(() => pick(files)).toThrow(refused(/\$brand is defined in .*_tokens\.scss.*\$base/));
      files["src/styles/_tokens.scss"] = `@use "base" as b;\n$brand: $base;\n`;
      expect(() => pick(files)).toThrow(refused(/\$base/));
      files["src/styles/_tokens.scss"] = `@use "base" as *;\n$brand: $base;\n`;
      expect(variableSheets(sheetsOf(files)).$brand?.unresolved).toBeUndefined();
      files["src/styles/_tokens.scss"] = `@use "api" as *;\n$brand: $base;\n`;
      files["src/styles/_api.scss"] = `@forward "base";\n`;
      expect(variableSheets(sheetsOf(files)).$brand?.unresolved).toBeUndefined();
      files["src/styles/_tokens.scss"] = `@use "api";\n$brand: $base;\n`;
      expect(variableSheets(sheetsOf(files)).$brand?.unresolved).toEqual({
        name: "$base",
        definedIn: "src/styles/_base.scss",
      });
    });

    it("treats a $var inside url() as a reference, and a quoted url as text", () => {
      expect(variableRefs({ backgroundImage: `url($asset)` })).toEqual(["$asset"]);
      expect(variableRefs({ backgroundImage: `url("#{$asset}")` })).toEqual(["$asset"]);
      expect(variableRefs({ backgroundImage: `url("$asset")` })).toEqual([]);
      expect(variableRefs({ backgroundImage: `url(/img/logo.png)` })).toEqual([]);
      const named = `@use "../styles/theme";\n.card {}\n`;
      const vars = { $asset: { file: "src/styles/_theme.scss", emitsCss: false } };
      expect(
        useVariables(Module, named, { backgroundImage: `url($asset) url("/a/b.png")` }, vars).styles
          .backgroundImage,
      ).toBe(`url(theme.$asset) url("/a/b.png")`);
      expect(useVariables(Module, `.card {}\n`, { backgroundImage: `url($asset)` }, vars).css).toBe(
        `@use "../styles/theme" as *;\n\n.card {}\n`,
      );
    });

    it("counts a @use, @forward or @import of a .css file as CSS", () => {
      for (const rule of [
        `@use "reset.css";`,
        `@forward "reset.css";`,
        `@import "reset.css";`,
        `@import url(reset.css);`,
        `@import url("https://example.com/reset.css");`,
      ]) {
        const files = {
          "src/styles/global.scss": `@use "tokens";\n`,
          "src/styles/_tokens.scss": `${rule}\n$brand: red;\n`,
        };
        expect(variableSheets(sheetsOf(files)).$brand?.emitsCss, rule).toBe(true);
      }
    });

    it("skips quoted text and url() when it looks for variables", () => {
      expect(variableRefs({ backgroundImage: `url("/images/@logo.svg")` })).toEqual([]);
      expect(variableRefs({ backgroundImage: `url(/images/@logo.svg)` })).toEqual([]);
      expect(variableRefs({ content: `"$brand" '@brand'` })).toEqual([]);
      expect(variableRefs({ border: `1px solid $brand`, content: `"#{$ink}"` })).toEqual([
        "$brand",
        "$ink",
      ]);
      const named = `@use "../styles/theme";\n.card {}\n`;
      const vars = { $brand: { file: "src/styles/_theme.scss", emitsCss: false } };
      expect(useVariables(Module, named, { content: `"$brand" $brand` }, vars).styles.content).toBe(
        `"$brand" theme.$brand`,
      );
    });

    it("counts the CSS that a @use or @forward brings in", () => {
      const files = {
        "src/styles/global.scss": `@use "tokens";\n`,
        "src/styles/_tokens.scss": `@use "reset";\n$brand: red;\n`,
        "src/styles/_reset.scss": `* {\n  margin: 0;\n}\n`,
      };
      expect(variableSheets(sheetsOf(files)).$brand?.emitsCss).toBe(true);
      expect(() => pick(files)).toThrow(refused(/also outputs CSS/));
      const forwarded = {
        ...files,
        "src/styles/_tokens.scss": `@forward "reset";\n$brand: red;\n`,
      };
      expect(variableSheets(sheetsOf(forwarded)).$brand?.emitsCss).toBe(true);
      const quiet = { ...files, "src/styles/_reset.scss": `$ink: black;\n` };
      expect(variableSheets(sheetsOf(quiet)).$brand?.emitsCss).toBe(false);
      const loop = {
        "src/styles/_a.scss": `@use "b";\n$brand: red;\n`,
        "src/styles/_b.scss": `@use "a";\n`,
      };
      expect(variableSheets(sheetsOf(loop)).$brand?.emitsCss).toBe(false);
    });
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
