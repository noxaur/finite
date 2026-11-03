import type { Node, UserEdit } from "../schema";

/**
 * How a person's drag becomes CSS. Only the browser can lay a design out,
 * so these read what the live DOM measured (`Renderer.measure`) and the
 * node's inline styles, and say which edit the drag means. They're pure,
 * so tests run them without a DOM. The document's own rules, like a
 * shorthand clearing its longhands, stay in Rust (`user_edit::plan`).
 */

/** An edit that sets inline styles. */
export type SetStyles = Extract<UserEdit, { kind: "setStyles" }>;

/** A point or a distance, in CSS pixels unless it says otherwise. */
export interface Point {
  readonly x: number;
  readonly y: number;
}

/** A box in page pixels. */
export interface Box {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** The facts about an element that a move or resize needs. A subset of `Measured`. */
export interface Facts {
  readonly position: string;
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  /** The border box, in page pixels. */
  readonly rect: Box & { readonly width: number; readonly height: number };
  /** Page pixels per CSS pixel. */
  readonly scale: number;
}

/** Whether moving the element changes its insets (it's out of flow), rather than its place among siblings. */
export const isPositioned = (facts: Pick<Facts, "position">) =>
  facts.position === "absolute" || facts.position === "fixed";

const px = (n: number) => `${Math.round(n)}px`;

/** Moves artboards from where they started by `delta`, in canvas units. */
export function moveArtboards(
  starts: ReadonlyArray<{ readonly id: string; readonly x: number; readonly y: number }>,
  delta: Point,
): UserEdit {
  return {
    kind: "setPosition",
    moves: starts.map((s) => ({
      id: s.id,
      x: Math.round(s.x + delta.x),
      y: Math.round(s.y + delta.y),
    })),
  };
}

/**
 * Which insets pin a positioned element on one axis, read from its inline
 * style: both (its size then comes from them), the far one (`right` or
 * `bottom`) when only that is set, or the near one. Computed insets are all
 * resolved to pixels, so they can't say which ones a stylesheet set.
 */
function pinOf(node: Node, near: "left" | "top", far: "right" | "bottom") {
  const set = (key: string) => node.styles[key] !== undefined && node.styles[key] !== "auto";
  if (set(near) && set(far)) return "both";
  return set(far) ? "far" : "near";
}

/** An inset's value, 0 when it resolved to `auto`. */
const insetOf = (value: number) => (Number.isNaN(value) ? 0 : value);

/**
 * Moves an absolutely positioned element by `delta` from where it started,
 * keeping the insets it's pinned by. One pinned by both keeps its size, so
 * both move.
 */
export function moveAbsolute(node: Node, start: Facts, delta: Point): SetStyles {
  const styles: Record<string, string | null> = {};
  const axis = (near: "left" | "top", far: "right" | "bottom", d: number) => {
    const pin = pinOf(node, near, far);
    if (pin !== "near") styles[far] = px(insetOf(start[far]) - d);
    if (pin !== "far") styles[near] = px(insetOf(start[near]) + d);
  };
  axis("left", "right", delta.x);
  axis("top", "bottom", delta.y);
  return { kind: "setStyles", ids: [node.id], styles };
}

/** The four edges and four corners a resize handle can sit on. */
export type Handle = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

export const HANDLES: ReadonlyArray<Handle> = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

/** The smallest size a resize leaves, in CSS pixels. */
export const MIN_SIZE = 1;

/**
 * Resizes an element by dragging `handle` by `delta`, so the dragged edge
 * follows the pointer and the opposite edge stays put. It gets a fixed
 * `width` and `height` in pixels on the axes the handle moves, and a flex
 * item that grows to fill its line stops growing, so the size sticks. A
 * positioned element's inset on the dragged edge moves too when it pins
 * that edge; one pinned by both insets is sized by them alone. A
 * `content-box` element's `width` and `height` leave out its padding and
 * borders (`frameX`, `frameY`), so those come off.
 */
export function resize(
  node: Node,
  start: Facts & {
    readonly flexGrow: number;
    readonly frameX: number;
    readonly frameY: number;
  },
  handle: Handle,
  delta: Point,
): SetStyles {
  const styles: Record<string, string | null> = {};
  const axis = (
    near: "left" | "top",
    far: "right" | "bottom",
    size: "width" | "height",
    dragsNear: boolean,
    d: number,
    border: number,
    frame: number,
  ) => {
    const next = Math.max(frame + MIN_SIZE, border + (dragsNear ? -d : d));
    const grown = next - border;
    const pin = isPositioned(start) ? pinOf(node, near, far) : "near";
    if (pin !== "both") styles[size] = px(next - frame);
    // The dragged edge's inset moves when it pins that edge.
    if (dragsNear && pin !== "far" && isPositioned(start)) {
      styles[near] = px(insetOf(start[near]) - grown);
    }
    if (!dragsNear && pin !== "near") styles[far] = px(insetOf(start[far]) - grown);
  };
  const west = handle.includes("w");
  const north = handle.startsWith("n");
  if (west || handle.includes("e")) {
    axis("left", "right", "width", west, delta.x, start.rect.width / start.scale, start.frameX);
  }
  if (north || handle.startsWith("s")) {
    axis("top", "bottom", "height", north, delta.y, start.rect.height / start.scale, start.frameY);
  }
  if (start.flexGrow > 0) styles["flex-grow"] = "0";
  return { kind: "setStyles", ids: [node.id], styles };
}

/** How a container lays out its children, for finding where a dragged one goes. */
export type Flow = "row" | "row-reverse" | "column" | "column-reverse" | "wrap";

/** The flow a container's computed `display`, `flex-direction` and `flex-wrap` give it. */
export function flowOf(display: string, flexDirection: string, flexWrap: string): Flow {
  if (display.includes("grid")) return "wrap";
  if (!display.includes("flex")) return "column";
  if (flexWrap !== "nowrap") return "wrap";
  return flexDirection === "row" ||
    flexDirection === "row-reverse" ||
    flexDirection === "column-reverse"
    ? flexDirection
    : "column";
}

/** Whether a container lays children out by itself, so dropping into it means something. */
export const isLayout = (display: string) => display.includes("flex") || display.includes("grid");

/**
 * The sibling a dragged element goes right before, so the pointer sits
 * where it lands: the first child (in document order) the pointer comes
 * before along the container's flow. `null` means after the last one.
 * `children` leaves out the dragged elements.
 */
export function slotBefore(
  flow: Flow,
  children: ReadonlyArray<{ readonly id: string; readonly rect: Box }>,
  pointer: Point,
): string | null {
  const midX = (r: Box) => (r.left + r.right) / 2;
  const midY = (r: Box) => (r.top + r.bottom) / 2;
  const before = (r: Box) => {
    switch (flow) {
      case "row":
        return pointer.x < midX(r);
      case "row-reverse":
        return pointer.x > midX(r);
      case "column":
        return pointer.y < midY(r);
      case "column-reverse":
        return pointer.y > midY(r);
      case "wrap":
        // Rows from the top, each from the left.
        return pointer.y < r.top || (pointer.y < r.bottom && pointer.x < midX(r));
    }
  };
  return children.find((c) => before(c.rect))?.id ?? null;
}

/** Whether `point` is inside `box`. */
export const inside = (box: Box, point: Point) =>
  point.x >= box.left && point.x < box.right && point.y >= box.top && point.y < box.bottom;

/** How close an edge or centre comes to another, in page pixels, before it snaps to it. */
export const SNAP_PX = 6;

/** A snap guide, in page pixels: a vertical line at `x` from `from` to `to`, or a horizontal one at `y`. */
export type Guide =
  | { readonly x: number; readonly from: number; readonly to: number }
  | { readonly y: number; readonly from: number; readonly to: number };

/**
 * Snaps a moving box to the edges and centres of `others`, so things line
 * up. `edges` says which of the box's own lines move with the pointer: all
 * three for a move, one edge for a resize. Returns how far to shift the box
 * along each axis (0 when nothing is near) and the guides to draw.
 */
export function snap(
  box: Box,
  others: ReadonlyArray<Box>,
  edges: { readonly x: ReadonlyArray<number>; readonly y: ReadonlyArray<number> },
  threshold = SNAP_PX,
): { readonly dx: number; readonly dy: number; readonly guides: ReadonlyArray<Guide> } {
  const lines = (b: Box, axis: "x" | "y") =>
    axis === "x"
      ? [b.left, (b.left + b.right) / 2, b.right]
      : [b.top, (b.top + b.bottom) / 2, b.bottom];
  const best = (axis: "x" | "y", own: ReadonlyArray<number>) => {
    let shift = Infinity;
    for (const other of others) {
      for (const target of lines(other, axis)) {
        for (const line of own) {
          const d = target - line;
          if (Math.abs(d) <= threshold && Math.abs(d) < Math.abs(shift)) shift = d;
        }
      }
    }
    return Number.isFinite(shift) ? shift : 0;
  };
  const dx = edges.x.length > 0 ? best("x", edges.x) : 0;
  const dy = edges.y.length > 0 ? best("y", edges.y) : 0;
  const moved: Box = {
    left: box.left + dx,
    right: box.right + dx,
    top: box.top + dy,
    bottom: box.bottom + dy,
  };
  const guides: Guide[] = [];
  const close = (a: number, b: number) => Math.abs(a - b) < 0.5;
  for (const other of others) {
    for (const x of lines(other, "x")) {
      if (edges.x.some((line) => close(line + dx, x))) {
        guides.push({
          x,
          from: Math.min(moved.top, other.top),
          to: Math.max(moved.bottom, other.bottom),
        });
      }
    }
    for (const y of lines(other, "y")) {
      if (edges.y.some((line) => close(line + dy, y))) {
        guides.push({
          y,
          from: Math.min(moved.left, other.left),
          to: Math.max(moved.right, other.right),
        });
      }
    }
  }
  return { dx, dy, guides };
}

/** The lines of `box` that a move carries: its edges and centre on each axis. */
export const moveEdges = (box: Box) => ({
  x: [box.left, (box.left + box.right) / 2, box.right],
  y: [box.top, (box.top + box.bottom) / 2, box.bottom],
});

/** Whether two boxes overlap. */
export const overlaps = (a: Box, b: Box) =>
  a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
