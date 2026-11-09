import type { Loc, Rect } from "@finite/protocol";

export type Direction = "row" | "column";
export type CrossAlign = "flex-start" | "center" | "flex-end" | "stretch";
export type Sides = { top: number; right: number; bottom: number; left: number };

/** What the layout of some boxes looks like, and the order they read in. */
export type AutoLayout = {
  direction: Direction;
  gap: number;
  padding: Sides;
  align: CrossAlign;
  /** Indexes into the rects, in the order they read along the direction. */
  order: number[];
};

const TOLERANCE = 1;

type Span = [start: number, end: number];
const along = (r: Rect, axis: "x" | "y"): Span =>
  axis === "x" ? [r.x, r.x + r.width] : [r.y, r.y + r.height];

/** The union of some boxes. */
export function boundsOf(rects: readonly Rect[]): Rect {
  if (rects.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  const right = Math.max(...rects.map((r) => r.x + r.width));
  const bottom = Math.max(...rects.map((r) => r.y + r.height));
  return { x, y, width: right - x, height: bottom - y };
}

/** How far the boxes run over each other along `axis`: zero when they line up one after another. */
function overlapOn(rects: readonly Rect[], axis: "x" | "y"): number {
  const spans = rects.map((r) => along(r, axis)).sort((a, b) => a[0] - b[0]);
  let total = 0;
  let reach = -Infinity;
  for (const [start, end] of spans) {
    total += Math.max(0, reach - start);
    reach = Math.max(reach, end);
  }
  return total;
}

const median = (values: readonly number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)] ?? 0;
};

function directionOf(rects: readonly Rect[]): Direction {
  const x = overlapOn(rects, "x");
  const y = overlapOn(rects, "y");
  if (x !== y) return x < y ? "row" : "column";
  const b = boundsOf(rects);
  return b.width >= b.height ? "row" : "column";
}

function alignOf(rects: readonly Rect[], parent: Rect, cross: "x" | "y"): CrossAlign {
  const spans = rects.map((r) => along(r, cross));
  const spread = (values: number[]) => Math.max(...values) - Math.min(...values);
  const starts = spread(spans.map((s) => s[0]));
  const ends = spread(spans.map((s) => s[1]));
  if (rects.length === 1) {
    const [from, to] = along(parent, cross);
    const [start, end] = spans[0]!;
    return start - from <= TOLERANCE && to - end <= TOLERANCE ? "stretch" : "flex-start";
  }
  // The same edges on both sides: as wide as each other, and kept that way by stretching.
  if (starts <= TOLERANCE && ends <= TOLERANCE) return "stretch";
  const centers = spread(spans.map((s) => (s[0] + s[1]) / 2));
  const best = Math.min(starts, centers, ends);
  if (starts <= best + TOLERANCE) return "flex-start";
  return centers <= best + TOLERANCE ? "center" : "flex-end";
}

/**
 * The flex layout that reproduces `rects` inside `parentRect` (both in the same coordinates): the
 * axis they overlap on least, the median space between them along it, the room around them as
 * padding, and how they line up across it.
 */
export function inferAutoLayout(rects: readonly Rect[], parentRect: Rect): AutoLayout {
  const direction = rects.length < 2 ? "row" : directionOf(rects);
  const main = direction === "row" ? "x" : "y";
  const cross = main === "x" ? "y" : "x";
  const order = rects
    .map((r, i) => ({ start: along(r, main)[0], i }))
    .sort((a, b) => a.start - b.start)
    .map((o) => o.i);
  const gaps = order.slice(1).map((i, n) => {
    const before = rects[order[n]!]!;
    return Math.max(0, along(rects[i]!, main)[0] - along(before, main)[1]);
  });
  const b = boundsOf(rects);
  const inset = (n: number) => Math.max(0, Math.round(n));
  return {
    direction,
    gap: Math.round(median(gaps)),
    padding: {
      top: rects.length === 0 ? 0 : inset(b.y - parentRect.y),
      right: rects.length === 0 ? 0 : inset(parentRect.x + parentRect.width - b.x - b.width),
      bottom: rects.length === 0 ? 0 : inset(parentRect.y + parentRect.height - b.y - b.height),
      left: rects.length === 0 ? 0 : inset(b.x - parentRect.x),
    },
    align: rects.length === 0 ? "flex-start" : alignOf(rects, parentRect, cross),
    order,
  };
}

