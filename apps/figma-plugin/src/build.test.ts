import { describe, expect, it } from "vite-plus/test";
import {
  appearance,
  build,
  childProps,
  layoutProps,
  placeRight,
  runFont,
  sizingProps,
  textFont,
  textProps,
  toEffect,
  toPaint,
  toPaints,
  type BuildHost,
} from "./build.ts";
import { KIND, type FigNode, type FigText, type Payload } from "./payload.ts";

const images = new Map([["sha", "figma-hash"]]);

describe("toPaint", () => {
  it("copies a solid color, folding the color's alpha into the opacity", () => {
    expect(
      toPaint({ type: "SOLID", color: { r: 1, g: 0, b: 0, a: 0.5 }, opacity: 0.5 }, images),
    ).toEqual({
      type: "SOLID",
      color: { r: 1, g: 0, b: 0 },
      opacity: 0.25,
      visible: true,
    });
  });

  it("looks an image up by the payload's key and falls back from CROP to FILL", () => {
    expect(toPaint({ type: "IMAGE", imageHash: "sha", scaleMode: "CROP" }, images)).toEqual({
      type: "IMAGE",
      imageHash: "figma-hash",
      scaleMode: "FILL",
      opacity: 1,
      visible: true,
    });
    expect(toPaint({ type: "IMAGE", imageHash: "sha", scaleMode: "TILE" }, images)).toMatchObject({
      scaleMode: "TILE",
    });
    expect(toPaint({ type: "IMAGE", imageHash: "missing" }, images)).toBeUndefined();
  });

  it("gives gradients their stops, left to right", () => {
    expect(
      toPaint(
        {
          type: "GRADIENT_LINEAR",
          gradientStops: [
            { position: 0, color: { r: 1, g: 0, b: 0 } },
            { position: 1, color: { r: 0, g: 0, b: 1, a: 0.5 } },
          ],
        },
        images,
      ),
    ).toEqual({
      type: "GRADIENT_LINEAR",
      gradientStops: [
        { position: 0, color: { r: 1, g: 0, b: 0, a: 1 } },
        { position: 1, color: { r: 0, g: 0, b: 1, a: 0.5 } },
      ],
      gradientTransform: [
        [1, 0, 0],
        [0, 1, 0],
      ],
      opacity: 1,
      visible: true,
    });
  });

  it("drops paints it can't draw", () => {
    expect(toPaint({ type: "VIDEO" }, images)).toBeUndefined();
    expect(toPaint({ type: "SOLID" }, images)).toBeUndefined();
    expect(
      toPaints([{ type: "VIDEO" }, { type: "SOLID", color: { r: 0, g: 0, b: 0 } }], images),
    ).toHaveLength(1);
  });
});

describe("toEffect", () => {
  it("builds shadows and blurs", () => {
    expect(
      toEffect({
        type: "DROP_SHADOW",
        color: { r: 0, g: 0, b: 0, a: 0.2 },
        offset: { x: 1, y: 2 },
        radius: 4,
      }),
    ).toEqual({
      type: "DROP_SHADOW",
      color: { r: 0, g: 0, b: 0, a: 0.2 },
      offset: { x: 1, y: 2 },
      radius: 4,
      spread: 0,
      visible: true,
      blendMode: "NORMAL",
    });
    expect(toEffect({ type: "BACKGROUND_BLUR", radius: 10, visible: false })).toEqual({
      type: "BACKGROUND_BLUR",
      blurType: "NORMAL",
      radius: 10,
      visible: false,
    });
    expect(toEffect({ type: "NOISE" })).toBeUndefined();
  });
});

