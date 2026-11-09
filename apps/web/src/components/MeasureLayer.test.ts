import { readFileSync } from "node:fs";
import { MEASURE_PURPLE, type Measurement } from "@finite/protocol";
import { describe, expect, it, vi } from "vite-plus/test";
import type { Probe } from "@/canvas/editor";

vi.mock("@stylexjs/stylex", () => ({
  create: () => ({}),
  props: () => ({}),
}));
vi.mock("@/styles/tokens.stylex", () => ({
  colors: {},
  fonts: {},
  radii: {},
  size: {},
  space: {},
}));
vi.mock("@/client/finite", () => ({ finite: {} }));

const { figuresOf, zoomStepOf } = await import("./MeasureLayer");
const { distanceText, gapChips, specRows } = await import("./MeasureCard");

const element = (over: Partial<Measurement> = {}): Measurement => ({
  tag: "div",
  name: "div",
  loc: "src/App.tsx:3:2",
  index: 0,
  count: 1,
  box: { x: 0, y: 0, width: 100, height: 40 },
  padding: { top: 0, right: 0, bottom: 0, left: 0 },
  border: { top: 0, right: 0, bottom: 0, left: 0 },
  margin: { top: 0, right: 0, bottom: 0, left: 0 },
  radius: { topLeft: 0, topRight: 0, bottomRight: 0, bottomLeft: 0 },
  axisAligned: true,
  flow: "block",
  children: [],
  childCount: 0,
  gaps: [],
  style: {},
  ...over,
});

const probe = (frameId: string, over: Partial<Measurement> = {}): Probe => ({
  frameId,
  target: { at: { x: 0, y: 0 } },
  m: element(over),
});

const other = { loc: "src/App.tsx:9:4" };

describe("the figures the measure tool draws", () => {
  it("draws nothing with nothing measured", () => {
    expect(figuresOf({ hover: null, pin: null, up: 0 })).toEqual([]);
  });

  it("draws the hovered element alone", () => {
    const hover = probe("a");
    expect(figuresOf({ hover, pin: null, up: 0 })).toEqual([
      { frameId: "a", figure: { target: hover.m } },
    ]);
  });

  it("compares the pin with another element in its frame", () => {
    const pin = probe("a");
    const hover = probe("a", other);
    expect(figuresOf({ hover, pin, up: 0 })).toEqual([
      { frameId: "a", figure: { target: pin.m, other: hover.m } },
    ]);
  });

  it("draws the pin once when the pointer is on it", () => {
    const pin = probe("a");
    expect(figuresOf({ hover: probe("a"), pin, up: 0 })).toEqual([
      { frameId: "a", figure: { target: pin.m } },
    ]);
  });

  it("tells apart two instances of one loc", () => {
    const pin = probe("a");
    const hover = probe("a", { index: 1 });
    expect(figuresOf({ hover, pin, up: 0 })[0]?.figure).toHaveProperty("other", hover.m);
  });

  it("shows a hover in another frame on its own", () => {
    const pin = probe("a");
    const hover = probe("b", other);
    expect(figuresOf({ hover, pin, up: 0 })).toEqual([
      { frameId: "a", figure: { target: pin.m } },
      { frameId: "b", figure: { target: hover.m } },
    ]);
  });
});

describe("the zoom the drawing is laid out for", () => {
  it("moves in quarter octaves", () => {
    expect(zoomStepOf(1)).toBe(1);
    expect(zoomStepOf(1.05)).toBe(1);
    expect(zoomStepOf(2)).toBe(2);
    expect(zoomStepOf(1.2)).toBeCloseTo(2 ** 0.25);
  });
});

describe("what the card shows", () => {
  const titles = (m: Measurement) => specRows(m).map((s) => s.title);
  const labels = (m: Measurement) => specRows(m).flatMap((s) => s.rows.map((r) => r.label));

  it("skips rows at their CSS initial value and the sections they empty", () => {
    const m = element({
      style: {
        display: "inline",
        position: "static",
        minWidth: "0px",
        backgroundColor: "rgba(0, 0, 0, 0)",
        boxShadow: "none",
        opacity: "1",
      },
    });
    expect(specRows(m)).toEqual([]);
  });

  it("keeps what was set, in SPEC order", () => {
    const m = element({ style: { position: "sticky", display: "flex", opacity: "0.5" } });
    expect(labels(m)).toEqual(["Display", "Position", "Opacity"]);
    expect(titles(m)).toEqual(["Layout", "Fill"]);
  });

  it("shows a border color only on an element with a border", () => {
    const style = { borderTopColor: "rgb(1, 2, 3)" };
    expect(labels(element({ style }))).toEqual([]);
    const border = { top: 1, right: 0, bottom: 0, left: 0 };
    expect(labels(element({ style, border }))).toEqual(["Border"]);
  });

  it("reads colors as hex, keeping alpha and anything it can't convert", () => {
    const value = (backgroundColor: string) =>
      specRows(element({ style: { backgroundColor } }))[0]?.rows[0]?.value;
    expect(value("rgb(42, 47, 50)")).toBe("#2a2f32");
    expect(value("rgba(42, 47, 50, 0.5)")).toBe("#2a2f32 50%");
    expect(value("oklch(0.5 0.1 200)")).toBe("oklch(0.5 0.1 200)");
  });

  it("names a font stack by its first family and keeps the whole stack", () => {
    const fontFamily = '"Inter Variable", ui-sans-serif, system-ui, sans-serif';
    const [row] = specRows(element({ style: { fontFamily } }))[0]!.rows;
    expect(row).toMatchObject({ value: "Inter Variable", raw: fontFamily });
  });

  it("groups equal gaps and leaves out children that touch", () => {
    const gap = (size: number, cause: "gap" | "margin" | "free", axis: "x" | "y" = "y") => ({
      axis,
      size,
      cause,
      rect: { x: 0, y: 0, width: 1, height: 1 },
      between: [0, 1] as [number, number],
    });
    expect(gapChips([gap(8, "gap"), gap(0, "free"), gap(8, "gap"), gap(8, "margin")])).toEqual([
      { axis: "y", size: 8, cause: "gap", count: 2 },
      { axis: "y", size: 8, cause: "margin", count: 1 },
    ]);
  });

  it("words a distance by how the two elements sit", () => {
    const line = { from: { x: 0, y: 0 }, to: { x: 0, y: 0 } };
    expect(
      distanceText({
        relation: "apart",
        lines: [
          { side: "right", size: 24, ...line },
          { side: "bottom", size: 8.5, ...line },
        ],
      }),
    ).toEqual({ word: "Distance", values: ["→ 24", "↓ 8.5"] });
    expect(distanceText({ relation: "overlap", lines: [] })).toEqual({
      word: "Overlaps",
      values: [],
    });
  });
});

describe("the measure color", () => {
  it("is the same in the tokens and in the drawing", () => {
    const tokens = readFileSync(new URL("../styles/tokens.stylex.ts", import.meta.url), "utf8");
    expect(/\bmeasure: "(#[0-9a-f]{6})"/.exec(tokens)?.[1]).toBe(MEASURE_PURPLE);
  });
});
