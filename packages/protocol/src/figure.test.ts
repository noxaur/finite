import { describe, expect, test } from "vite-plus/test";
import {
  annotate,
  distanceBetween,
  drawFigure,
  type Figure,
  figureRootCss,
  MEASURE_PURPLE,
  paint,
  placePills,
} from "./figure.ts";
import { Measurement } from "./measure.ts";

const zero = { top: 0, right: 0, bottom: 0, left: 0 };
const square = { topLeft: 0, topRight: 0, bottomRight: 0, bottomLeft: 0 };

function element(overrides: Partial<Measurement> = {}): Measurement {
  return Measurement.parse({
    tag: "div",
    name: "Card",
    index: 0,
    count: 1,
    box: { x: 100, y: 100, width: 200, height: 100 },
    padding: zero,
    border: zero,
    margin: zero,
    radius: square,
    axisAligned: true,
    flow: "block",
    children: [],
    childCount: 0,
    gaps: [],
    style: {},
    ...overrides,
  });
}

const rect = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });
const pillsOf = (figure: Figure) => annotate(figure).filter((mark) => mark.kind === "pill");
const pillTexts = (figure: Figure) =>
  pillsOf(figure).map((mark) => (mark.kind === "pill" ? mark.text : ""));

describe("distanceBetween", () => {
  test("apart on one axis is one line through the shared span", () => {
    const { relation, lines } = distanceBetween(rect(0, 0, 10, 20), rect(30, 10, 10, 20));
    expect(relation).toBe("apart");
    expect(lines).toEqual([
      { side: "right", size: 20, from: { x: 10, y: 15 }, to: { x: 30, y: 15 } },
    ]);
  });

  test("apart on both axes is one line per axis", () => {
    const { relation, lines } = distanceBetween(rect(0, 0, 10, 10), rect(30, 40, 10, 10));
    expect(relation).toBe("apart");
    expect(lines.map((line) => [line.side, line.size])).toEqual([
      ["right", 20],
      ["bottom", 30],
    ]);
  });

  test("sides read from the first rect", () => {
    const { lines } = distanceBetween(rect(50, 50, 10, 10), rect(0, 0, 10, 10));
    expect(lines.map((line) => line.side)).toEqual(["left", "top"]);
  });

  test("touching rects are apart by 0, not overlapping", () => {
    const { relation, lines } = distanceBetween(rect(0, 0, 10, 10), rect(10, 0, 10, 10));
    expect(relation).toBe("apart");
    expect(lines.map((line) => line.size)).toEqual([0]);
  });

  test("inside is four lines from the inner edges, in either argument order", () => {
    const outer = rect(0, 0, 100, 100);
    const inner = rect(10, 20, 50, 30);
    for (const [a, b] of [
      [outer, inner],
      [inner, outer],
    ] as const) {
      const { relation, lines } = distanceBetween(a, b);
      expect(relation).toBe("inside");
      expect(lines.map((line) => [line.side, line.size])).toEqual([
        ["top", 20],
        ["right", 40],
        ["bottom", 50],
        ["left", 10],
      ]);
    }
  });

  test("partial overlap has no lines", () => {
    expect(distanceBetween(rect(0, 0, 50, 50), rect(25, 25, 50, 50))).toEqual({
      relation: "overlap",
      lines: [],
    });
  });

  test("sizes are rounded to 2 decimals", () => {
    const { lines } = distanceBetween(rect(0, 0, 10.1, 10), rect(10.33, 0, 10, 10));
    expect(lines[0]?.size).toBe(0.23);
  });
});

describe("annotate", () => {
  test("collapses padding pills but keeps a band per side", () => {
    const padding = (top: number, right: number, bottom: number, left: number) =>
      element({ padding: { top, right, bottom, left } });
    const count = (m: Measurement) => ({
      pills: pillTexts({ target: m }).length - 1,
      bands: annotate({ target: m }).filter((mark) => mark.kind === "band").length,
    });
    expect(count(padding(8, 8, 8, 8))).toEqual({ pills: 1, bands: 4 });
    expect(count(padding(8, 16, 8, 16))).toEqual({ pills: 2, bands: 4 });
    expect(count(padding(1, 2, 3, 4))).toEqual({ pills: 4, bands: 4 });
    expect(count(padding(0, 16, 0, 16))).toEqual({ pills: 1, bands: 2 });
  });

  test("ranks size first, then radius, gaps, padding, margin and children", () => {
    const figure: Figure = {
      target: element({
        radius: { topLeft: 20, topRight: 20, bottomRight: 20, bottomLeft: 20 },
        padding: { top: 12, right: 12, bottom: 12, left: 12 },
        margin: { top: 24, right: 24, bottom: 24, left: 24 },
        gaps: [{ axis: "x", size: 8, rect: rect(150, 110, 8, 80), between: [0, 1], cause: "gap" }],
        children: [{ tag: "img", name: "Logo", rect: rect(110, 110, 40, 40) }],
      }),
    };
    expect(pillTexts(figure)).toEqual(["200 × 100", "r 20", "8", "12", "24", "40 × 40"]);
  });

  test("skips bands, gaps and children when the element isn't axis-aligned", () => {
    const marks = annotate({
      target: element({
        axisAligned: false,
        padding: { top: 12, right: 12, bottom: 12, left: 12 },
        gaps: [{ axis: "x", size: 8, rect: rect(150, 110, 8, 80), between: [0, 1], cause: "gap" }],
        children: [{ tag: "img", name: "Logo", rect: rect(110, 110, 40, 40) }],
      }),
    });
    expect(marks.map((mark) => mark.kind)).toEqual(["outline", "pill"]);
  });

  test("two elements get outlines, sizes and the distance", () => {
    const figure: Figure = {
      target: element(),
      other: element({ box: rect(100, 300, 200, 50) }),
    };
    expect(pillTexts(figure)).toEqual(["100", "200 × 100", "200 × 50"]);
    expect(annotate(figure).some((mark) => mark.kind === "line")).toBe(true);
  });

  test("touching gaps draw nothing", () => {
    const figure: Figure = {
      target: element({
        gaps: [
          { axis: "y", size: 0, rect: rect(100, 150, 200, 0), between: [0, 1], cause: "free" },
        ],
      }),
    };
    expect(annotate(figure).some((mark) => mark.kind === "gap")).toBe(false);
  });
});