describe("auto layout", () => {
  it("sets the mode before anything that depends on it", () => {
    const props = layoutProps({
      mode: "HORIZONTAL",
      wrap: true,
      gap: 8,
      counterGap: 4,
      padding: [1, 2, 3, 4],
      primaryAlign: "SPACE_BETWEEN",
      counterAlign: "BASELINE",
    });
    expect(Object.keys(props)[0]).toBe("layoutMode");
    expect(props).toMatchObject({
      layoutWrap: "WRAP",
      itemSpacing: 8,
      counterAxisSpacing: 4,
      paddingTop: 1,
      paddingRight: 2,
      paddingBottom: 3,
      paddingLeft: 4,
      primaryAxisAlignItems: "SPACE_BETWEEN",
      counterAxisAlignItems: "BASELINE",
    });
  });

  it("uses the defaults, and doesn't wrap or baseline-align a vertical layout", () => {
    const props = layoutProps({ mode: "VERTICAL", wrap: true, counterAlign: "BASELINE" });
    expect(props).toMatchObject({ layoutWrap: "NO_WRAP", itemSpacing: 0, paddingLeft: 0 });
    expect(props.counterAxisSpacing).toBeUndefined();
    expect(props.counterAxisAlignItems).toBe("MIN");
  });

  it("maps AUTO sizing to hug and anything else to fixed", () => {
    expect(sizingProps({ mode: "VERTICAL", primarySizing: "AUTO" })).toEqual({
      primaryAxisSizingMode: "AUTO",
      counterAxisSizingMode: "FIXED",
    });
  });

  it("maps child layout, with a plain layer sitting where auto layout puts it", () => {
    expect(childProps(undefined)).toEqual({
      layoutPositioning: "AUTO",
      layoutGrow: 0,
      layoutAlign: "INHERIT",
    });
    expect(childProps({ positioning: "ABSOLUTE", grow: 1, align: "STRETCH" })).toEqual({
      layoutPositioning: "ABSOLUTE",
      layoutGrow: 1,
      layoutAlign: "STRETCH",
    });
  });
});

const node = (overrides: Partial<FigNode> = {}): FigNode => ({
  id: "n",
  type: "FRAME",
  name: "Box",
  x: 0,
  y: 0,
  width: 100,
  height: 50,
  ...overrides,
});

describe("appearance", () => {
  it("clears Figma's default fill and clipping when the payload says nothing", () => {
    expect(appearance(node(), images, { radii: true, clips: true })).toMatchObject({
      name: "Box",
      visible: true,
      opacity: 1,
      fills: [],
      strokes: [],
      effects: [],
      clipsContent: false,
      topLeftRadius: 0,
    });
  });

  it("copies strokes, radii and clipping", () => {
    const props = appearance(
      node({
        strokes: [{ type: "SOLID", color: { r: 0, g: 0, b: 0 } }],
        strokeWeight: 2,
        strokeAlign: "OUTSIDE",
        cornerRadii: [1, 2, 3, 4],
        clipsContent: true,
        opacity: 0.5,
        visible: false,
      }),
      images,
      { radii: true, clips: true },
    );
    expect(props).toMatchObject({
      strokeWeight: 2,
      strokeAlign: "OUTSIDE",
      topLeftRadius: 1,
      topRightRadius: 2,
      bottomRightRadius: 3,
      bottomLeftRadius: 4,
      clipsContent: true,
      opacity: 0.5,
      visible: false,
    });
  });

  it("leaves out what the shape can't have", () => {
    const props = appearance(node(), images, { radii: false, clips: false });
    expect(props).not.toHaveProperty("topLeftRadius");
    expect(props).not.toHaveProperty("clipsContent");
  });
});

describe("text", () => {
  const text: FigText = {
    characters: "Hello",
    fontFamily: "Lora",
    fontStyle: "Semi Bold Italic",
    fontWeight: 600,
    fontSize: 20,
    lineHeight: { unit: "AUTO" },
    letterSpacing: { unit: "PERCENT", value: 2 },
    align: "JUSTIFIED",
    decoration: "STRIKETHROUGH",
    case: "TITLE",
  };

  it("maps styles to the Plugin API's", () => {
    expect(textProps(text)).toEqual({
      fontSize: 20,
      lineHeight: { unit: "AUTO" },
      letterSpacing: { unit: "PERCENT", value: 2 },
      textAlignHorizontal: "JUSTIFIED",
      textDecoration: "STRIKETHROUGH",
      textCase: "TITLE",
    });
    expect(
      textProps({ ...text, case: "NONE", decoration: undefined, align: undefined }),
    ).toMatchObject({
      textCase: "ORIGINAL",
      textDecoration: "NONE",
      textAlignHorizontal: "LEFT",
    });
  });

  it("asks for the font the payload names, and works out italic from the style", () => {
    expect(textFont(text)).toEqual({
      family: "Lora",
      style: "Semi Bold Italic",
      weight: 600,
      italic: true,
    });
  });

  it("builds a run's font on the layer's, and has none for runs that don't change it", () => {
    expect(runFont({ start: 0, end: 1, fontWeight: 700 }, text)).toEqual({
      family: "Lora",
      weight: 700,
      italic: true,
    });
    expect(runFont({ start: 0, end: 1, italic: false }, text)).toMatchObject({
      weight: 600,
      italic: false,
    });
    expect(runFont({ start: 0, end: 1, fontSize: 30 }, text)).toBeUndefined();
  });
});

