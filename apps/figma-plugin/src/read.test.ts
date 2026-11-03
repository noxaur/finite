import { describe, expect, it } from "vite-plus/test";
import { KIND } from "./payload.ts";
import {
  readChild,
  readEffects,
  readFrames,
  readLayout,
  readPaint,
  readPaints,
  readRadii,
  readSelection,
  readText,
  topLevel,
  type NodeLike,
  type ReadEnv,
  type SegmentLike,
} from "./read.ts";

const MIXED = Symbol("figma.mixed");

const node = (fields: Partial<NodeLike> & { type: string }): NodeLike => ({
  id: "1:1",
  name: fields.type.toLowerCase(),
  x: 0,
  y: 0,
  width: 10,
  height: 10,
  ...fields,
});

const env = (overrides: Partial<ReadEnv> = {}): ReadEnv => ({
  exportSvg: async () => "<svg/>",
  segments: async () => [],
  ...overrides,
});

const black = { r: 0, g: 0, b: 0 };
const solid = (color: { r: number; g: number; b: number }, extra = {}) => ({
  type: "SOLID",
  color,
  ...extra,
});

describe("readPaint", () => {
  it("copies a solid color and leaves defaults out", () => {
    expect(readPaint({ ...solid({ r: 1, g: 0.5, b: 0 }), visible: true, opacity: 1 })).toEqual({
      type: "SOLID",
      color: { r: 1, g: 0.5, b: 0 },
    });
  });

  it("keeps opacity and visibility when they aren't the default", () => {
    expect(readPaint(solid(black, { opacity: 0.4, visible: false }))).toEqual({
      type: "SOLID",
      color: black,
      opacity: 0.4,
      visible: false,
    });
  });

  it("copies an image's hash and scale mode, and records the hash", () => {
    const hashes = new Set<string>();
    expect(readPaint({ type: "IMAGE", imageHash: "abc", scaleMode: "FILL" }, hashes)).toEqual({
      type: "IMAGE",
      imageHash: "abc",
      scaleMode: "FILL",
    });
    expect([...hashes]).toEqual(["abc"]);
    expect(readPaint({ type: "IMAGE", imageHash: null })).toBeUndefined();
  });

  it("copies gradient stops with their alpha", () => {
    expect(
      readPaint({
        type: "GRADIENT_LINEAR",
        gradientStops: [
          { position: 0, color: { r: 1, g: 0, b: 0, a: 1 } },
          { position: 1, color: { r: 0, g: 0, b: 1, a: 0.5 } },
        ],
      }),
    ).toEqual({
      type: "GRADIENT_LINEAR",
      gradientStops: [
        { position: 0, color: { r: 1, g: 0, b: 0 } },
        { position: 1, color: { r: 0, g: 0, b: 1, a: 0.5 } },
      ],
    });
  });

  it("leaves mixed paints out", () => {
    expect(readPaints(MIXED)).toBeUndefined();
    expect(readPaints([solid(black)])).toEqual([{ type: "SOLID", color: black }]);
  });
});

describe("readEffects", () => {
  it("copies shadows and blurs, and drops effects it doesn't know", () => {
    expect(
      readEffects([
        {
          type: "DROP_SHADOW",
          color: { r: 0, g: 0, b: 0, a: 0.25 },
          offset: { x: 0, y: 4 },
          radius: 8,
          spread: 2,
          visible: true,
        },
        { type: "LAYER_BLUR", radius: 6, visible: false },
        { type: "NOISE" },
      ]),
    ).toEqual([
      {
        type: "DROP_SHADOW",
        color: { r: 0, g: 0, b: 0, a: 0.25 },
        offset: { x: 0, y: 4 },
        radius: 8,
        spread: 2,
      },
      { type: "LAYER_BLUR", radius: 6, visible: false },
    ]);
  });
});

