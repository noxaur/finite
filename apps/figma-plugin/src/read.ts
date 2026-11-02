// Selection → payload. The mapping functions take plain objects shaped like
// Plugin API nodes, and the few calls that need Figma itself sit in `ReadEnv`.
// Fields are `unknown` on `NodeLike` and narrowed where they're read, because
// `figma.mixed` (a symbol) can stand in for any of them.

import { isItalic, weightOf } from "./fonts.ts";
import {
  encodePayload,
  KIND,
  type AutoLayout,
  type FigEffect,
  type FigNode,
  type FigPaint,
  type FigText,
  type LayoutChild,
  type Measure,
  type Payload,
  type Rgba,
  type Stop,
  type TextRun,
} from "./payload.ts";

export interface NodeLike {
  readonly id: string;
  readonly type: string;
  readonly name: string;
  readonly parent?: { readonly id: string; readonly parent?: unknown } | null;
  readonly children?: ReadonlyArray<NodeLike>;
  readonly [field: string]: unknown;
}

/** The text styles `getStyledTextSegments` is asked for. */
export const SEGMENT_FIELDS = [
  "fontName",
  "fontSize",
  "fills",
  "textDecoration",
  "textCase",
  "lineHeight",
  "letterSpacing",
] as const;

export interface SegmentLike {
  readonly start: number;
  readonly end: number;
  readonly [field: string]: unknown;
}

/** What reading needs from Figma. */
export interface ReadEnv {
  /** The node as SVG markup. */
  exportSvg(node: NodeLike): Promise<string>;
  /** `node.getStyledTextSegments(SEGMENT_FIELDS)`. */
  segments(node: NodeLike): Promise<ReadonlyArray<SegmentLike>>;
}

export interface Read {
  nodes: FigNode[];
  /** Every image hash a fill or stroke refers to. */
  imageHashes: Set<string>;
  /** Things that didn't make it into the payload. */
  warnings: string[];
  /** Layers read, top-level frames included. */
  count: number;
}

/** Layers Figma draws from paths: the payload carries them as SVG. */
const VECTORS = new Set(["VECTOR", "BOOLEAN_OPERATION", "STAR", "LINE", "POLYGON"]);

/** What can stand as an artboard. A `SECTION` stands for the frames inside it. */
const TOP_LEVEL = new Set(["FRAME", "COMPONENT", "COMPONENT_SET", "INSTANCE", "GROUP"]);

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/**
 * The selected layers that become artboards: frames, sections' frames, and
 * nothing that sits inside another selected layer.
 */
export function topLevel(selection: ReadonlyArray<NodeLike>): {
  frames: NodeLike[];
  skipped: number;
} {
  const selected = new Set(selection.map((n) => n.id));
  const insideSelected = (node: NodeLike) => {
    for (let p = node.parent as NodeLike["parent"]; isObject(p); p = p.parent as typeof p) {
      if (selected.has(p.id)) return true;
    }
    return false;
  };
  const frames: NodeLike[] = [];
  let skipped = 0;
  const visit = (node: NodeLike) => {
    if (node.type === "SECTION") for (const child of node.children ?? []) visit(child);
    else if (TOP_LEVEL.has(node.type)) frames.push(node);
    else skipped += 1;
  };
  for (const node of selection) if (!insideSelected(node)) visit(node);
  return { frames, skipped };
}

export function readColor(color: unknown): Rgba | undefined {
  if (!isObject(color)) return undefined;
  const { r, g, b, a } = color;
  if (typeof r !== "number" || typeof g !== "number" || typeof b !== "number") return undefined;
  return typeof a === "number" && a !== 1 ? { r, g, b, a } : { r, g, b };
}

/** One paint, or `undefined` when it has nothing to carry (an image with no hash). */
export function readPaint(paint: unknown, imageHashes?: Set<string>): FigPaint | undefined {
  if (!isObject(paint) || typeof paint.type !== "string") return undefined;
  const out: FigPaint = { type: paint.type };
  if (paint.visible === false) out.visible = false;
  if (typeof paint.opacity === "number" && paint.opacity !== 1) out.opacity = paint.opacity;
  if (paint.type === "SOLID") {
    const color = readColor(paint.color);
    if (color) out.color = color;
  } else if (paint.type === "IMAGE") {
    if (typeof paint.imageHash !== "string") return undefined;
    out.imageHash = paint.imageHash;
    imageHashes?.add(paint.imageHash);
    if (typeof paint.scaleMode === "string") out.scaleMode = paint.scaleMode;
  } else if (paint.type.startsWith("GRADIENT") && Array.isArray(paint.gradientStops)) {
    const stops: Stop[] = [];
    for (const stop of paint.gradientStops as unknown[]) {
      if (!isObject(stop)) continue;
      const color = readColor(stop.color);
      if (typeof stop.position === "number" && color) {
        stops.push({ position: stop.position, color });
      }
    }
    out.gradientStops = stops;
  }
  return out;
}

