import { describe as suite, expect, it } from "vite-plus/test";
import type { ImportDiagnostic, ImportResult } from "@/api/Api";
import { describe, exportHref, formatOf, LISTED, originalHref, summarize } from "./transfer";

const diagnostic = (overrides: Partial<ImportDiagnostic> = {}): ImportDiagnostic => ({
  path: "html/body/button",
  what: "onclick",
  feature: "script",
  reason: "it could run code",
  preserved: "yes",
  visual: "unknown",
  editable: "no",
  ...overrides,
});

const result = (artboards: number, diagnostics: ImportDiagnostic[] = []): ImportResult => ({
  import: {
    id: "i1",
    artifact: "abc",
    format: "html",
    inputKind: "html",
    receivedAt: 0,
  },
  artboards: Array.from({ length: artboards }, (_, i) => `a${i}`),
  diagnostics,
});

suite("formatOf", () => {
  it("reads the format from the extension, ignoring case", () => {
    expect(formatOf("landing.html")).toBe("html");
    expect(formatOf("Landing.HTM")).toBe("html");
    expect(formatOf("my.design.finite")).toBe("finite");
  });

  it("refuses anything else", () => {
    expect(formatOf("photo.png")).toBeNull();
    expect(formatOf("html")).toBeNull();
    expect(formatOf("notes.html.txt")).toBeNull();
  });
});

suite("links", () => {
  it("export one artboard as HTML, or the whole design as .finite", () => {
    expect(exportHref("d 1", "a/1")).toBe("/api/designs/d%201/export?format=html&artboard=a%2F1");
    expect(exportHref("d1", null)).toBe("/api/designs/d1/export?format=finite");
  });

  it("point at an import's original bytes", () => {
    expect(originalHref("d1", "i1")).toBe("/api/designs/d1/imports/i1/original");
  });
});

suite("describe", () => {
  it("says what was left out, where, and why", () => {
    const line = describe(diagnostic({ quarantined: true, node: "n1" }), () => "Button");
    expect(line).toBe("Left out: onclick on Button — it could run code");
  });

  it("leaves out the node when it has no name", () => {
    expect(describe(diagnostic({ quarantined: true, node: "n1" }))).toBe(
      "Left out: onclick — it could run code",
    );
    expect(describe(diagnostic({ what: "grid" }))).toBe("Note: grid — it could run code");
  });
});

suite("summarize", () => {
  it("counts artboards", () => {
    expect(summarize(result(1)).headline).toBe("Imported 1 artboard.");
    expect(summarize(result(3)).headline).toBe("Imported 3 artboards.");
    expect(summarize(result(0)).headline).toBe("Imported no artboards.");
  });

  it("lists the first few diagnostics and counts the rest", () => {
    const many = Array.from({ length: LISTED + 3 }, (_, i) => diagnostic({ what: `on${i}` }));
    const { lines, more } = summarize(result(1, many));
    expect(lines).toHaveLength(LISTED);
    expect(more).toBe(3);
    expect(summarize(result(1, [diagnostic()])).more).toBe(0);
  });
});