describe("readRadii", () => {
  it("reads each corner", () => {
    expect(
      readRadii(
        node({
          type: "RECTANGLE",
          topLeftRadius: 1,
          topRightRadius: 2,
          bottomRightRadius: 3,
          bottomLeftRadius: 4,
        }),
      ),
    ).toEqual([1, 2, 3, 4]);
  });

  it("repeats a uniform radius four times", () => {
    expect(readRadii(node({ type: "FRAME", cornerRadius: 8 }))).toEqual([8, 8, 8, 8]);
  });

  it("falls back to the corners when the radius is mixed, and skips square corners", () => {
    expect(
      readRadii(
        node({
          type: "FRAME",
          cornerRadius: MIXED,
          topLeftRadius: 5,
          topRightRadius: 0,
          bottomRightRadius: 0,
          bottomLeftRadius: 0,
        }),
      ),
    ).toEqual([5, 0, 0, 0]);
    expect(readRadii(node({ type: "FRAME", cornerRadius: 0 }))).toBeUndefined();
    expect(readRadii(node({ type: "TEXT" }))).toBeUndefined();
  });
});

describe("auto layout", () => {
  it("copies the frame's layout", () => {
    expect(
      readLayout(
        node({
          type: "FRAME",
          layoutMode: "HORIZONTAL",
          layoutWrap: "WRAP",
          itemSpacing: 8,
          counterAxisSpacing: 12,
          paddingTop: 1,
          paddingRight: 2,
          paddingBottom: 3,
          paddingLeft: 4,
          primaryAxisAlignItems: "SPACE_BETWEEN",
          counterAxisAlignItems: "CENTER",
          primaryAxisSizingMode: "AUTO",
          counterAxisSizingMode: "FIXED",
        }),
      ),
    ).toEqual({
      mode: "HORIZONTAL",
      wrap: true,
      gap: 8,
      counterGap: 12,
      padding: [1, 2, 3, 4],
      primaryAlign: "SPACE_BETWEEN",
      counterAlign: "CENTER",
      primarySizing: "AUTO",
      counterSizing: "FIXED",
    });
  });

  it("has none on a frame without auto layout", () => {
    expect(readLayout(node({ type: "FRAME", layoutMode: "NONE" }))).toBeUndefined();
  });

  it("copies how a child sits in its parent", () => {
    expect(
      readChild(
        node({
          type: "TEXT",
          layoutPositioning: "ABSOLUTE",
          layoutGrow: 1,
          layoutAlign: "STRETCH",
        }),
      ),
    ).toEqual({ positioning: "ABSOLUTE", grow: 1, align: "STRETCH" });
    expect(
      readChild(
        node({ type: "TEXT", layoutPositioning: "AUTO", layoutGrow: 0, layoutAlign: "INHERIT" }),
      ),
    ).toBeUndefined();
  });
});

describe("readText runs", () => {
  it("keeps line height, letter spacing and case that differ in a run", () => {
    const base = {
      fontName: { family: "Inter", style: "Regular" },
      fontSize: 16,
      lineHeight: { unit: "AUTO" },
      letterSpacing: { unit: "PIXELS", value: 0 },
      textCase: "ORIGINAL",
    };
    const label = node({
      type: "TEXT",
      characters: "Hi there",
      ...base,
      lineHeight: MIXED,
      letterSpacing: MIXED,
      textCase: MIXED,
    });
    const text = readText(label, [
      { start: 0, end: 3, ...base },
      {
        start: 3,
        end: 8,
        ...base,
        lineHeight: { unit: "PIXELS", value: 30 },
        letterSpacing: { unit: "PERCENT", value: 10 },
        textCase: "UPPER",
      },
    ]);
    expect(text?.runs).toEqual([
      {
        start: 3,
        end: 8,
        lineHeight: { unit: "PIXELS", value: 30 },
        letterSpacing: { unit: "PERCENT", value: 10 },
        case: "UPPER",
      },
    ]);
  });
});