/** A list of paints, or `undefined` for `figma.mixed` and for no list at all. */
export function readPaints(paints: unknown, imageHashes?: Set<string>): FigPaint[] | undefined {
  if (!Array.isArray(paints)) return undefined;
  const out: FigPaint[] = [];
  for (const paint of paints) {
    const read = readPaint(paint, imageHashes);
    if (read) out.push(read);
  }
  return out;
}

export function readEffects(effects: unknown): FigEffect[] | undefined {
  if (!Array.isArray(effects)) return undefined;
  const out: FigEffect[] = [];
  for (const effect of effects as unknown[]) {
    if (!isObject(effect) || typeof effect.type !== "string") continue;
    const shadow = effect.type === "DROP_SHADOW" || effect.type === "INNER_SHADOW";
    if (!shadow && effect.type !== "LAYER_BLUR" && effect.type !== "BACKGROUND_BLUR") continue;
    const read: FigEffect = { type: effect.type };
    if (effect.visible === false) read.visible = false;
    if (typeof effect.radius === "number" && effect.radius !== 0) read.radius = effect.radius;
    if (shadow) {
      const color = readColor(effect.color);
      if (color) read.color = color;
      const offset = effect.offset;
      if (isObject(offset)) read.offset = { x: num(offset.x) ?? 0, y: num(offset.y) ?? 0 };
      if (typeof effect.spread === "number" && effect.spread !== 0) read.spread = effect.spread;
    }
    out.push(read);
  }
  return out;
}

/** Top left, top right, bottom right, bottom left. Left out when every corner is square. */
export function readRadii(node: NodeLike): [number, number, number, number] | undefined {
  const corners = [
    node.topLeftRadius,
    node.topRightRadius,
    node.bottomRightRadius,
    node.bottomLeftRadius,
  ];
  let radii: [number, number, number, number] | undefined;
  if (corners.every((c) => typeof c === "number")) {
    radii = corners as [number, number, number, number];
  } else if (typeof node.cornerRadius === "number") {
    const r = node.cornerRadius;
    radii = [r, r, r, r];
  }
  return radii?.some((r) => r !== 0) ? radii : undefined;
}

export function readLayout(node: NodeLike): AutoLayout | undefined {
  const mode = node.layoutMode;
  if (mode !== "HORIZONTAL" && mode !== "VERTICAL") return undefined;
  const layout: AutoLayout = {
    mode,
    padding: [
      num(node.paddingTop) ?? 0,
      num(node.paddingRight) ?? 0,
      num(node.paddingBottom) ?? 0,
      num(node.paddingLeft) ?? 0,
    ],
    primaryAlign: str(node.primaryAxisAlignItems) ?? "MIN",
    counterAlign: str(node.counterAxisAlignItems) ?? "MIN",
    primarySizing: str(node.primaryAxisSizingMode) ?? "FIXED",
    counterSizing: str(node.counterAxisSizingMode) ?? "FIXED",
  };
  if (node.layoutWrap === "WRAP") layout.wrap = true;
  const gap = num(node.itemSpacing);
  if (gap) layout.gap = gap;
  const counterGap = num(node.counterAxisSpacing);
  if (counterGap) layout.counterGap = counterGap;
  return layout;
}

/** How a layer sits in its auto-layout parent. `undefined` when it sits there by default. */
export function readChild(node: NodeLike): LayoutChild | undefined {
  const child: LayoutChild = {};
  if (node.layoutPositioning === "ABSOLUTE") child.positioning = "ABSOLUTE";
  const grow = num(node.layoutGrow);
  if (grow) child.grow = grow;
  if (node.layoutAlign === "STRETCH") child.align = "STRETCH";
  return Object.keys(child).length > 0 ? child : undefined;
}

