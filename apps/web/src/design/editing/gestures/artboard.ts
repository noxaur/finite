import { type Guide, moveArtboards, moveEdges, snap } from "../geometry";
import type { Gesture } from "../gesture";
import { around, shifted, snapTargets } from "./snapping";

/**
 * Drags artboards by their name label, or a selected one by its
 * background. They snap to the edges and centres of the page's other
 * artboards; hold ⌘ or Ctrl to place them freely.
 */
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
    const ids = starts.map((s) => s.id);
    const box = around(ids.flatMap((id) => ctx.rect(id) ?? []));
    const others = snapTargets(ctx, ids);
    let guides: ReadonlyArray<Guide> = [];
    return {
      move: (p) => {
        let d = { x: p.x - press.x, y: p.y - press.y };
        guides = [];
        if (box && !p.free) {
          const moved = shifted(box, d);
          const snapped = snap(moved, others, moveEdges(moved));
          d = { x: d.x + snapped.dx, y: d.y + snapped.dy };
          guides = snapped.guides;
        }
        const delta = { x: d.x * ctx.canvasPerPixel, y: d.y * ctx.canvasPerPixel };
        return Math.round(delta.x) === 0 && Math.round(delta.y) === 0
          ? null
          : [moveArtboards(starts, delta)];
      },
      guides: () => guides,
    };
  },
};