describe("readText", () => {
  const segment = (start: number, end: number, fields: Record<string, unknown>): SegmentLike => ({
    start,
    end,
    fontName: { family: "Inter", style: "Regular" },
    fontSize: 16,
    fills: [solid(black)],
    textDecoration: "NONE",
    ...fields,
  });
  const text = (fields: Record<string, unknown> = {}) =>
    node({
      type: "TEXT",
      characters: "Hello world",
      fontName: { family: "Inter", style: "Semi Bold Italic" },
      fontSize: 16,
      lineHeight: { unit: "PERCENT", value: 120 },
      letterSpacing: { unit: "PIXELS", value: 0.5 },
      textAlignHorizontal: "CENTER",
      textDecoration: "UNDERLINE",
      textCase: "UPPER",
      ...fields,
    });

  it("copies the text's style and works out the weight from the style name", () => {
    expect(readText(text(), [])).toEqual({
      characters: "Hello world",
      fontFamily: "Inter",
      fontStyle: "Semi Bold Italic",
      fontWeight: 600,
      italic: true,
      fontSize: 16,
      lineHeight: { unit: "PERCENT", value: 120 },
      letterSpacing: { unit: "PIXELS", value: 0.5 },
      align: "CENTER",
      decoration: "UNDERLINE",
      case: "UPPER",
    });
  });

  it("turns segments unlike the first into runs holding only what differs", () => {
    const segments = [
      segment(0, 6, {}),
      segment(6, 11, {
        fontName: { family: "Inter", style: "Bold" },
        fills: [solid({ r: 1, g: 0, b: 0 })],
      }),
      segment(11, 12, { fontSize: 24, textDecoration: "UNDERLINE" }),
      segment(12, 13, {}),
    ];
    const read = readText(
      text({ fontName: MIXED, fontSize: 16, textDecoration: MIXED, textCase: "ORIGINAL" }),
      segments,
    );
    expect(read?.fontStyle).toBe("Regular");
    expect(read?.decoration).toBeUndefined();
    expect(read?.case).toBeUndefined();
    expect(read?.runs).toEqual([
      {
        start: 6,
        end: 11,
        fontWeight: 700,
        fills: [{ type: "SOLID", color: { r: 1, g: 0, b: 0 } }],
      },
      { start: 11, end: 12, fontSize: 24, decoration: "UNDERLINE" },
    ]);
  });

  it("says when a run turns italic off", () => {
    const segments = [
      segment(0, 3, { fontName: { family: "Inter", style: "Italic" } }),
      segment(3, 6, {}),
    ];
    expect(readText(text({ fontName: MIXED }), segments)?.runs).toEqual([
      { start: 3, end: 6, italic: false },
    ]);
  });
});

describe("topLevel", () => {
  it("takes frames, a section's frames, and skips what's inside another selected frame", () => {
    const outer = node({ type: "FRAME", id: "1:1" });
    const inner = node({ type: "FRAME", id: "1:2", parent: { id: "1:1" } });
    const rect = node({ type: "RECTANGLE", id: "1:3" });
    const section = node({
      type: "SECTION",
      id: "1:4",
      children: [node({ type: "FRAME", id: "1:5" }), node({ type: "TEXT", id: "1:6" })],
    });
    const { frames, skipped } = topLevel([outer, inner, rect, section]);
    expect(frames.map((f) => f.id)).toEqual(["1:1", "1:5"]);
    expect(skipped).toBe(2);
  });
});

