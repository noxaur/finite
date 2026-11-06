import { type Box, overlaps } from "../geometry";
import type { Gesture } from "../gesture";

/**
 * Drags a selection box on the empty canvas: it selects the artboards it
 * touches, added to what's selected with Shift. Hold Space to pan instead.
 */
export const selectBox: Gesture = {
  begin(press, ctx) {
    if (press.hit || press.label || press.handle) return null;
    const kept = press.shift ? ctx.selection : [];
    const boards = ctx.artboards().flatMap((id) => {
      const rect = ctx.rect(id);
      return rect ? [{ id, rect }] : [];
    });
    let area: Box | null = null;
    let picked: ReadonlyArray<string> = kept;
    return {
      move: (p) => {
        area = {
          left: Math.min(press.x, p.x),
          right: Math.max(press.x, p.x),
          top: Math.min(press.y, p.y),
          bottom: Math.max(press.y, p.y),
        };
        const box = area;
        const touched = boards.filter((b) => overlaps(b.rect, box)).map((b) => b.id);
        picked = [...kept, ...touched.filter((id) => !kept.includes(id))];
        return null;
      },
      area: () => area,
      selection: () => picked,
    };
  },
};