/** The padding as the fewest declarations that say it. */
export function paddingStyles(p: Sides): Record<string, string> {
  if (p.top === p.right && p.right === p.bottom && p.bottom === p.left)
    return p.top === 0 ? {} : { padding: `${p.top}px` };
  return Object.fromEntries(
    (["top", "right", "bottom", "left"] as const)
      .filter((side) => p[side] > 0)
      .map((side) => [`padding-${side}`, `${p[side]}px`]),
  );
}

/** The styles that give an element `layout`. `stretch` is flex's default, so it isn't written. */
export function autoLayoutStyles(layout: AutoLayout): Record<string, string> {
  return {
    display: "flex",
    "flex-direction": layout.direction,
    ...(layout.gap > 0 ? { gap: `${layout.gap}px` } : {}),
    ...paddingStyles(layout.padding),
    ...(layout.align === "stretch" ? {} : { "align-items": layout.align }),
  };
}

/** What takes an element off its insets, so a flex parent places it. */
export const FLOW_STYLES: Readonly<Record<string, null>> = {
  position: null,
  top: null,
  right: null,
  bottom: null,
  left: null,
  inset: null,
};

/** What Shift+Alt+A takes off a container that keeps its place. */
export const NO_FLEX: Readonly<Record<string, string | null>> = {
  display: "block",
  "flex-direction": null,
  "flex-wrap": null,
  gap: null,
  "align-items": null,
  "justify-content": null,
};

const PHRASING = new Set([
  "a",
  "b",
  "button",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "i",
  "label",
  "p",
  "small",
  "span",
  "strong",
]);
const NO_WRAPPER = new Set([
  "colgroup",
  "defs",
  "dl",
  "g",
  "ol",
  "select",
  "svg",
  "table",
  "tbody",
  "tfoot",
  "thead",
  "tr",
  "ul",
]);

/** The element that can wrap children of `parentTag`, or `null` when none can stand between them. */
export function wrapperTagFor(parentTag: string | undefined): "div" | "span" | null {
  const tag = parentTag?.toLowerCase();
  if (tag && NO_WRAPPER.has(tag)) return null;
  return tag && PHRASING.has(tag) ? "span" : "div";
}

export type PaddingSide = keyof Sides;

/**
 * The padding after dragging one side's handle by `delta` CSS pixels toward the inside of the box.
 * Alt moves the side across from it too, and Shift all four.
 */
export function draggedPadding(
  start: Sides,
  side: PaddingSide,
  delta: number,
  mods: { alt: boolean; shift: boolean },
): Sides {
  const value = Math.max(0, Math.round(start[side] + delta));
  if (mods.shift) return { top: value, right: value, bottom: value, left: value };
  const across = { top: "bottom", bottom: "top", left: "right", right: "left" } as const;
  return { ...start, [side]: value, ...(mods.alt ? { [across[side]]: value } : {}) };
}

/** The padding sides of `next` that differ from `start`, as declarations to write. */
export function changedPadding(start: Sides, next: Sides): Record<string, string> {
  const out: Record<string, string> = {};
  for (const side of ["top", "right", "bottom", "left"] as const) {
    if (next[side] !== start[side]) out[`padding-${side}`] = `${next[side]}px`;
  }
  return out;
}

