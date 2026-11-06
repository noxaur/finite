import { pinOf } from "./geometry";

/** How an element is positioned: in the flow, or moved by its insets. */
export type PositionKind = "static" | "relative" | "absolute" | "fixed" | "sticky";

/**
 * What the position menu offers, in order. `relative` still reads, as an
 * element in the flow that its insets nudge, but it isn't offered: the
 * inspector writes it only on a container, so X and Y measure from it.
 */
export const POSITIONS: ReadonlyArray<readonly [PositionKind, string]> = [
  ["static", "In flow"],
  ["absolute", "Absolute"],
  ["fixed", "Fixed"],
  ["sticky", "Sticky"],
];

const KINDS: ReadonlySet<string> = new Set(["static", "relative", "absolute", "fixed", "sticky"]);

/** Whether an element of `kind` is placed by its insets: out of the flow, or stuck by one. */
export const isPlaced = (kind: string | null | undefined) =>
  kind === "absolute" || kind === "fixed" || kind === "sticky";

const INSETS = ["inset", "top", "right", "bottom", "left"] as const;

/** A computed or inline `position` as one of the kinds; `null` for anything else. */
export function positionKindOf(raw: string | undefined): PositionKind | null {
  const v = raw?.trim() ?? "static";
  return KINDS.has(v) ? (v as PositionKind) : null;
}

/**
 * The styles that position an element as `kind`. Going back into the flow
 * takes its insets off, and writes `static` only when a stylesheet would
 * otherwise position it. Sticky needs an inset to stick by, so it gets
 * `top: 0` when it has none. Absolute and fixed leave the insets as they
 * are: without any, the element stays where the flow put it.
 */
export function positionStyles(
  kind: PositionKind,
  styles: Readonly<Record<string, string>>,
  computed: string | undefined,
): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  if (kind === "static") {
    if (styles.position !== undefined) out.position = null;
    else if (computed && computed !== "static") out.position = "static";
    for (const p of INSETS) if (styles[p] !== undefined) out[p] = null;
    return out;
  }
  out.position = kind;
  const pinned = (p: string) => styles[p] !== undefined && styles[p] !== "auto";
  if (kind === "sticky" && !pinned("top") && !pinned("bottom") && !pinned("inset")) {
    out.top = "0px";
  }
  return out;
}

/**
 * The parents that need `position: relative` when their children become
 * `kind`, so an absolute child's X and Y measure from its parent, as in a
 * design tool, not from some container further out. Only a static parent
 * needs it, and not one that's itself among the targets.
 */
export function containersFor(
  kind: PositionKind,
  targets: ReadonlyArray<{ readonly id: string; readonly parent: string | null }>,
  positionOf: (id: string) => string | undefined,
): string[] {
  if (kind !== "absolute") return [];
  const ids = new Set(targets.map((t) => t.id));
  const parents = new Set<string>();
  for (const t of targets) {
    if (t.parent === null || ids.has(t.parent)) continue;
    if ((positionOf(t.parent) ?? "static") === "static") parents.add(t.parent);
  }
  return [...parents];
}

/** Which insets pin an absolute or fixed element on one axis, as `pinOf` in geometry reads them. */
export type Constraint = "near" | "far" | "both";

export type ConstraintAxis = "x" | "y";

const EDGES = {
  x: { near: "left", far: "right", size: "width" },
  y: { near: "top", far: "bottom", size: "height" },
} as const;

/** How `styles` pin the element on `axis`. */
export const constraintOf = (styles: Readonly<Record<string, string>>, axis: ConstraintAxis) =>
  pinOf({ styles }, EDGES[axis].near, EDGES[axis].far);

/** What each constraint is called, by axis. */
export const CONSTRAINTS: Readonly<
  Record<ConstraintAxis, ReadonlyArray<readonly [Constraint, string]>>
> = {
  x: [
    ["near", "Left"],
    ["far", "Right"],
    ["both", "Left & right"],
  ],
  y: [
    ["near", "Top"],
    ["far", "Bottom"],
    ["both", "Top & bottom"],
  ],
};

/** Where the element is now, in CSS pixels: its two insets on the axis and its size. */
export interface AxisBox {
  readonly near: number;
  readonly far: number;
  readonly size: number;
}

type Edge = "top" | "right" | "bottom" | "left";

/** The inset shorthands, each with the edges its values set, as `margin` reads them. */
const SHORTHANDS: ReadonlyArray<readonly [string, ReadonlyArray<Edge>]> = [
  ["inset", ["top", "right", "bottom", "left"]],
  // Logical insets, in a left-to-right, top-to-bottom writing mode.
  ["inset-block", ["top", "bottom"]],
  ["inset-inline", ["left", "right"]],
];

