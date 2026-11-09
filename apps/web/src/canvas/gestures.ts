import type { Frame, Hit, HitElement, Loc, Rect, Rev, SourceEdit } from "@finite/protocol";

/** A side or corner of a box, as compass points. */
export type Handle = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
export const HANDLES: readonly Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
export const CORNERS: readonly Handle[] = ["nw", "ne", "sw", "se"];

export type Point = { x: number; y: number };

/** The file a loc points into: `src/App.tsx:12:4` → `src/App.tsx`. */
export const fileOf = (loc: Loc): string => loc.replace(/:\d+:\d+$/, "");

/** The file's name without folders, as people read it: `Button.tsx`. */
export const baseName = (file: string): string => file.slice(file.lastIndexOf("/") + 1);

/** `revs` for a SourceEdit: the rev of every file the elements point into. */
export function revsOf(elements: ReadonlyArray<{ loc: Loc; rev: Rev }>): Record<string, Rev> {
  const out: Record<string, Rev> = {};
  for (const e of elements) out[fileOf(e.loc)] = e.rev;
  return out;
}

/** A box with `handle` dragged by `d`, in the same units, never smaller than `min`. */
export function resizeBox(box: Rect, handle: Handle, d: Point, min = 1): Rect {
  let { x, y, width, height } = box;
  if (handle.includes("e")) width = Math.max(min, width + d.x);
  if (handle.includes("s")) height = Math.max(min, height + d.y);
  if (handle.includes("w")) {
    const w = Math.max(min, width - d.x);
    x += width - w;
    width = w;
  }
  if (handle.startsWith("n")) {
    const h = Math.max(min, height - d.y);
    y += height - h;
    height = h;
  }
  return { x, y, width, height };
}

/** Where a positioned element sits: its computed insets, and how many frame pixels one of its own covers. */
export type ResizeInsets = { left: number; top: number; zoom: number };

/**
 * The styles an element resize writes: the width and height its handle changes, in whole CSS
 * pixels. `rect` is the element's box in the frame (CSS pixels) and `d` the pointer's travel in
 * CSS pixels (screen travel over zoom). A positioned element also moves its `top` and `left` with
 * the north and west handles, so the opposite edges stay put; a flow element has no insets to set.
 */
export function resizeStyles(
  rect: Rect,
  handle: Handle,
  d: Point,
  at?: ResizeInsets,
): Record<string, string> {
  const next = resizeBox(rect, handle, d);
  const out: Record<string, string> = {};
  if (handle.includes("e") || handle.includes("w")) out.width = `${Math.round(next.width)}px`;
  if (handle.startsWith("n") || handle.startsWith("s")) out.height = `${Math.round(next.height)}px`;
  if (at && handle.includes("w"))
    out.left = `${Math.round(at.left + (next.x - rect.x) / at.zoom)}px`;
  if (at && handle.startsWith("n"))
    out.top = `${Math.round(at.top + (next.y - rect.y) / at.zoom)}px`;
  return out;
}

/** The style edit an element resize ends in. */
export function resizeEdit(
  el: { loc: Loc; rev: Rev; tag: string },
  rect: Rect,
  handle: Handle,
  d: Point,
  at?: ResizeInsets,
): SourceEdit | null {
  if (Math.abs(d.x) < 0.5 && Math.abs(d.y) < 0.5) return null;
  return {
    kind: "style",
    locs: [el.loc],
    tag: el.tag,
    styles: resizeStyles(rect, handle, d, at),
    revs: revsOf([el]),
  };
}

/** Frames dragged by `d` canvas units, rounded to whole units, for `moveFrames`. */
export function movedFrames(frames: readonly Frame[], d: Point) {
  return frames.map((f) => ({ id: f.id, x: Math.round(f.x + d.x), y: Math.round(f.y + d.y) }));
}

/** A frame with `handle` dragged by `d` canvas units, for `resizeFrames`. Stops hugging when its height is set. */
export function resizedFrame(frame: Frame, handle: Handle, d: Point) {
  const r = resizeBox(frame, handle, d, 20);
  const height = handle.startsWith("n") || handle.startsWith("s");
  return {
    id: frame.id,
    x: Math.round(r.x),
    y: Math.round(r.y),
    width: Math.round(r.width),
    height: Math.round(r.height),
    ...(frame.hug !== undefined ? { hug: height ? false : frame.hug } : {}),
  };
}

/** Whether a parent lays its children out in a row or column, so dragging a child reorders it. */
export function flowAxis(parent: { display: string; flexDirection: string }): "x" | "y" | null {
  if (parent.display.includes("flex")) return parent.flexDirection.startsWith("row") ? "x" : "y";
  if (parent.display.includes("grid")) return "y";
  return null;
}

/**
 * Where a dragged child lands among its `siblings` (in order, itself included, with their
 * rects): the loc it goes before, or `null` for the end. `undefined` when it would stay put.
 */
export function reorderBefore(
  self: Loc,
  siblings: ReadonlyArray<{ loc: Loc; rect: Rect }>,
  pointer: Point,
  axis: "x" | "y",
): Loc | null | undefined {
  const mid = (r: Rect) => (axis === "x" ? r.x + r.width / 2 : r.y + r.height / 2);
  const at = axis === "x" ? pointer.x : pointer.y;
  const others = siblings.filter((s) => s.loc !== self);
  const next = others.find((s) => at < mid(s.rect));
  const before = next ? next.loc : null;
  // Landing just before or after itself leaves it where it is.
  const i = siblings.findIndex((s) => s.loc === self);
  const after = siblings[i + 1]?.loc ?? null;
  return before === after ? undefined : before;
}

/** The hit's stamped elements from the outermost down to the hit itself. */
export const chainOf = (hit: Hit): HitElement[] => [
  ...[...hit.path].reverse(),
  { loc: hit.loc, rev: hit.rev, tag: hit.tag },
];

/**
 * What a double-click selects: the element one level deeper than `selected` toward the hit,
 * or the outermost one when nothing in the chain is selected. `null` at the bottom already.
 */
export function drillInto(hit: Hit, selected: Loc | undefined): HitElement | null {
  const chain = chainOf(hit);
  const i = selected === undefined ? -1 : chain.findIndex((e) => e.loc === selected);
  return chain[i + 1] ?? null;
}

/**
 * For an `outside-prototype` refusal: the production file to copy into the prototype, and the
 * prototype file that imports it (the nearest ancestor inside `.finite/`).
 */
export function detachTarget(chain: readonly HitElement[], loc: Loc) {
  const file = fileOf(loc);
  const i = chain.findIndex((e) => e.loc === loc);
  const above = (i < 0 ? chain : chain.slice(0, i)).map((e) => fileOf(e.loc));
  const importer = [...above].reverse().find((f) => f.startsWith(".finite/") && f !== file);
  return importer ? { file, importer } : null;
}
