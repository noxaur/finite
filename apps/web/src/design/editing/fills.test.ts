import { describe, expect, it } from "vite-plus/test";
import {
  backgroundOf,
  cellOf,
  cellPosition,
  expandBackground,
  fillText,
  fitOf,
  type FillLayer,
  layerOf,
  ownBackground,
  parseFill,
  readFills,
  switchFill,
  withGradientAlpha,
  withStops,
  writeFills,
  type Gradient,
} from "./fills";
import { moveEntry } from "./lists";

const bg = (b: Partial<Record<"image" | "color" | "size" | "position" | "repeat", string>>) => ({
  image: "none",
  color: "transparent",
  size: "auto",
  position: "0% 0%",
  repeat: "repeat",
  ...b,
});

describe("fills", () => {
  it("reads gradients as angle, shape, center and stops", () => {
    expect(parseFill("linear-gradient(90deg, red, blue 80%)")).toEqual({
      type: "linear",
      angle: 90,
      side: null,
      stops: [
        { color: "red", at: 0 },
        { color: "blue", at: 80 },
      ],
      auto: false,
      repeating: false,
    });
    expect(parseFill("linear-gradient(to top right, red, var(--x), blue)")).toMatchObject({
      angle: 45,
      side: "top right",
      auto: true,
      stops: [{ at: 0 }, { color: "var(--x)", at: 50 }, { at: 100 }],
    });
    expect(parseFill("radial-gradient(circle at top left, red, blue)")).toMatchObject({
      type: "radial",
      shape: "circle",
      at: "top left",
    });
    expect(parseFill("conic-gradient(from 0.25turn, red, blue 180deg)")).toMatchObject({
      type: "conic",
      angle: 90,
      stops: [{ at: 0 }, { at: 50 }],
    });
    expect(parseFill("linear-gradient(red 10px, blue)").type).toBe("custom");
    expect(parseFill("linear-gradient(red, 30%, blue)").type).toBe("custom");
  });

  it("writes a gradient back as it was until a stop is placed", () => {
    for (const css of [
      "linear-gradient(90deg, red, blue)",
      "linear-gradient(to top right, red, blue)",
      "radial-gradient(circle at top left, red, blue)",
      "radial-gradient(red, blue)",
      "conic-gradient(from 90deg, red, blue)",
      'url("https://x.test/a.png")',
    ]) {
      expect(fillText(parseFill(css))).toBe(css);
    }
    const g = parseFill("linear-gradient(red, blue)") as Gradient;
    const placed = withStops(g, [...g.stops, { color: "green", at: 30 }]);
    expect(fillText(placed)).toBe("linear-gradient(red 0%, green 30%, blue 100%)");
  });

  it("scales a gradient's opacity by its most opaque stop", () => {
    const g = parseFill("linear-gradient(#ff0000, #0000ff80)") as Gradient;
    expect(fillText(withGradientAlpha(g, 50))).toBe("linear-gradient(#ff000080, #0000ff40)");
  });

  it("reads a solid over other layers and the bottom color", () => {
    const layers = readFills(
      {},
      bg({
        image: 'linear-gradient(red, red), url("a.png")',
        color: "var(--surface)",
        size: "auto, cover",
      }),
    );
    expect(layers.map((l) => l.fill.type)).toEqual(["solid", "image", "solid"]);
    expect(layers[1]!.size).toBe("cover");
  });

  it("writes the bottom solid as background-color and keeps the lists in step", () => {
    const layers: FillLayer[] = [
      layerOf(parseFill("linear-gradient(red, blue)")),
      layerOf({ type: "image", url: "a.png" }),
      layerOf({ type: "solid", color: "#fff" }),
    ];
    expect(writeFills({}, layers)).toEqual({
      "background-image": 'linear-gradient(red, blue), url("a.png")',
      "background-size": "auto, cover",
      "background-position": "0% 0%, center",
      "background-repeat": "repeat, no-repeat",
      "background-color": "#fff",
    });
    // The solid moved to the top paints as a gradient over the rest.
    const moved = moveEntry(layers, 2, 0);
    expect(writeFills({}, moved)["background-image"]).toBe(
      'linear-gradient(#fff, #fff), linear-gradient(red, blue), url("a.png")',
    );
  });

  it("hides the bottom color behind the eye and shows it again", () => {
    const styles = { "background-color": "var(--surface)" };
    const [base] = readFills(styles, bg({ color: "var(--surface)" }));
    const hidden = writeFills(styles, [{ ...base!, hidden: true }]);
    expect(hidden).toEqual({
      "background-color": "transparent",
      "--finite-off-background-color": "var(--surface)",
    });
    const after = { ...hidden } as Record<string, string>;
    const read = readFills(after, bg({ color: "transparent" }));
    expect(read).toMatchObject([{ fill: { color: "var(--surface)" }, hidden: true }]);
    expect(writeFills(after, [{ ...read[0]!, hidden: false }])).toEqual({
      "background-color": "var(--surface)",
      "--finite-off-background-color": null,
    });
  });

  it("keeps a color-only shorthand and expands one that can't hold a layer", () => {
    const short = { background: "var(--surface)" };
    expect(writeFills(short, [layerOf({ type: "solid", color: "red" })])).toEqual({
      "background-color": "red",
    });
    expect(
      writeFills(short, [
        layerOf(parseFill("linear-gradient(red, blue)")),
        layerOf({ type: "solid", color: "var(--surface)" }),
      ]),
    ).toEqual({
      background: null,
      "background-image": "linear-gradient(red, blue)",
      "background-color": "var(--surface)",
    });
    expect(expandBackground("url(a.png) center / cover no-repeat fixed, #fff")).toEqual({
      "background-image": "url(a.png), none",
      "background-position": "center, 0% 0%",
      "background-size": "cover, auto",
      "background-repeat": "no-repeat, repeat",
      "background-attachment": "fixed, scroll",
      "background-color": "#fff",
    });
    // What the controls don't edit stays as a longhand.
    const image = { background: "url(a.png) center/cover no-repeat fixed" };
    expect(ownBackground(image)["background-size"]).toBe("cover");
    const mine = ownBackground(image);
    const own = readFills(
      image,
      backgroundOf((p) => mine[p]),
    );
    expect(writeFills(image, [])).toMatchObject({
      background: null,
      "background-attachment": "fixed",
    });
    expect(own[0]!.fill.type).toBe("image");
  });

  it("names fits and 3×3 cells", () => {
    expect(fitOf("cover", "no-repeat")).toBe("fill");
    expect(fitOf("auto", "repeat")).toBe("tile");
    expect(fitOf("40px", "repeat")).toBeNull();
    expect(cellOf("top left")).toEqual({ x: 0, y: 0 });
    expect(cellOf("left top")).toEqual({ x: 0, y: 0 });
    expect(cellOf("bottom")).toEqual({ x: 1, y: 2 });
    expect(cellOf("100% 50%")).toEqual({ x: 2, y: 1 });
    expect(cellOf("10px 20px")).toBeNull();
    expect(cellPosition(2, 0)).toBe("right top");
    expect(cellPosition(1, 1)).toBe("center");
  });
});

describe("switching a fill's type", () => {
  it("keeps a gradient's stops and carries a solid's color", () => {
    const g = parseFill("linear-gradient(90deg, red, blue 80%)");
    expect(fillText(switchFill(g, "radial"))).toBe("radial-gradient(red 0%, blue 80%)");
    expect(switchFill(g, "solid")).toEqual({ type: "solid", color: "red" });
    expect(fillText(switchFill({ type: "solid", color: "#fff" }, "linear"))).toBe(
      "linear-gradient(#fff, #ffffff00)",
    );
  });
});
