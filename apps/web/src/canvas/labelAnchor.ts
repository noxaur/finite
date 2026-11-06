interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
}

/**
 * How far above a frame's top a label's top may sit and still belong to that frame. The server
 * writes a frame's label 120 above it; the slack covers a label nudged by hand.
 */
export const ATTACH_RANGE = 180;

/**
 * The frame a label belongs to, or null for a free label. A label belongs to the nearest frame
 * under it that it overlaps sideways, when its top is within `ATTACH_RANGE` above that frame.
 * Such a label is drawn at a constant screen size like the frame's title, by its bottom edge just
 * over that title, so a long body grows upward and never covers the frame or its title.
 */
export function labelAnchor<B extends Box>(label: Box, frames: ReadonlyArray<B>): B | null {
  let best: B | null = null;
  for (const f of frames) {
    const overlaps = label.x < f.x + f.width && f.x < label.x + label.width;
    const gap = f.y - label.y;
    if (overlaps && gap > 0 && gap <= ATTACH_RANGE && (best === null || f.y < best.y)) best = f;
  }
  return best;
}