function readMeasure(value: unknown): Measure | undefined {
  if (!isObject(value) || typeof value.unit !== "string") return undefined;
  return typeof value.value === "number"
    ? { unit: value.unit, value: value.value }
    : { unit: value.unit };
}

/** A font name as the payload has it, with the weight worked out from the style name. */
function fontOf(fontName: unknown) {
  if (!isObject(fontName) || typeof fontName.family !== "string") return undefined;
  const style = str(fontName.style) ?? "Regular";
  return { family: fontName.family, style, weight: weightOf(style), italic: isItalic(style) };
}

/**
 * A text layer. A style that's mixed over the whole layer is read from its
 * first segment, and the segments that differ from the first become `runs`.
 */
export function readText(
  node: NodeLike,
  segments: ReadonlyArray<SegmentLike>,
  imageHashes?: Set<string>,
): FigText | undefined {
  const first: Record<string, unknown> = segments[0] ?? {};
  // A field of the whole layer, or of its first segment where it's mixed.
  const base = (field: string) => (typeof node[field] === "symbol" ? first[field] : node[field]);
  const font = fontOf(base("fontName"));
  const size = num(base("fontSize"));
  if (typeof node.characters !== "string" || !font || size === undefined) return undefined;

  const text: FigText = {
    characters: node.characters,
    fontFamily: font.family,
    fontStyle: font.style,
    fontWeight: font.weight,
    fontSize: size,
    align: str(node.textAlignHorizontal) ?? "LEFT",
  };
  if (font.italic) text.italic = true;
  const lineHeight = readMeasure(base("lineHeight"));
  if (lineHeight) text.lineHeight = lineHeight;
  const letterSpacing = readMeasure(base("letterSpacing"));
  if (letterSpacing) text.letterSpacing = letterSpacing;
  const decoration = str(base("textDecoration"));
  if (decoration && decoration !== "NONE") text.decoration = decoration;
  const textCase = str(base("textCase"));
  if (textCase && textCase !== "ORIGINAL") text.case = textCase;

  const runs: TextRun[] = [];
  const firstFills = JSON.stringify(readPaints(first.fills, imageHashes));
  for (const segment of segments.slice(1)) {
    const run: TextRun = { start: segment.start, end: segment.end };
    const f = fontOf(segment.fontName);
    if (f) {
      if (f.family !== font.family) run.fontFamily = f.family;
      if (f.weight !== font.weight) run.fontWeight = f.weight;
      if (f.italic !== font.italic) run.italic = f.italic;
    }
    const segmentSize = num(segment.fontSize);
    if (segmentSize !== undefined && segmentSize !== size) run.fontSize = segmentSize;
    const fills = readPaints(segment.fills, imageHashes);
    if (fills && JSON.stringify(fills) !== firstFills) run.fills = fills;
    const decor = str(segment.textDecoration);
    if (decor && decor !== (str(first.textDecoration) ?? "NONE")) run.decoration = decor;
    if (Object.keys(run).length > 2) runs.push(run);
  }
  if (runs.length > 0) text.runs = runs;
  return text;
}

