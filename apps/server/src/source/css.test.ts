import less from "less";
import * as sass from "sass";
import { describe, expect, it } from "vite-plus/test";
import { editRule } from "./css.ts";

const SCSS = `@use "sass:math";
@use "./tokens" as t;

$gap: 4px; // base gap

// A card.
.card {
  padding: $gap * 2; // inner
  color: t.$ink;
  /* hover */
  &:hover {
    color: red;
  }
  &__title {
    font-weight: bold;
  }
}

@mixin pill($r: 4px) {
  border-radius: $r;
}

.pill {
  @include pill(8px);
}
`;

const LESS = `@gap: 4px; // base gap
@import (reference) "./mixins";

.pill(@r: 4px) {
  border-radius: @r;
}

// A card.
.card {
  padding: (@gap * 2); // inner
  .pill(8px);
  &:hover {
    color: red;
  }
}

.other {
  margin: 0;
}
`;

const compileScss = (css: string) =>
  sass.compileString(css, {
    importers: [
      {
        canonicalize: () => new URL("test:tokens"),
        load: () => ({ contents: "$ink: #111;", syntax: "scss" }),
      },
    ],
  }).css;
const compileLess = async (css: string) =>
  (await less.render(css.replace(/@import[^\n]*\n/, ""))).css;

describe("editRule in .scss", () => {
  it("changes one declaration and leaves every other byte alone", () => {
    const out = editRule("Card.module.scss", SCSS, "card", { color: "blue" });
    expect(out).toBe(SCSS.replace("color: t.$ink;", "color: blue;"));
    expect(compileScss(out)).toContain("color: blue;");
  });

  it("replaces a $variable with the literal value", () => {
    const out = editRule("Card.module.scss", SCSS, "card", { padding: "12px" });
    expect(out).toBe(SCSS.replace("padding: $gap * 2;", "padding: 12px;"));
  });

  it("adds a declaration before the nested rules, keeping the comments", () => {
    const out = editRule("Card.module.scss", SCSS, "card", { margin: "8px" });
    expect(out).toBe(SCSS.replace("  color: t.$ink;\n", "  color: t.$ink;\n  margin: 8px;\n"));
    expect(compileScss(out)).toContain("margin: 8px;");
  });

  it("removes a declaration", () => {
    const out = editRule("Card.module.scss", SCSS, "card", { color: null });
    expect(out).toBe(SCSS.replace("  color: t.$ink;\n", ""));
  });

  it("appends a rule for a class that isn't in the sheet, and the sheet still compiles", () => {
    const out = editRule("Card.module.scss", SCSS, "badge", { color: "blue", fontSize: "12px" });
    expect(out).toBe(`${SCSS}\n.badge {\n  color: blue;\n  font-size: 12px;\n}\n`);
    expect(compileScss(out)).toContain(".badge {\n  color: blue;");
  });

  it("adds after an @include that follows a nested rule, so the new declaration wins", () => {
    const css = `@mixin ink {\n  color: red;\n}\n\n.card {\n  &:hover {\n    opacity: .5;\n  }\n  @include ink;\n}\n`;
    const out = editRule("Card.module.scss", css, "card", { color: "blue" });
    expect(out).toBe(css.replace("  @include ink;\n", "  @include ink;\n  color: blue;\n"));
    expect(compileScss(out)).toMatch(/\.card \{\s*color: red;\s*color: blue;\s*\}/);
  });

  it("edits an existing top-level rule that has @include", () => {
    const out = editRule("Card.module.scss", SCSS, "pill", { color: "blue" });
    expect(out).toBe(
      SCSS.replace("  @include pill(8px);\n", "  @include pill(8px);\n  color: blue;\n"),
    );
    compileScss(out);
  });
});