describe("placeRight", () => {
  const box = (x: number, y: number, width = 100, height = 100) => ({ x, y, width, height });

  it("puts the first frame at the origin on an empty page", () => {
    expect(placeRight([], [box(500, 300), box(700, 400)])).toEqual({ dx: -500, dy: -300 });
  });

  it("moves the frames right of what's there, keeping their layout", () => {
    expect(placeRight([box(0, 20, 400), box(100, 50)], [box(10, 5), box(300, 5)])).toEqual({
      dx: 400 + 100 - 10,
      dy: 20 - 5,
    });
  });
});

/** A fake Plugin API that records what a build did, node by node. */
function fakeHost(options: { fonts?: Array<[string, string]>; existing?: number } = {}) {
  const log: string[] = [];
  const fonts = options.fonts ?? [
    ["Inter", "Regular"],
    ["Inter", "Bold"],
  ];
  const made: FakeNode[] = [];

  class FakeNode {
    children: FakeNode[] = [];
    parent: FakeNode | null = null;
    props: Record<string, unknown> = {};
    constructor(readonly type: string) {
      made.push(this);
      return new Proxy(this, {
        set: (target, key, value) => {
          if (typeof key === "string" && !(key in target)) {
            target.props[key] = value;
            log.push(`${target.type}.${key}`);
            return true;
          }
          (target as unknown as Record<string | symbol, unknown>)[key] = value;
          return true;
        },
        get: (target, key) => {
          const own = (target as unknown as Record<string | symbol, unknown>)[key];
          if (own !== undefined) return own;
          return typeof key === "string" ? target.props[key] : undefined;
        },
      });
    }
    appendChild(child: FakeNode) {
      child.parent = this;
      this.children.push(child);
      log.push(`${this.type}.appendChild(${child.type})`);
    }
    resize(w: number, h: number) {
      this.props.width = w;
      this.props.height = h;
      log.push(`${this.type}.resize`);
    }
    setRangeFontName(start: number, end: number, font: unknown) {
      log.push(`range ${start}-${end} ${JSON.stringify(font)}`);
    }
    setRangeFills() {}
    setRangeFontSize() {}
    setRangeTextDecoration() {}
  }

  const page = new FakeNode("PAGE") as FakeNode & { selection: unknown[] };
  for (let i = 0; i < (options.existing ?? 0); i++) {
    const frame = new FakeNode("FRAME");
    Object.assign(frame.props, { x: 0, y: 0, width: 300, height: 200 });
    page.children.push(frame);
  }
  const loaded: string[] = [];
  const zoomed: unknown[][] = [];
  const host = {
    currentPage: page,
    createFrame: () => new FakeNode("FRAME"),
    createRectangle: () => new FakeNode("RECTANGLE"),
    createEllipse: () => new FakeNode("ELLIPSE"),
    createText: () => new FakeNode("TEXT"),
    createNodeFromSvg: (svg: string) => {
      if (svg === "bad") throw new Error("not svg");
      return new FakeNode("FRAME");
    },
    createImage: (data: Uint8Array) => ({ hash: `img-${data.length}` }),
    base64Decode: (s: string) => Uint8Array.from(Buffer.from(s, "base64")),
    listAvailableFontsAsync: async () =>
      fonts.map(([family, style]) => ({ fontName: { family, style } })),
    loadFontAsync: async (font: { family: string; style: string }) => {
      loaded.push(`${font.family} ${font.style}`);
    },
    viewport: { scrollAndZoomIntoView: (nodes: unknown[]) => void zoomed.push(nodes) },
  } as unknown as BuildHost;
  return { host, page, log, loaded, zoomed, made };
}