describe("readFrames", () => {
  const frame = node({
    type: "FRAME",
    id: "1:1",
    name: "Card",
    x: 5,
    y: 6,
    absoluteTransform: [
      [1, 0, 105],
      [0, 1, 206],
    ],
    width: 200,
    height: 100,
    opacity: 0.5,
    rotation: 90,
    clipsContent: true,
    fills: [solid({ r: 1, g: 1, b: 1 })],
    strokes: [solid(black)],
    strokeWeight: 2,
    strokeAlign: "INSIDE",
    effects: [],
    layoutMode: "VERTICAL",
    children: [
      node({
        type: "RECTANGLE",
        id: "1:2",
        x: 10,
        y: 20,
        fills: MIXED,
        visible: false,
        layoutGrow: 1,
      }),
      node({ type: "VECTOR", id: "1:3", name: "Icon" }),
    ],
  });

  it("copies the tree with the top level at its canvas position", async () => {
    const read = await readFrames([frame], env());
    expect(read.count).toBe(3);
    const [card] = read.nodes;
    expect(card).toMatchObject({
      id: "1:1",
      type: "FRAME",
      name: "Card",
      x: 105,
      y: 206,
      width: 200,
      height: 100,
      opacity: 0.5,
      rotation: 90,
      clipsContent: true,
      strokes: [{ type: "SOLID", color: black }],
      strokeWeight: 2,
      strokeAlign: "INSIDE",
      layout: { mode: "VERTICAL" },
    });
    expect(card?.children?.[0]).toMatchObject({
      x: 10,
      y: 20,
      visible: false,
      child: { grow: 1 },
    });
    expect(card?.children?.[0]?.fills).toBeUndefined();
  });

  it("exports vectors as SVG and doesn't walk into them", async () => {
    const read = await readFrames([frame], env());
    expect(read.nodes[0]?.children?.[1]?.svg).toBe("<svg/>");
  });

  it("gives a rotated vector its drawn box, since its SVG is already rotated", async () => {
    const arrow = node({
      type: "VECTOR",
      id: "1:9",
      x: 40,
      y: 10,
      width: 20,
      height: 10,
      rotation: 90,
      absoluteBoundingBox: { x: 140, y: 100, width: 10, height: 20 },
    });
    const parent = node({
      type: "FRAME",
      children: [arrow],
      absoluteBoundingBox: { x: 100, y: 80, width: 200, height: 100 },
    });
    const read = await readFrames([parent], env());
    const fig = read.nodes[0]?.children?.[0];
    expect(fig).toMatchObject({ x: 40, y: 20, width: 10, height: 20 });
    expect(fig?.rotation).toBeUndefined();
  });

  it("reports a vector it couldn't export and carries on", async () => {
    const read = await readFrames(
      [frame],
      env({
        exportSvg: async () => {
          throw new Error("empty");
        },
      }),
    );
    expect(read.nodes[0]?.children?.[1]?.svg).toBeUndefined();
    expect(read.warnings).toEqual([`Couldn't export "Icon" as SVG: empty`]);
  });

  it("reads mixed text fills from the first segment", async () => {
    const label = node({
      type: "TEXT",
      characters: "Hi",
      fontName: { family: "Inter", style: "Regular" },
      fontSize: 12,
      fills: MIXED,
    });
    const read = await readFrames(
      [node({ type: "FRAME", children: [label] })],
      env({
        segments: async () => [
          {
            start: 0,
            end: 2,
            fontName: { family: "Inter", style: "Regular" },
            fontSize: 12,
            fills: [solid(black)],
          },
        ],
      }),
    );
    expect(read.nodes[0]?.children?.[0]?.fills).toEqual([{ type: "SOLID", color: black }]);
  });
});

describe("readSelection", () => {
  it("builds a payload with the selection's images and a version-first file", async () => {
    const withImage = node({
      type: "FRAME",
      name: "Hero",
      fills: [{ type: "IMAGE", imageHash: "h1", scaleMode: "FILL" }],
    });
    const host = {
      root: { name: "My file" },
      currentPage: { selection: [withImage, node({ type: "RECTANGLE" })] },
      getImageByHash: (hash: string) =>
        hash === "h1" ? { getBytesAsync: async () => new Uint8Array([1, 2, 3]) } : null,
      base64Encode: (data: Uint8Array) => Buffer.from(data).toString("base64"),
    };
    const saved = await readSelection(host, env());
    expect(saved).toMatchObject({ name: "Hero", frames: 1, layers: 1, images: 1, skipped: 1 });
    expect(saved.payload).toMatchObject({
      kind: KIND,
      file: { name: "My file" },
      images: { h1: "AQID" },
    });
    expect(saved.json.startsWith('{"v":1,')).toBe(true);
  });

  it("warns about an image Figma can't find", async () => {
    const host = {
      root: { name: "f" },
      currentPage: {
        selection: [node({ type: "FRAME", fills: [{ type: "IMAGE", imageHash: "gone" }] })],
      },
      getImageByHash: () => null,
      base64Encode: () => "",
    };
    const saved = await readSelection(host, env());
    expect(saved.images).toBe(0);
    expect(saved.payload.images).toBeUndefined();
    expect(saved.warnings).toHaveLength(1);
  });
});
