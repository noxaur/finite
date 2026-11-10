import type { View } from "./camera";
import type { Bounds } from "./types";

/** Whether two boxes share any area. Boxes that only touch don't. */
export function overlaps(a: Bounds, b: Bounds): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/**
 * The canvas area a `width` × `height` viewport shows under `view`, grown by
 * `margin` viewports on each side so a short pan doesn't reveal blank space.
 */
export function visibleBounds(view: View, width: number, height: number, margin = 0.5): Bounds {
  const w = width / view.zoom;
  const h = height / view.zoom;
  return {
    x: -view.x / view.zoom - w * margin,
    y: -view.y / view.zoom - h * margin,
    width: w * (1 + 2 * margin),
    height: h * (1 + 2 * margin),
  };
}