/** One layer and everything under it. */
export async function readNode(
  node: NodeLike,
  env: ReadEnv,
  read: Read,
  top: boolean,
  parentBox?: Box,
): Promise<FigNode> {
  read.count += 1;
  const position = top && Array.isArray(node.absoluteTransform) ? node.absoluteTransform : null;
  const fig: FigNode = {
    id: node.id,
    type: node.type,
    name: node.name,
    x: (position?.[0] as number[] | undefined)?.[2] ?? num(node.x) ?? 0,
    y: (position?.[1] as number[] | undefined)?.[2] ?? num(node.y) ?? 0,
    width: num(node.width) ?? 0,
    height: num(node.height) ?? 0,
  };
  if (node.visible === false) fig.visible = false;
  const opacity = num(node.opacity);
  if (opacity !== undefined && opacity !== 1) fig.opacity = opacity;
  const rotation = num(node.rotation);
  if (rotation) fig.rotation = rotation;

  let fills = readPaints(node.fills, read.imageHashes);
  if (node.type === "TEXT") {
    const segments = await env.segments(node);
    const text = readText(node, segments, read.imageHashes);
    if (text) fig.text = text;
    // Fills that are mixed over the whole layer are read from its first segment.
    fills ??= readPaints(segments[0]?.fills, read.imageHashes);
  }
  if (fills && fills.length > 0) fig.fills = fills;
  const strokes = readPaints(node.strokes, read.imageHashes);
  if (strokes && strokes.length > 0) {
    fig.strokes = strokes;
    const weight = num(node.strokeWeight);
    if (weight) fig.strokeWeight = weight;
    const align = str(node.strokeAlign);
    if (align) fig.strokeAlign = align;
  }
  const radii = readRadii(node);
  if (radii) fig.cornerRadii = radii;
  const effects = readEffects(node.effects);
  if (effects && effects.length > 0) fig.effects = effects;
  if (node.clipsContent === true) fig.clipsContent = true;
  const layout = readLayout(node);
  if (layout) fig.layout = layout;
  if (!top) {
    const child = readChild(node);
    if (child) fig.child = child;
  }

  if (VECTORS.has(node.type)) {
    try {
      fig.svg = await env.exportSvg(node);
      drawnBox(fig, node, parentBox);
    } catch (error) {
      read.warnings.push(`Couldn't export "${node.name}" as SVG: ${message(error)}`);
    }
  } else if (node.children && node.children.length > 0) {
    const box = asBox(node.absoluteBoundingBox);
    fig.children = await Promise.all(
      node.children.map((c) => readNode(c, env, read, false, box)),
    );
  }
  return fig;
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

const asBox = (value: unknown): Box | undefined => {
  const box = value as Partial<Box> | null | undefined;
  return box && [box.x, box.y, box.width, box.height].every((n) => typeof n === "number")
    ? (box as Box)
    : undefined;
};

/**
 * An exported SVG is the layer as drawn: already rotated, filling its
 * bounding box. So a rotated vector's box becomes that bounding box, relative
 * to its parent's, and its rotation 0, or Finite would rotate it twice.
 */
function drawnBox(fig: FigNode, node: NodeLike, parentBox: Box | undefined) {
  const box = asBox(node.absoluteBoundingBox);
  if (!fig.rotation || !box || !parentBox) return;
  fig.x = box.x - parentBox.x;
  fig.y = box.y - parentBox.y;
  fig.width = box.width;
  fig.height = box.height;
  delete fig.rotation;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The layers under `frames`, ready for a payload. Their images aren't read yet. */
export async function readFrames(frames: ReadonlyArray<NodeLike>, env: ReadEnv): Promise<Read> {
  const read: Read = { nodes: [], imageHashes: new Set(), warnings: [], count: 0 };
  read.nodes = await Promise.all(frames.map((f) => readNode(f, env, read, true)));
  return read;
}

/** What the plugin needs from Figma to save a selection. */
export interface ReadHost {
  readonly root: { readonly name: string };
  readonly currentPage: { readonly selection: ReadonlyArray<unknown> };
  getImageByHash(hash: string): { getBytesAsync(): Promise<Uint8Array> } | null;
  base64Encode(data: Uint8Array): string;
}

export interface Saved {
  payload: Payload;
  json: string;
  /** A name for the file, without its extension. */
  name: string;
  frames: number;
  layers: number;
  images: number;
  /** Selected layers that aren't frames. */
  skipped: number;
  warnings: string[];
}

/** Reads the current selection into a payload. */
export async function readSelection(host: ReadHost, env: ReadEnv): Promise<Saved> {
  const { frames, skipped } = topLevel(host.currentPage.selection as NodeLike[]);
  const read = await readFrames(frames, env);
  const images: Record<string, string> = {};
  for (const hash of read.imageHashes) {
    try {
      const bytes = await host.getImageByHash(hash)?.getBytesAsync();
      if (bytes) images[hash] = host.base64Encode(bytes);
      else read.warnings.push(`An image (${hash.slice(0, 8)}…) isn't available.`);
    } catch (error) {
      read.warnings.push(`Couldn't read an image (${hash.slice(0, 8)}…): ${message(error)}`);
    }
  }
  const payload: Payload = {
    kind: KIND,
    file: { name: host.root.name },
    nodes: read.nodes,
  };
  if (Object.keys(images).length > 0) payload.images = images;
  return {
    payload,
    json: encodePayload(payload),
    name: frames.length === 1 && frames[0] ? frames[0].name : host.root.name,
    frames: frames.length,
    layers: read.count,
    images: Object.keys(images).length,
    skipped,
    warnings: read.warnings,
  };
}