describe("editRule in .less", () => {
  it("changes one declaration and leaves every other byte alone", async () => {
    const out = editRule("Card.module.less", LESS, "other", { margin: "4px" });
    expect(out).toBe(LESS.replace("margin: 0;", "margin: 4px;"));
    expect(await compileLess(out)).toContain("margin: 4px;");
  });

  it("replaces an @variable expression, keeps the mixin call and adds before the nested rule", async () => {
    const out = editRule("Card.module.less", LESS, "card", { padding: "12px", color: "blue" });
    expect(out).toBe(
      LESS.replace("padding: (@gap * 2);", "padding: 12px;").replace(
        "  .pill(8px);\n",
        "  .pill(8px);\n  color: blue;\n",
      ),
    );
    expect(await compileLess(out)).toContain("padding: 12px;");
  });

  it("adds after a mixin call that follows a nested rule, so the new declaration wins", async () => {
    const css = `.ink() {\n  color: red;\n}\n\n.card {\n  &:hover {\n    opacity: .5;\n  }\n  .ink();\n}\n`;
    const out = editRule("Card.module.less", css, "card", { color: "blue" });
    expect(out).toBe(css.replace("  .ink();\n", "  .ink();\n  color: blue;\n"));
    expect(await compileLess(out)).toMatch(/\.card \{\s*color: red;\s*color: blue;\s*\}/);
  });

  it("adds after a detached-ruleset call that follows a nested rule, so the new declaration wins", async () => {
    const css = `@ink: {\n  color: red;\n};\n\n.card {\n  &:hover {\n    opacity: .5;\n  }\n  @ink();\n}\n`;
    const out = editRule("Card.module.less", css, "card", { color: "blue" });
    expect(out).toBe(css.replace("  @ink();\n", "  @ink();\n  color: blue;\n"));
    expect(await compileLess(out)).toMatch(/\.card \{\s*color: red;\s*color: blue;\s*\}/);
  });

  it("appends a rule for a class that isn't in the sheet", async () => {
    const out = editRule("Card.module.less", LESS, "badge", { color: "blue" });
    expect(out).toBe(`${LESS}\n.badge {\n  color: blue;\n}\n`);
    expect(await compileLess(out)).toContain(".badge {\n  color: blue;");
  });
});

describe("editRule refusals", () => {
  const nested = {
    ".css": `.list .card {\n  color: red;\n}\n`,
    ".scss": `.list {\n  .card {\n    color: red;\n  }\n}\n`,
    ".less": `.list {\n  .card {\n    color: red;\n  }\n}\n`,
  };
  for (const [ext, css] of Object.entries(nested)) {
    it(`refuses a class that only appears nested or in a compound selector in ${ext}`, () => {
      expect(() => editRule(`A.module${ext}`, css, "card", { color: "blue" })).toThrow(
        expect.objectContaining({
          code: "unsupported-style",
          message: expect.stringContaining(".card"),
        }),
      );
    });
  }

  it("refuses a class defined through &-suffix nesting", () => {
    const css = `.card {\n  &__title {\n    color: red;\n  }\n}\n`;
    expect(() => editRule("A.module.scss", css, "card__title", { color: "blue" })).toThrow(
      expect.objectContaining({ code: "unsupported-style" }),
    );
    // The parent itself still has a top-level rule.
    expect(editRule("A.module.scss", css, "card", { color: "blue" })).toContain("color: blue");
  });

  it("refuses a compound selector with no plain rule, even when removing", () => {
    expect(() =>
      editRule("A.module.css", `.card.on {\n  color: red;\n}\n`, "card", { color: null }),
    ).toThrow(expect.objectContaining({ code: "unsupported-style" }));
  });

  it("still adds a rule for a class that is a longer name's prefix", () => {
    const css = `.card-title {\n  color: red;\n}\n`;
    expect(editRule("A.module.css", css, "card", { color: "blue" })).toBe(
      `${css}\n.card {\n  color: blue;\n}\n`,
    );
  });

  it("refuses indented Sass with a message that says what to do", () => {
    expect(() =>
      editRule("Card.module.sass", ".card\n  color: red\n", "card", { color: "blue" }),
    ).toThrow(
      expect.objectContaining({
        code: "unsupported-style",
        message: expect.stringMatching(/indented Sass.*Ask the agent.*\.scss/),
      }),
    );
  });
});