describe("build", () => {
  const payload = (nodes: FigNode[], extra: Partial<Payload> = {}): Payload => ({
    kind: KIND,
    file: { name: "f" },
    nodes,
    ...extra,
  });

  it("builds frames, children and auto layout in an order Figma accepts", async () => {
    const { host, log, page } = fakeHost();
    const report = await build(
      payload([
        node({
          x: 40,
          y: 60,
          layout: { mode: "VERTICAL", gap: 8, primarySizing: "AUTO" },
          children: [
            node({
              type: "RECTANGLE",
              name: "Bar",
              child: { grow: 1, align: "STRETCH" },
              x: 3,
              y: 3,
            }),
            node({ type: "ELLIPSE", name: "Dot", child: { positioning: "ABSOLUTE" }, x: 5, y: 6 }),
          ],
        }),
      ]),
      host,
    );
    expect(report).toMatchObject({ frames: 1, layers: 3, fontsReplaced: [], warnings: [] });
    // Mode before spacing, resize before hug, and child layout only once it's in the frame.
    expect(log.indexOf("FRAME.layoutMode")).toBeLessThan(log.indexOf("FRAME.itemSpacing"));
    expect(log.indexOf("FRAME.resize")).toBeLessThan(log.indexOf("FRAME.primaryAxisSizingMode"));
    expect(log.indexOf("FRAME.appendChild(RECTANGLE)")).toBeLessThan(
      log.indexOf("RECTANGLE.layoutGrow"),
    );
    const [frame] = page.children as unknown as Array<{
      props: Record<string, unknown>;
      children: Array<{ props: Record<string, unknown> }>;
    }>;
    // On an empty page the first frame goes to the origin.
    expect(frame?.props).toMatchObject({
      x: 0,
      y: 0,
      layoutMode: "VERTICAL",
      primaryAxisSizingMode: "AUTO",
    });
    const [bar, dot] = frame?.children ?? [];
    expect(bar?.props).toMatchObject({ layoutGrow: 1, layoutAlign: "STRETCH" });
    expect(bar?.props).not.toHaveProperty("x");
    expect(dot?.props).toMatchObject({ layoutPositioning: "ABSOLUTE", x: 5, y: 6 });
  });

  it("puts new frames right of what's on the page, then selects and zooms to them", async () => {
    const { host, page, zoomed } = fakeHost({ existing: 1 });
    await build(payload([node({ x: 10, y: 10 }), node({ x: 210, y: 10 })]), host);
    const added = page.children.slice(1) as unknown as Array<{ props: Record<string, unknown> }>;
    expect(added.map((f) => f.props.x)).toEqual([400, 600]);
    expect(added.map((f) => f.props.y)).toEqual([0, 0]);
    expect(page.selection).toHaveLength(2);
    expect(zoomed).toHaveLength(1);
  });

  it("builds text with its font, and reports the one it had to replace", async () => {
    const { host, page, loaded } = fakeHost();
    const text: FigText = {
      characters: "Hi there",
      fontFamily: "Nope Sans",
      fontStyle: "Bold",
      fontWeight: 700,
      fontSize: 18,
      runs: [{ start: 0, end: 2, fontWeight: 400 }],
    };
    const report = await build(
      payload([node({ children: [node({ type: "TEXT", name: "Label", text })] })]),
      host,
    );
    expect(report.fontsReplaced).toEqual([
      "Nope Sans Bold → Inter Bold",
      "Nope Sans Regular → Inter Regular",
    ]);
    expect(loaded).toContain("Inter Bold");
    const label = (
      page.children[0] as unknown as { children: Array<{ props: Record<string, unknown> }> }
    ).children[0];
    expect(label?.props).toMatchObject({
      characters: "Hi there",
      fontName: { family: "Inter", style: "Bold" },
      fontSize: 18,
      textAutoResize: "HEIGHT",
    });
  });

  it("loads images into Figma and points fills at their new hashes", async () => {
    const { host, page } = fakeHost();
    const report = await build(
      payload(
        [
          node({
            type: "RECTANGLE",
            fills: [{ type: "IMAGE", imageHash: "sha", scaleMode: "FILL" }],
          }),
        ],
        { images: { sha: Buffer.from([1, 2, 3]).toString("base64") } },
      ),
      host,
    );
    expect(report.images).toBe(1);
    const rect = page.children[0] as unknown as { props: { fills: Array<{ imageHash: string }> } };
    expect(rect.props.fills[0]?.imageHash).toBe("img-3");
  });

  it("draws vectors from their SVG, and keeps going when one is bad", async () => {
    const { host } = fakeHost();
    const report = await build(
      payload([
        node({
          children: [
            node({ type: "VECTOR", name: "Good", svg: "<svg/>" }),
            node({ type: "VECTOR", name: "Bad", svg: "bad" }),
          ],
        }),
      ]),
      host,
    );
    expect(report.layers).toBe(3);
    expect(report.warnings).toHaveLength(1);
    expect(report.warnings[0]).toContain("Bad");
  });
});
