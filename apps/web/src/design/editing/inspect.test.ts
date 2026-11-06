import { describe, expect, it } from "vite-plus/test";
import {
  alignCell,
  alignStyles,
  bare,
  customOf,
  declarations,
  fillKindOf,
  firstStop,
  fontMetrics,
  layoutOf,
  layoutStyles,
  ownStyle,
  parseDeclarations,
  parseInput,
  readStyle,
  routeStyles,
  shown,
  trackCount,
  urlOf,
} from "./inspect";

const node = (styles: Record<string, string>) => ({ styles });

describe("readStyle", () => {
  it("shows a value every node sets, with its token", () => {
    const reading = readStyle(
      [node({ color: "var(--fg)" }), node({ color: "var(--fg)" })],
      "color",
      null,
    );
    expect(reading).toEqual({ kind: "value", raw: "var(--fg)", token: "--fg" });
    expect(shown(reading).text).toBe("--fg");
  });

  it("is mixed when nodes disagree, or only some set it", () => {
    expect(readStyle([node({ gap: "4px" }), node({ gap: "8px" })], "gap", null).kind).toBe("mixed");
    expect(readStyle([node({ gap: "4px" }), node({})], "gap", "0px").kind).toBe("mixed");
  });

  it("falls back to the browser's value, shown as a placeholder", () => {
    const reading = readStyle([node({})], "gap", "12px");
    expect(reading).toEqual({ kind: "computed", raw: "12px" });
    expect(shown(reading)).toEqual({ text: "", placeholder: "12px" });
    expect(readStyle([node({})], "gap", null).kind).toBe("unset");
  });

  it("shows a token with a fallback as plain CSS", () => {
    expect(readStyle([node({ color: "var(--fg, red)" })], "color", null)).toMatchObject({
      token: null,
    });
  });
});

describe("parseInput", () => {
  it("adds px to bare numbers on lengths only", () => {
    expect(parseInput("gap", "12")).toBe("12px");
    expect(parseInput("opacity", "0.5")).toBe("0.5");
    expect(parseInput("gap", "1rem")).toBe("1rem");
  });

  it("turns a token name into var() and empty into removal", () => {
    expect(parseInput("background-color", "--surface")).toBe("var(--surface)");
    expect(parseInput("gap", "  ")).toBeNull();
    expect(parseInput("color", "red;")).toBe("red");
  });
});

describe("layout", () => {
  it("round-trips the layout kind", () => {
    for (const kind of ["block", "column", "row", "grid"] as const) {
      const styles = layoutStyles(kind);
      expect(layoutOf(styles.display ?? "block", styles["flex-direction"] ?? "row")).toBe(kind);
    }
  });

  it("maps the align grid by direction", () => {
    expect(alignStyles("row", 2, 1)).toEqual({
      "justify-content": "flex-end",
      "align-items": "center",
    });
    expect(alignCell("column", "flex-end", "center")).toEqual({ x: 1, y: 2 });
    expect(alignCell("row", "space-between", "center")).toBeNull();
  });
});

describe("declarations", () => {
  it("returns what changed, and what was taken out", () => {
    const before = { color: "red", gap: "4px" };
    expect(declarations(before)).toBe("color: red;\ngap: 4px;");
    expect(parseDeclarations("color: blue;\npadding: 8px", before)).toEqual({
      color: "blue",
      padding: "8px",
      gap: null,
    });
  });

  it("keeps semicolons inside quotes and url(), and custom properties' case", () => {
    const before = {
      "background-image": 'url("data:image/svg+xml;base64,PHN2Zy8+")',
      "--Brand": "blue",
      color: "red",
    };
    expect(parseDeclarations(`${declarations(before)}\nCOLOR: green`, before)).toEqual({
      color: "green",
    });
  });

  it("reads a declaration after a comment", () => {
    expect(
      parseDeclarations("color: red; /* spacing */ gap: 8px;", { color: "red", gap: "4px" }),
    ).toEqual({ gap: "8px" });
  });

  it("keeps comments and braces in a value whole", () => {
    const before = {
      color: "red /* ; blue */",
      "--theme": "{ color: red; padding: 4px; }",
      gap: "1px",
    };
    expect(parseDeclarations(declarations(before).replace("1px", "2px"), before)).toEqual({
      gap: "2px",
    });
  });
});

