import type { UserEdit } from "../../schema";
import { type Guide, resize, snap } from "../geometry";
import type { Gesture } from "../gesture";
import { nodeOf } from "../tree";
import { snapTargets } from "./snapping";

/**
 * Drags one of the selection's handles to resize it. The dragged edge
 * snaps to the edges and centres of what's around it (hold ⌘ or Ctrl to
 * size it freely). An artboard's left or top edge moves it too.
 */
export const resizeNode: Gesture = {
  name: "resize",
  begin(press, ctx) {
    const [id] = ctx.selection;
    if (!press.handle || id === undefined || ctx.selection.length !== 1) return null;
    const node = nodeOf(ctx.replica, id);
    const start = ctx.measure(id);
    if (!node || !start) return null;
    const handle = press.handle;
    const others = snapTargets(ctx, [id]);
    const east = handle.includes("e");
    const west = handle.includes("w");
    const south = handle.startsWith("s");
    const north = handle.startsWith("n");
    let guides: ReadonlyArray<Guide> = [];
    return {
      move: (p) => {
        const d = { x: p.x - press.x, y: p.y - press.y };
        guides = [];
        if (!p.free) {
          const r = start.rect;
          const box = {
            left: r.left + (west ? d.x : 0),
            right: r.right + (east ? d.x : 0),
            top: r.top + (north ? d.y : 0),
            bottom: r.bottom + (south ? d.y : 0),
          };
          const edges = {
            x: east ? [box.right] : west ? [box.left] : [],
            y: south ? [box.bottom] : north ? [box.top] : [],
          };
          const snapped = snap(box, others, edges);
          d.x += snapped.dx;
          d.y += snapped.dy;
          guides = snapped.guides;
        }
        const delta = { x: d.x / start.scale, y: d.y / start.scale };
        if (Math.round(delta.x) === 0 && Math.round(delta.y) === 0) return null;
        const sized = resize(node, start, handle, delta);
        const edits: UserEdit[] = [sized];
        if (node.parent === null && (west || north)) {
          // Growing to the left or up moves the artboard's corner by as much.
          const grownX = sized.styles.width
            ? parseFloat(sized.styles.width) + start.frameX - start.rect.width / start.scale
            : 0;
          const grownY = sized.styles.height
            ? parseFloat(sized.styles.height) + start.frameY - start.rect.height / start.scale
            : 0;
          edits.push({
            kind: "setPosition",
            moves: [
              {
                id,
                x: (node.x ?? 0) - (west ? grownX : 0),
                y: (node.y ?? 0) - (north ? grownY : 0),
              },
            ],
          });
        }
        return edits;
      },
      guides: () => guides,
    };
  },
};
