import { moveArtboards } from "../geometry";
import type { Gesture } from "../gesture";

/** Drags artboards by their name label, or a selected one by its background. */
export const moveArtboard: Gesture = {
  name: "move artboard",
  begin(press, ctx) {
    const pressed =
      press.label ?? (press.hit?.nodeId === press.hit?.artboardId ? press.hit?.artboardId : null);
    if (!pressed || !ctx.selection.includes(pressed)) return null;
    const starts = ctx.selection.flatMap((id) => {
      const node = ctx.replica.get(id);
      return node?.parent === null ? [{ id, x: node.x ?? 0, y: node.y ?? 0 }] : [];
    });
    return {
      move: (p) => {
        const delta = {
          x: (p.x - press.x) * ctx.canvasPerPixel,
          y: (p.y - press.y) * ctx.canvasPerPixel,
        };
        return Math.round(delta.x) === 0 && Math.round(delta.y) === 0
          ? null
          : [moveArtboards(starts, delta)];
      },
    };
  },
};
