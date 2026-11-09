import { describe, expect, it } from "vite-plus/test";
import { paintTargets } from "./svgPaint";

type El = { inspection: { tag: string }; paint?: El };
const el = (tag: string, paint?: El): El => ({ inspection: { tag }, ...(paint ? { paint } : {}) });

describe("paintTargets", () => {
  it("reads and writes an <svg>'s one path", () => {
    const path = el("path");
    expect(paintTargets([el("svg", path)])).toEqual({ targets: [path], vector: true });
  });

  it("paints an <svg> without one path on the <svg> itself", () => {
    const svg = el("svg");
    expect(paintTargets([svg])).toEqual({ targets: [svg], vector: true });
  });

  it("paints shapes as SVG", () => {
    expect(paintTargets([el("path"), el("rect")]).vector).toBe(true);
  });

  it("leaves a selection that isn't all SVG to the box sections", () => {
    const svg = el("svg", el("path"));
    const div = el("div");
    expect(paintTargets([svg, div])).toEqual({ targets: [svg, div], vector: false });
  });
});