/** Splits a CSS value at the spaces outside brackets: `calc(1px + 2px) 0` is two values. */
function splitValues(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let part = "";
  for (const c of value.trim()) {
    if (c === "(") depth++;
    else if (c === ")") depth--;
    if (depth === 0 && /\s/.test(c)) {
      if (part) parts.push(part);
      part = "";
    } else part += c;
  }
  if (part) parts.push(part);
  return parts;
}

/**
 * The edges that `styles`' inset shorthands set, as longhands. A later
 * shorthand in `SHORTHANDS` wins over `inset`, and an edge the element
 * sets on its own wins over both.
 */
function shorthandEdges(styles: Readonly<Record<string, string>>): Partial<Record<Edge, string>> {
  const edges: Partial<Record<Edge, string>> = {};
  for (const [shorthand, sides] of SHORTHANDS) {
    const raw = styles[shorthand];
    if (raw === undefined) continue;
    const values = splitValues(raw);
    if (values.length === 0) continue;
    // Like `margin`: a missing value repeats the one across from it.
    sides.forEach((side, i) => {
      edges[side] = values[i] ?? (i === 3 ? values[1] : undefined) ?? values[0]!;
    });
  }
  for (const side of Object.keys(edges) as Edge[]) {
    if (styles[side] !== undefined) delete edges[side];
  }
  return edges;
}

/**
 * The styles that pin an absolute or fixed element on `axis` by
 * `constraint`, keeping it where it is: each inset it pins by gets the
 * distance it has now, and one it no longer pins by becomes `auto`, which
 * also overrides one a stylesheet sets. Pinned by both, its insets size
 * it, so its own size comes off; leaving that, it gets the size it has.
 * An `inset`, `inset-block` or `inset-inline` shorthand becomes the
 * longhands it sets first, so it can't pin the edge that was let go.
 */
export function constraintStyles(
  axis: ConstraintAxis,
  constraint: Constraint,
  styles: Readonly<Record<string, string>>,
  box: AxisBox,
): Record<string, string | null> {
  const { near, far, size } = EDGES[axis];
  const px = (n: number) => `${Math.round(n)}px`;
  const out: Record<string, string | null> = {};
  for (const [shorthand] of SHORTHANDS) if (styles[shorthand] !== undefined) out[shorthand] = null;
  const expanded = shorthandEdges(styles);
  Object.assign(out, expanded);
  const own: Readonly<Record<string, string>> = { ...styles, ...expanded };
  const set = (p: string) => own[p] !== undefined && own[p] !== "auto";
  out[near] = constraint === "far" ? "auto" : px(box.near);
  out[far] = constraint === "near" ? "auto" : px(box.far);
  if (constraint === "both") {
    if (styles[size] !== undefined) out[size] = null;
  } else if (set(near) && set(far) && styles[size] === undefined) out[size] = px(box.size);
  return out;
}

/** The edges a sticky element can stick by, in the order they're offered. */
export const STICKY_EDGES = [
  ["top", "Top"],
  ["bottom", "Bottom"],
  ["left", "Left"],
  ["right", "Right"],
] as const;

export type StickyEdge = (typeof STICKY_EDGES)[number][0];

/** The edge a sticky element sticks by: the first inset it sets, or the top. */
export function stickyEdgeOf(styles: Readonly<Record<string, string>>): StickyEdge {
  const set = STICKY_EDGES.find(([e]) => styles[e] !== undefined && styles[e] !== "auto");
  return set?.[0] ?? "top";
}

/** The styles that move a sticky element's distance from edge `from` to `to`. */
export function stickyEdgeStyles(
  from: StickyEdge,
  to: StickyEdge,
  styles: Readonly<Record<string, string>>,
): Record<string, string | null> {
  if (from === to) return {};
  const distance = styles[from];
  return {
    ...(distance !== undefined && { [from]: null }),
    [to]: distance === undefined || distance === "auto" ? "0px" : distance,
  };
}

const TURN: Readonly<Record<string, number>> = {
  deg: 1,
  turn: 360,
  rad: 180 / Math.PI,
  grad: 0.9,
};

/**
 * A `rotate` in degrees: `45deg` is 45, `0.25turn` is 90, `none` is 0.
 * `null` for a rotation about another axis, like `x 45deg`, which the
 * field can't show.
 */
export function degreesOf(raw: string): number | null {
  const v = raw.trim();
  if (v === "none" || v === "0") return 0;
  const m = v.match(/^(?:z\s+)?(-?\d*\.?\d+)(deg|turn|rad|grad)$/);
  if (!m) return null;
  return Math.round(parseFloat(m[1]!) * TURN[m[2]!]! * 100) / 100;
}
