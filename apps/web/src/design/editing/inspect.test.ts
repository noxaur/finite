import { describe, expect, it } from "vite-plus/test";
import {
  alignCell,
  alignStyles,
  declarations,
  layoutOf,
  layoutStyles,
  parseDeclarations,
  parseInput,
  readStyle,
  shown,
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
