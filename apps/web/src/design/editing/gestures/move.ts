import type { UserEdit } from "../../schema";
import {
  flowOf,
  type Guide,
  inside,
  isLayout,
  isPositioned,
  moveAbsolute,
  moveEdges,
  slotBefore,
  snap,
} from "../geometry";
import type { EditContext, Gesture, Pointer } from "../gesture";
import { lineage, nodeOf } from "../tree";
import { shifted, snapTargets } from "./snapping";

/**
 * Drags a selected element. One that's absolutely positioned moves by its
 * insets, snapping to its parent's and siblings' edges and centres (hold ⌘
 * or Ctrl to place it freely). One in the flow keeps its size and moves among its siblings, or
 * into another flex or grid container once the pointer leaves its parent,
 * and the layout puts it where it lands.
 */
export const moveElement: Gesture = {
  begin(press, ctx) {
    if (!press.hit) return null;
    const id = lineage(ctx.replica, press.hit.nodeId).find((n) => ctx.selection.includes(n));
    const node = id === undefined ? undefined : nodeOf(ctx.replica, id);
    const start = id === undefined ? null : ctx.measure(id);
    if (!node || node.parent === null || !start) return null;
    if (isPositioned(start)) {
      const others = snapTargets(ctx, [node.id]);
      let guides: ReadonlyArray<Guide> = [];
      return {
        move: (p) => {
          let d = { x: p.x - press.x, y: p.y - press.y };
          guides = [];
          if (!p.free) {
            const moved = shifted(start.rect, d);
            const snapped = snap(moved, others, moveEdges(moved));
            d = { x: d.x + snapped.dx, y: d.y + snapped.dy };
            guides = snapped.guides;
          }
          const delta = { x: d.x / start.scale, y: d.y / start.scale };
          return Math.round(delta.x) === 0 && Math.round(delta.y) === 0
            ? null
            : [moveAbsolute(node, start, delta)];
        },
        guides: () => guides,
      };
    }
    const home = node.parent;
    const after = ctx.replica.siblingsAfter(node.id).next().value?.id ?? null;
    let slot: { parent: string; before: string | null } = { parent: home, before: after };
    return {
      move: (p) => {
        const rect = ctx.rect(node.id);
        // Over itself, it stays put, or it would flicker between two slots.
        if (!rect || !inside(rect, p)) slot = slotAt(ctx, node.id, home, p) ?? slot;
        if (slot.parent === home && slot.before === after) return null;
        const place: UserEdit = { kind: "place", ids: [node.id], ...slot };
        return [place];
      },
      target: () => (slot.parent === home ? null : slot.parent),
    };
  },
};

/**
 * Where a dragged node goes for the pointer at `p`: among the children of
 * its parent while the pointer is over the parent, otherwise of the
 * innermost flex or grid container under the pointer.
 */
function slotAt(ctx: EditContext, dragged: string, home: string, p: Pointer) {
  const hit = ctx.hitTest(p.x, p.y);
  if (!hit) return null;
  const under = lineage(ctx.replica, hit.nodeId);
  // Never into itself.
  const outside = under.slice(under.indexOf(dragged) + 1);
  const parent = outside.includes(home)
    ? home
    : outside.find((id) => {
        const m = ctx.measure(id);
        return m !== null && isLayout(m.display);
      });
  const container = parent === undefined ? null : ctx.measure(parent);
  if (parent === undefined || !container) return null;
  const children = ctx.replica.children(parent).flatMap((child) => {
    const rect = child.id === dragged ? null : ctx.rect(child.id);
    return rect && (rect.width > 0 || rect.height > 0) ? [{ id: child.id, rect }] : [];
  });
  const flow = flowOf(container.display, container.flexDirection, container.flexWrap);
  return { parent, before: slotBefore(flow, children, p) };
}
