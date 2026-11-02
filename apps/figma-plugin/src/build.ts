// Payload → Figma layers. The mapping functions turn payload values into
// Plugin API values and are pure. `build` is the thin part that creates nodes
// and assigns what they return.

import { FALLBACK, isItalic, pickFont, styleOf, type FontName, type WantedFont } from "./fonts.ts";
import type {
  AutoLayout,
  FigEffect,
  FigNode,
  FigPaint,
  FigText,
  LayoutChild,
  Measure,
  Payload,
  Rgba,
  TextRun,
} from "./payload.ts";

/** What building needs from Figma. */
export type BuildHost = Pick<
  PluginAPI,
  | "createFrame"
  | "createRectangle"
  | "createEllipse"
  | "createText"
  | "createNodeFromSvg"
  | "createImage"
  | "loadFontAsync"
  | "listAvailableFontsAsync"
  | "base64Decode"
  | "currentPage"
  | "viewport"
>;

export interface Report {
  /** Top-level frames built. */
  frames: number;
  /** Layers built, frames included. */
  layers: number;
  images: number;
  /** Fonts that weren't available, like `Foo Bold → Inter Bold`. */
  fontsReplaced: string[];
  /** Things that couldn't be built or set. */
  warnings: string[];
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** How far apart Figma puts new frames and what's already there. */
export const GAP = 100;

/**
 * How far to move the payload's top-level frames so they sit right of
 * `existing`, with their tops level with it. On an empty page the first frame
 * goes to the origin.
 */
export function placeRight(
  existing: ReadonlyArray<Box>,
  tops: ReadonlyArray<Box>,
): { dx: number; dy: number } {
  if (tops.length === 0) return { dx: 0, dy: 0 };
  const left = Math.min(...tops.map((t) => t.x));
  const top = Math.min(...tops.map((t) => t.y));
  if (existing.length === 0) return { dx: -left, dy: -top };
  const right = Math.max(...existing.map((e) => e.x + e.width));
  const above = Math.min(...existing.map((e) => e.y));
  return { dx: right + GAP - left, dy: above - top };
}

const channels = ({ r, g, b }: Rgba): RGB => ({ r, g, b });

/** A Figma paint, or `undefined` for one this plugin can't draw (or an image that didn't load). */
export function toPaint(paint: FigPaint, images: ReadonlyMap<string, string>): Paint | undefined {
  const visible = paint.visible ?? true;
  const opacity = paint.opacity ?? 1;
  switch (paint.type) {
    case "SOLID": {
      if (!paint.color) return undefined;
      // A color's own alpha multiplies the paint's opacity.
      return {
        type: "SOLID",
        color: channels(paint.color),
        opacity: opacity * (paint.color.a ?? 1),
        visible,
      };
    }
    case "IMAGE": {
      const imageHash = paint.imageHash === undefined ? undefined : images.get(paint.imageHash);
      if (imageHash === undefined) return undefined;
      const mode = paint.scaleMode;
      // CROP needs a transform that the payload doesn't carry.
      const scaleMode = mode === "FIT" || mode === "TILE" ? mode : "FILL";
      return { type: "IMAGE", imageHash, scaleMode, opacity, visible };
    }
    case "GRADIENT_LINEAR":
    case "GRADIENT_RADIAL":
    case "GRADIENT_ANGULAR":
    case "GRADIENT_DIAMOND": {
      const stops = paint.gradientStops ?? [];
      if (stops.length === 0) return undefined;
      return {
        type: paint.type,
        gradientStops: stops.map((s) => ({
          position: s.position,
          color: { ...channels(s.color), a: s.color.a ?? 1 },
        })),
        // The payload has no direction, so gradients run left to right.
        gradientTransform: [
          [1, 0, 0],
          [0, 1, 0],
        ],
        opacity,
        visible,
      };
    }
    default:
      return undefined;
  }
}

export function toPaints(
  paints: ReadonlyArray<FigPaint> | undefined,
  images: ReadonlyMap<string, string>,
): Paint[] {
  const out: Paint[] = [];
  for (const paint of paints ?? []) {
    const built = toPaint(paint, images);
    if (built) out.push(built);
  }
  return out;
}

export function toEffect(effect: FigEffect): Effect | undefined {
  const visible = effect.visible ?? true;
  const radius = effect.radius ?? 0;
  switch (effect.type) {
    case "DROP_SHADOW":
    case "INNER_SHADOW":
      return {
        type: effect.type,
        color: { r: 0, g: 0, b: 0, a: 1, ...effect.color },
        offset: { x: effect.offset?.x ?? 0, y: effect.offset?.y ?? 0 },
        radius,
        spread: effect.spread ?? 0,
        visible,
        blendMode: "NORMAL",
      };
    case "LAYER_BLUR":
    case "BACKGROUND_BLUR":
      return { type: effect.type, blurType: "NORMAL", radius, visible };
    default:
      return undefined;
  }
}

/** The `layoutMode` and spacing of an auto-layout frame. The order matters: `layoutMode` first. */
export function layoutProps(layout: AutoLayout): Record<string, unknown> {
  const horizontal = layout.mode === "HORIZONTAL";
  const wrap = horizontal && layout.wrap === true;
  const [top, right, bottom, left] = layout.padding ?? [0, 0, 0, 0];
  const counter = layout.counterAlign ?? "MIN";
  const props: Record<string, unknown> = {
    layoutMode: layout.mode,
    layoutWrap: wrap ? "WRAP" : "NO_WRAP",
    itemSpacing: layout.gap ?? 0,
  };
  if (wrap) props.counterAxisSpacing = layout.counterGap ?? 0;
  Object.assign(props, {
    paddingTop: top,
    paddingRight: right,
    paddingBottom: bottom,
    paddingLeft: left,
    primaryAxisAlignItems: layout.primaryAlign ?? "MIN",
    // Only horizontal layouts align to the text baseline.
    counterAxisAlignItems: counter === "BASELINE" && !horizontal ? "MIN" : counter,
  });
  return props;
}

/** Hug or fixed on each axis. These go after the frame is resized, which would reset them. */
export function sizingProps(layout: AutoLayout): Record<string, unknown> {
  return {
    primaryAxisSizingMode: layout.primarySizing === "AUTO" ? "AUTO" : "FIXED",
    counterAxisSizingMode: layout.counterSizing === "AUTO" ? "AUTO" : "FIXED",
  };
}

/** How a layer sits in an auto-layout parent. Only valid once it's inside one. */
export function childProps(child: LayoutChild | undefined): Record<string, unknown> {
  return {
    layoutPositioning: child?.positioning === "ABSOLUTE" ? "ABSOLUTE" : "AUTO",
    layoutGrow: child?.grow ?? 0,
    layoutAlign: child?.align === "STRETCH" ? "STRETCH" : "INHERIT",
  };
}

export interface Shape {
  /** Frames and rectangles have corner radii. */
  radii: boolean;
  /** Frames can clip their content. */
  clips: boolean;
}

/** Everything about how a layer looks, except its size and place. */
export function appearance(
  node: FigNode,
  images: ReadonlyMap<string, string>,
  shape: Shape,
): Record<string, unknown> {
  const props: Record<string, unknown> = {
    name: node.name,
    visible: node.visible ?? true,
    opacity: node.opacity ?? 1,
    fills: toPaints(node.fills, images),
  };
  const strokes = toPaints(node.strokes, images);
  props.strokes = strokes;
  if (strokes.length > 0) {
    props.strokeWeight = node.strokeWeight ?? 1;
    if (node.strokeAlign) props.strokeAlign = node.strokeAlign;
  }
  props.effects = (node.effects ?? []).flatMap((e) => toEffect(e) ?? []);
  if (shape.radii) {
    const [tl, tr, br, bl] = node.cornerRadii ?? [0, 0, 0, 0];
    Object.assign(props, {
      topLeftRadius: tl,
      topRightRadius: tr,
      bottomRightRadius: br,
      bottomLeftRadius: bl,
    });
  }
  if (shape.clips) props.clipsContent = node.clipsContent ?? false;
  return props;
}

function measure(m: Measure | undefined, autoOk: true): LineHeight | undefined;
function measure(m: Measure | undefined, autoOk: false): LetterSpacing | undefined;
function measure(m: Measure | undefined, autoOk: boolean): LineHeight | undefined {
  if (!m) return undefined;
  if (m.unit === "AUTO") return autoOk ? { unit: "AUTO" } : undefined;
  if (m.unit === "PIXELS" || m.unit === "PERCENT") return { unit: m.unit, value: m.value ?? 0 };
  return undefined;
}

/** A text layer's styles, for after its font is set. */
export function textProps(text: FigText): Record<string, unknown> {
  const props: Record<string, unknown> = { fontSize: Math.max(1, text.fontSize) };
  const lineHeight = measure(text.lineHeight, true);
  if (lineHeight) props.lineHeight = lineHeight;
  const letterSpacing = measure(text.letterSpacing, false);
  if (letterSpacing) props.letterSpacing = letterSpacing;
  const align = text.align;
  props.textAlignHorizontal =
    align === "CENTER" || align === "RIGHT" || align === "JUSTIFIED" ? align : "LEFT";
  props.textDecoration =
    text.decoration === "UNDERLINE" || text.decoration === "STRIKETHROUGH"
      ? text.decoration
      : "NONE";
  props.textCase = textCaseOf(text.case);
  return props;
}

/** A payload's text case as Figma's, `ORIGINAL` for anything else. */
const textCaseOf = (value: string | undefined): TextCase =>
  value === "UPPER" || value === "LOWER" || value === "TITLE" ? value : "ORIGINAL";

/** The font a run asks for, built on the layer's own. */
export function runFont(run: TextRun, text: FigText): WantedFont | undefined {
  if (run.fontFamily === undefined && run.fontWeight === undefined && run.italic === undefined) {
    return undefined;
  }
  return {
    family: run.fontFamily ?? text.fontFamily,
    weight: run.fontWeight ?? text.fontWeight,
    italic: run.italic ?? textFont(text).italic,
  };
}

export function textFont(text: FigText): WantedFont {
  const style = text.fontStyle === "" ? undefined : text.fontStyle;
  return {
    family: text.fontFamily,
    style,
    weight: text.fontWeight,
    italic: text.italic ?? (style !== undefined && isItalic(style)),
  };
}

/** Frames, groups and anything else that holds layers. */
const CONTAINERS = new Set(["FRAME", "GROUP", "INSTANCE", "COMPONENT", "COMPONENT_SET", "SECTION"]);

interface Context {
  host: BuildHost;
  images: Map<string, string>;
  fonts: FontName[];
  /** Fonts already chosen and loaded, by the request that picked them. */
  loaded: Map<string, FontName>;
  report: Report;
}

type Parent = ChildrenMixin;

/** Sets each property in turn, and reports the ones Figma refuses instead of stopping. */
function assign(target: object, props: Record<string, unknown>, node: FigNode, ctx: Context) {
  for (const [key, value] of Object.entries(props)) {
    try {
      (target as Record<string, unknown>)[key] = value;
    } catch (error) {
      ctx.report.warnings.push(`${node.name}: couldn't set ${key} (${message(error)})`);
    }
  }
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Loads the closest available font to `wanted`, falling back to Inter, and reports a swap. */
async function loadFont(wanted: WantedFont, ctx: Context): Promise<FontName> {
  const style = wanted.style ?? styleOf(wanted.weight, wanted.italic);
  const key = `${wanted.family}/${style}/${wanted.weight}/${wanted.italic}`;
  const known = ctx.loaded.get(key);
  if (known) return known;

  let { font, replaced } = pickFont(wanted, ctx.fonts);
  try {
    await ctx.host.loadFontAsync(font);
  } catch {
    font = FALLBACK;
    replaced = true;
    await ctx.host.loadFontAsync(font);
  }
  if (replaced) {
    const swap = `${wanted.family} ${style} → ${font.family} ${font.style}`;
    if (!ctx.report.fontsReplaced.includes(swap)) ctx.report.fontsReplaced.push(swap);
  }
  ctx.loaded.set(key, font);
  return font;
}

async function buildText(node: FigNode, text: FigText, ctx: Context): Promise<TextNode> {
  const layer = ctx.host.createText();
  const font = await loadFont(textFont(text), ctx);
  layer.fontName = font;
  layer.characters = text.characters;
  assign(layer, textProps(text), node, ctx);
  assign(layer, appearance(node, ctx.images, { radii: false, clips: false }), node, ctx);

  for (const run of text.runs ?? []) {
    const start = Math.max(0, run.start);
    const end = Math.min(text.characters.length, run.end);
    if (start >= end) continue;
    try {
      const wanted = runFont(run, text);
      if (wanted) layer.setRangeFontName(start, end, await loadFont(wanted, ctx));
      if (run.fontSize !== undefined) layer.setRangeFontSize(start, end, Math.max(1, run.fontSize));
      if (run.fills) layer.setRangeFills(start, end, toPaints(run.fills, ctx.images));
      const runLineHeight = measure(run.lineHeight, true);
      if (runLineHeight) layer.setRangeLineHeight(start, end, runLineHeight);
      const runSpacing = measure(run.letterSpacing, false);
      if (runSpacing) layer.setRangeLetterSpacing(start, end, runSpacing);
      if (run.case !== undefined) layer.setRangeTextCase(start, end, textCaseOf(run.case));
      if (run.decoration !== undefined) {
        const d = run.decoration;
        layer.setRangeTextDecoration(
          start,
          end,
          d === "UNDERLINE" || d === "STRIKETHROUGH" ? d : "NONE",
        );
      }
    } catch (error) {
      ctx.report.warnings.push(`${node.name}: couldn't style a run (${message(error)})`);
    }
  }
  layer.resize(Math.max(node.width, 0.01), Math.max(node.height, 0.01));
  // Keep the width the design had, so a font swap rewraps instead of overflowing.
  layer.textAutoResize = "HEIGHT";
  return layer;
}

function buildVector(node: FigNode, svg: string, ctx: Context): SceneNode {
  try {
    const layer = ctx.host.createNodeFromSvg(svg);
    // The SVG already has the layer's fills, strokes and rotation.
    assign(
      layer,
      { name: node.name, visible: node.visible ?? true, opacity: node.opacity ?? 1 },
      node,
      ctx,
    );
    return layer;
  } catch (error) {
    ctx.report.warnings.push(`${node.name}: couldn't draw its SVG (${message(error)})`);
    return buildShape(node, ctx.host.createRectangle(), ctx);
  }
}

function buildShape(node: FigNode, layer: RectangleNode | EllipseNode, ctx: Context) {
  const radii = layer.type === "RECTANGLE";
  assign(layer, appearance(node, ctx.images, { radii, clips: false }), node, ctx);
  layer.resize(Math.max(node.width, 0.01), Math.max(node.height, 0.01));
  return layer;
}

function buildFrame(node: FigNode, ctx: Context): FrameNode {
  const frame = ctx.host.createFrame();
  assign(frame, appearance(node, ctx.images, { radii: true, clips: true }), node, ctx);
  if (node.layout) assign(frame, layoutProps(node.layout), node, ctx);
  frame.resize(Math.max(node.width, 0.01), Math.max(node.height, 0.01));
  if (node.layout) assign(frame, sizingProps(node.layout), node, ctx);
  return frame;
}

async function createLayer(node: FigNode, ctx: Context): Promise<SceneNode> {
  if (node.svg) return buildVector(node, node.svg, ctx);
  if (node.type === "TEXT" && node.text) return buildText(node, node.text, ctx);
  if (node.type === "ELLIPSE") return buildShape(node, ctx.host.createEllipse(), ctx);
  if (node.type === "RECTANGLE") return buildShape(node, ctx.host.createRectangle(), ctx);
  if (CONTAINERS.has(node.type) || (node.children?.length ?? 0) > 0 || node.layout) {
    return buildFrame(node, ctx);
  }
  // A leaf without SVG, like a vector the plugin couldn't export: a box in its place.
  return buildShape(node, ctx.host.createRectangle(), ctx);
}

/**
 * Builds `node` inside `parent` and then its children. `offset` moves a
 * top-level frame; `inAutoLayout` says the parent lays its children out.
 */
async function buildNode(
  node: FigNode,
  parent: Parent,
  ctx: Context,
  inAutoLayout: boolean,
  offset: { dx: number; dy: number } | null,
): Promise<SceneNode> {
  const layer = await createLayer(node, ctx);
  parent.appendChild(layer);
  ctx.report.layers += 1;

  // Size, rotation and place come last: they depend on the parent and each other.
  // The SVG already carries a vector's rotation.
  if (node.rotation && !node.svg) assign(layer, { rotation: node.rotation }, node, ctx);
  const absolute = node.child?.positioning === "ABSOLUTE";
  if (inAutoLayout) {
    assign(layer, childProps(node.child), node, ctx);
    if (absolute) assign(layer, { x: node.x, y: node.y }, node, ctx);
  } else {
    assign(layer, { x: node.x + (offset?.dx ?? 0), y: node.y + (offset?.dy ?? 0) }, node, ctx);
  }

  if (layer.type === "FRAME" && !node.svg) {
    for (const child of node.children ?? []) {
      await buildNode(child, layer, ctx, node.layout !== undefined, null);
    }
  }
  return layer;
}

/**
 * Builds the payload's frames on the current page, to the right of what's
 * there, selects them, and zooms to them.
 */
export async function build(payload: Payload, host: BuildHost): Promise<Report> {
  const report: Report = { frames: 0, layers: 0, images: 0, fontsReplaced: [], warnings: [] };
  const ctx: Context = {
    host,
    images: new Map(),
    fonts: (await host.listAvailableFontsAsync()).map((f) => f.fontName),
    loaded: new Map(),
    report,
  };
  // The default font of a new text layer has to be loaded before it can be replaced.
  await host.loadFontAsync(FALLBACK);

  for (const [key, data] of Object.entries(payload.images ?? {})) {
    try {
      ctx.images.set(key, host.createImage(host.base64Decode(data)).hash);
      report.images += 1;
    } catch (error) {
      report.warnings.push(`Couldn't load an image (${key.slice(0, 8)}…): ${message(error)}`);
    }
  }

  const page = host.currentPage;
  const offset = placeRight(
    page.children.map((c) => ({ x: c.x, y: c.y, width: c.width, height: c.height })),
    payload.nodes,
  );
  const built: SceneNode[] = [];
  for (const node of payload.nodes) built.push(await buildNode(node, page, ctx, false, offset));
  report.frames = built.length;

  page.selection = built;
  if (built.length > 0) host.viewport.scrollAndZoomIntoView(built);
  return report;
}
