import type { Rect } from "./model.ts";

/** The smallest a section or slice gets, in canvas units. */
export const MIN_OBJECT = 24;

/**
 * `box` kept inside `bounds` (both from 0,0), at least `MIN_OBJECT` where there's room. A height
 * of `Infinity` leaves the vertical bounds open, for a frame whose height follows its content.
 * The page draws a slice with this and the server exports it with this, so they never disagree.
 */
export function clampInside(box: Rect, bounds: { width: number; height: number }): Rect {
  const width = Math.min(Math.max(box.width, MIN_OBJECT), bounds.width);
  const height = Math.min(Math.max(box.height, MIN_OBJECT), bounds.height);
  return {
    x: Math.min(Math.max(box.x, 0), bounds.width - width),
    y: Math.min(Math.max(box.y, 0), bounds.height - height),
    width,
    height,
  };
}
