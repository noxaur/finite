import type { UserEdit } from "../../schema";
import { resize } from "../geometry";
import type { Gesture } from "../gesture";
import { nodeOf } from "../tree";

/** Drags one of the selection's handles to resize it. An artboard's left or top edge moves it too. */
export const resizeNode: Gesture = {
  name: "resize",
  begin(press, ctx) {
    const [id] = ctx.selection;
    if (!press.handle || id === undefined || ctx.selection.length !== 1) return null;
    const node = nodeOf(ctx.replica, id);
    const start = ctx.measure(id);
    if (!node || !start) return null;
    const handle = press.handle;
    return {
      move: (p) => {
        const delta = { x: (p.x - press.x) / start.scale, y: (p.y - press.y) / start.scale };
        if (Math.round(delta.x) === 0 && Math.round(delta.y) === 0) return null;
        const sized = resize(node, start, handle, delta);
        const edits: UserEdit[] = [sized];
        if (node.parent === null && (handle.includes("w") || handle.startsWith("n"))) {
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
                x: (node.x ?? 0) - (handle.includes("w") ? grownX : 0),
                y: (node.y ?? 0) - (handle.startsWith("n") ? grownY : 0),
              },
            ],
          });
        }
        return edits;
      },
    };
  },
};