/** The space between two neighbors along `axis`, for one gap handle's band. */
export function gapBands(rects: readonly Rect[], axis: "x" | "y"): Rect[] {
  const bands: Rect[] = [];
  for (let i = 1; i < rects.length; i++) {
    const before = rects[i - 1]!;
    const next = rects[i]!;
    const left = Math.min(before.x, next.x);
    const top = Math.min(before.y, next.y);
    const right = Math.max(before.x + before.width, next.x + next.width);
    const bottom = Math.max(before.y + before.height, next.y + next.height);
    bands.push(
      axis === "x"
        ? {
            x: before.x + before.width,
            y: top,
            width: Math.max(0, next.x - before.x - before.width),
            height: bottom - top,
          }
        : {
            x: left,
            y: before.y + before.height,
            width: right - left,
            height: Math.max(0, next.y - before.y - before.height),
          },
    );
  }
  return bands;
}

/**
 * How far each sibling slides while `self` is dragged to land before `before` (`null` is the end,
 * `undefined` where it started): the ones between its old place and new place, by its size plus
 * the gap. Siblings that don't move aren't listed.
 */
export function reorderShifts(
  self: Loc,
  siblings: ReadonlyArray<{ loc: Loc; rect: Rect }>,
  before: Loc | null | undefined,
  axis: "x" | "y",
): Record<Loc, number> {
  if (before === undefined) return {};
  const from = siblings.findIndex((s) => s.loc === self);
  if (from < 0) return {};
  const to = before === null ? siblings.length : siblings.findIndex((s) => s.loc === before);
  const [start, end] = along(siblings[from]!.rect, axis);
  const neighbor = siblings[from + 1] ?? siblings[from - 1];
  const gap = neighbor
    ? Math.max(
        0,
        from + 1 < siblings.length
          ? along(neighbor.rect, axis)[0] - end
          : start - along(neighbor.rect, axis)[1],
      )
    : 0;
  const distance = end - start + gap;
  const out: Record<Loc, number> = {};
  if (to > from) for (let i = from + 1; i < to; i++) out[siblings[i]!.loc] = -distance;
  else for (let i = to; i < from; i++) out[siblings[i]!.loc] = distance;
  return out;
}

const SNAP = 0.5;

/** The zoom after dragging by `d` from a corner of `box` at `start` zoom, 2 decimals, never below 0.05. */
export function draggedZoom(
  box: Rect,
  handle: string,
  d: { x: number; y: number },
  start: number,
): number {
  const x = handle.includes("w") ? -d.x : d.x;
  const y = handle.startsWith("n") ? -d.y : d.y;
  const width = box.width || 1;
  const height = box.height || 1;
  const factor = Math.max((width + x) / width, (height + y) / height);
  return Math.max(0.05, Math.round(start * factor * 100) / 100);
}

/** Whether an element's position lets a drag move it by writing `left` and `top`. */
export const movesAbsolutely = (position: string | undefined) =>
  position === "absolute" || position === "fixed";

/** How many frame pixels one of an element's own CSS pixels covers, as the bridge measured it. */
export const frameScaleOf = (computed: Readonly<Record<string, string>>) =>
  parseFloat(computed.effectiveZoom ?? "") || parseFloat(computed.zoom ?? "") || 1;

/**
 * The `left`, `top` a positioned element gets after moving by `d`: computed insets are in the
 * element's own pixels, while `d` is in the frame's, and `zoom` is how many of those one covers.
 * Opposite insets come off so it moves rather than stretches, and a size they were giving it
 * (`keep`, in its own pixels) is written instead.
 */
export function movedInsets(
  start: {
    left: number;
    top: number;
    zoom: number;
    keep?: { width?: number; height?: number };
  },
  d: { x: number; y: number },
): Record<string, string | null> {
  const { width, height } = start.keep ?? {};
  return {
    left: `${Math.round(start.left + d.x / start.zoom)}px`,
    top: `${Math.round(start.top + d.y / start.zoom)}px`,
    right: null,
    bottom: null,
    ...(width === undefined ? {} : { width: `${Math.round(width)}px` }),
    ...(height === undefined ? {} : { height: `${Math.round(height)}px` }),
  };
}

/** Whether a drag by `d` is too small to write. */
export const barelyMoved = (d: { x: number; y: number }) =>
  Math.abs(d.x) < SNAP && Math.abs(d.y) < SNAP;
