import type { Box } from "../geometry";
import type { EditContext } from "../gesture";

/**
 * What a node lines up with while it moves or resizes: the other artboards
 * on the page for an artboard, its parent and siblings for an element.
 * Boxes are in page pixels, read once when the gesture starts.
 */
export function snapTargets(ctx: EditContext, ids: ReadonlyArray<string>): Box[] {
  const [first] = ids;
  const node = first === undefined ? undefined : ctx.replica.get(first);
  const candidates =
    node === undefined
      ? []
      : node.parent === null
        ? ctx.artboards()
        : [node.parent, ...ctx.replica.children(node.parent).map((c) => c.id)];
  return candidates.flatMap((id) => {
    if (ids.includes(id)) return [];
    const rect = ctx.rect(id);
    return rect && rect.width > 0 && rect.height > 0 ? [rect] : [];
  });
}

/** The smallest box around `boxes`. */
export function around(boxes: ReadonlyArray<Box>): Box | null {
  if (boxes.length === 0) return null;
  return {
    left: Math.min(...boxes.map((b) => b.left)),
    top: Math.min(...boxes.map((b) => b.top)),
    right: Math.max(...boxes.map((b) => b.right)),
    bottom: Math.max(...boxes.map((b) => b.bottom)),
  };
}

/** `box` moved by `d`. */
export const shifted = (box: Box, d: { x: number; y: number }): Box => ({
  left: box.left + d.x,
  right: box.right + d.x,
  top: box.top + d.y,
  bottom: box.bottom + d.y,
});