describe("a comparison's pills", () => {
  test("keep the distance when a size pill would take its spot", () => {
    const at = (y: number) => element({ box: rect(0, y, 200, 40) });
    const { html } = drawFigure({ target: at(0), other: at(60) }, 1);
    expect(html).toContain(">20<");
  });
});

describe("placePills", () => {
  const crowded: Figure = {
    target: element({
      box: rect(0, 0, 200, 100),
      children: [
        { tag: "a", name: "A", rect: rect(10, 10, 20, 20) },
        { tag: "b", name: "B", rect: rect(34, 10, 20, 20) },
        { tag: "c", name: "C", rect: rect(58, 10, 20, 20) },
      ],
    }),
  };

  test("drops the lowest-priority colliding pills at low zoom", () => {
    const { marks, hidden } = placePills(annotate(crowded), 0.5);
    expect(hidden).toBe(2);
    const kept = marks.flatMap((mark) => (mark.kind === "pill" ? [mark.text] : []));
    expect(kept).toEqual(["200 × 100", "20 × 20"]);
  });

  test("keeps them all at high zoom", () => {
    const { marks, hidden } = placePills(annotate(crowded), 4);
    expect(hidden).toBe(0);
    expect(marks.filter((mark) => mark.kind === "pill")).toHaveLength(4);
  });

  test("nudges a colliding band pill along its normal before dropping it", () => {
    const twin: Measurement["gaps"][number] = {
      axis: "y",
      size: 12,
      rect: rect(100, 150, 200, 12),
      between: [0, 1],
      cause: "gap",
    };
    const { marks, hidden } = placePills(
      annotate({ target: element({ gaps: [twin, { ...twin, size: 14 }] }) }),
      1,
    );
    expect(hidden).toBe(0);
    const offsets = marks.flatMap((mark) =>
      mark.kind === "pill" && (mark.text === "12" || mark.text === "14")
        ? [mark.screenOffset?.y]
        : [],
    );
    expect(offsets[0]).toBe(0);
    expect(offsets[1]).not.toBe(0);
  });

  test("does not draw a pill on a band under about 3 screen px", () => {
    const figure: Figure = {
      target: element({ padding: { top: 4, right: 4, bottom: 4, left: 4 } }),
    };
    const padding = (zoom: number) =>
      placePills(annotate(figure), zoom).marks.filter(
        (mark) => mark.kind === "pill" && mark.text === "4",
      );
    expect(padding(0.5)).toHaveLength(0);
    expect(padding(1)).toHaveLength(1);
    expect(placePills(annotate(figure), 0.5).hidden).toBe(1);
  });
});

describe("drawFigure", () => {
  const full: Figure = {
    target: element({
      radius: { topLeft: 20, topRight: 20, bottomRight: 20, bottomLeft: 20 },
      padding: { top: 12, right: 16, bottom: 12, left: 16 },
      border: { top: 1, right: 1, bottom: 1, left: 1 },
      margin: { top: 24, right: 0, bottom: 24, left: 0 },
      gaps: [{ axis: "x", size: 8, rect: rect(150, 110, 8, 80), between: [0, 1], cause: "gap" }],
      children: [{ tag: "img", name: "Logo", rect: rect(110, 110, 40, 40) }],
    }),
  };

  test("holds no colour literals, only the two variables", () => {
    const { html } = drawFigure(full, 1);
    expect(html).toContain("var(--measure)");
    expect(html).toContain("var(--measure-on)");
    expect(html).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(html).not.toMatch(/\b(red|pink|crimson|magenta|fuchsia|rose|white(?!-space))\b/i);
  });

  test("keeps the hatch and pills at screen size through --inv-zoom", () => {
    const { html } = drawFigure(full, 1);
    expect(html).toMatch(/repeating-linear-gradient\(135deg, var\(--measure\) 0 calc\(/);
    expect(html).toContain("scale(var(--inv-zoom, 1))");
  });

  test("reports what placement dropped", () => {
    const tiny: Figure = {
      target: element({ padding: { top: 2, right: 2, bottom: 2, left: 2 } }),
    };
    expect(drawFigure(tiny, 1).hidden).toBe(1);
    expect(drawFigure(tiny, 4).hidden).toBe(0);
  });

  test("escapes pill text", () => {
    const html = paint([{ kind: "pill", at: { x: 0, y: 0 }, text: `<img src=x onerror="a">` }]);
    expect(html).not.toContain("<img");
    expect(html).toContain("&#60;img");
  });
});

test("figureRootCss supplies every variable the markup reads", () => {
  const css = figureRootCss(2);
  expect(css).toContain("--inv-zoom:0.5;");
  expect(css).toContain(`--measure:${MEASURE_PURPLE};`);
  expect(css).toContain("--measure-on:#f8f9f9;");
  expect(css).not.toMatch(/#fff(fff)?\b/i);
});

test("MEASURE_PURPLE is the agreed value", () => {
  expect(MEASURE_PURPLE).toBe("#8b3ff0");
});