describe("shorthands", () => {
  const card = { border: "1px solid var(--line)", background: "var(--surface)" };

  it("reads a longhand out of the shorthand that sets it", () => {
    expect(ownStyle(card, "border-color")).toBe("var(--line)");
    expect(ownStyle(card, "border-width")).toBe("1px");
    expect(ownStyle(card, "border-style")).toBe("solid");
    expect(ownStyle(card, "border-top-width")).toBe("1px");
    expect(ownStyle(card, "background-color")).toBe("var(--surface)");
    expect(ownStyle({ outline: "2px solid #f00" }, "outline-color")).toBe("#f00");
    expect(ownStyle({ outline: "2px solid #f00" }, "outline-width")).toBe("2px");
    expect(ownStyle({ background: "url(a.png) red" }, "background-color")).toBeUndefined();
    expect(ownStyle({ "border-radius": "8px 4px" }, "border-top-right-radius")).toBe("4px");
    expect(readStyle([node(card)], "border-color", null)).toMatchObject({ token: "--line" });
  });

  it("writes a longhand into the shorthand that sets it", () => {
    expect(routeStyles(card, { "border-color": "red" })).toEqual({ border: "1px solid red" });
    expect(routeStyles(card, { "border-width": "2px" })).toEqual({
      border: "2px solid var(--line)",
    });
    expect(routeStyles(card, { "background-color": null })).toEqual({ background: null });
    expect(routeStyles({ "border-radius": "8px" }, { "border-top-left-radius": "0px" })).toEqual({
      "border-radius": "0px 8px 8px",
    });
    expect(routeStyles({ "border-width": "1px" }, { "border-left-width": "2px" })).toEqual({
      "border-width": "1px 1px 1px 2px",
    });
  });

  it("sets a longhand when the shorthand isn't the only one", () => {
    const sides = { border: "1px solid red", "border-top-width": "2px" };
    expect(routeStyles(sides, { "border-color": "blue" })).toEqual({ "border-color": "blue" });
    expect(routeStyles({ gap: "4px" }, { gap: "8px" })).toEqual({ gap: "8px" });
  });
});

describe("values", () => {
  it("shows lengths without px, and adds it back", () => {
    expect(bare("8px 16px")).toBe("8 16");
    expect(bare("1.5rem")).toBe("1.5rem");
    expect(parseInput("padding", "8 16")).toBe("8px 16px");
  });

  it("reads a font's size and line height", () => {
    expect(fontMetrics("16px/24px Helvetica Neue, sans-serif")).toBe("16 / 24");
    expect(fontMetrics("500 14px Inter")).toBe("14");
    expect(fontMetrics("caption")).toBeNull();
  });
});

describe("fills", () => {
  it("tells a color, gradients and an image apart", () => {
    expect(fillKindOf("none")).toBe("solid");
    expect(fillKindOf("linear-gradient(red, blue)")).toBe("linear");
    expect(fillKindOf("radial-gradient(circle, red, blue)")).toBe("radial");
    expect(fillKindOf('url("a.png")')).toBe("image");
    expect(urlOf('url("https://x.test/a.png")')).toBe("https://x.test/a.png");
    expect(urlOf("url(a.png)")).toBe("a.png");
  });

  it("edits a gradient's first stop, past its direction", () => {
    const stop = firstStop("linear-gradient(to right, var(--brand) 10%, transparent)");
    expect(stop?.color).toBe("var(--brand)");
    expect(stop?.with("#000")).toBe("linear-gradient(to right, #000 10%, transparent)");
    expect(firstStop("radial-gradient(rgb(0, 0, 0), red)")?.color).toBe("rgb(0, 0, 0)");
    expect(firstStop("none")).toBeNull();
  });
});

describe("custom values", () => {
  it("names a value the fields can't show, and lets the rest through", () => {
    expect(customOf("calc(100% - 24px)")).toBe("Calculated value");
    expect(customOf("clamp(1rem, 2vw, 2rem)")).toMatch(/^Clamped/);
    expect(customOf("var(--gap, 8px)")).toBe("Token with a fallback");
    expect(customOf("var(--gap)")).toBeNull();
    expect(customOf("8px 16px")).toBeNull();
    expect(customOf("fit-content")).toBeNull();
  });

  it("reads and writes a grid's column count", () => {
    expect(trackCount("repeat(3, 1fr)")).toBe("3");
    expect(trackCount(parseInput("grid-template-columns", "4")!)).toBe("4");
    expect(trackCount("200px 1fr")).toBeNull();
  });
});

describe("one side of a border", () => {
  it("reads its part of a side's shorthand or of a box value", () => {
    expect(ownStyle({ "border-bottom": "2px solid var(--line)" }, "border-bottom-color")).toBe(
      "var(--line)",
    );
    expect(ownStyle({ "border-bottom": "2px solid" }, "border-bottom-width")).toBe("2px");
    expect(ownStyle({ "border-style": "solid none" }, "border-right-style")).toBe("none");
    expect(ownStyle({ border: "1px solid red" }, "border-left-style")).toBe("solid");
  });
});

describe("routing a side's part", () => {
  it("writes into the side's shorthand when nothing competes", () => {
    expect(
      routeStyles({ "border-bottom": "2px solid #333" }, { "border-bottom-width": "4px" }),
    ).toEqual({
      "border-bottom": "4px solid #333",
    });
    expect(
      routeStyles(
        { "border-bottom": "2px solid #333", "border-bottom-color": "red" },
        { "border-bottom-width": "4px" },
      ),
    ).toEqual({ "border-bottom-width": "4px" });
  });
});
