import { HIDDEN_ATTR } from "@/design/editing/layers";
import { isPositioned, moveAbsolute, moveArtboards, resize } from "@/design/editing/geometry";
import { mainAxis, parentLayoutOf, ratioOf } from "@/design/editing/sizing";
import type { Renderer } from "@/design/renderer";
import type { Replica } from "@/design/replica";
import type { Node, UserEdit } from "@/design/schema";

export type Geometry = "x" | "y" | "w" | "h";

export interface GeometryFacts {
  readonly values: Record<Geometry, number>;
  /** Whether X and Y can move it: an artboard, or a positioned element. */
  readonly movable: boolean;
  /** The edit that gives `field` the value `n`. */
  readonly editFor: (field: Geometry, n: number) => UserEdit | null;
}

/**
 * The selected node's position and size, in CSS pixels, to type exact
 * values into. An artboard's X and Y are its place on the canvas; a
 * positioned element's are its `left` and `top`. An element in the flow
 * is placed by its layout, so its X and Y only show where it is. A hidden
 * layer has no box to show.
 */
export function geometryOf(node: Node, renderer: Renderer, replica: Replica): GeometryFacts | null {
  const measured = renderer.measure(node.id);
  if (!measured || node.attrs[HIDDEN_ATTR] !== undefined) return null;
  // W and H are the element's own size, which a rotation or transform
  // doesn't change; its drawn box is only their bounds. The computed size
  // leaves out a content-box element's padding and borders.
  const css = renderer.computedStyle(node.id);
  const own = (value: string | undefined, frame: number, drawn: number) =>
    value?.endsWith("px") ? (parseFloat(value) + frame) * measured.scale : drawn;
  const facts = {
    ...measured,
    // A DOMRect's sides are getters, which a spread wouldn't copy.
    rect: {
      left: measured.rect.left,
      top: measured.rect.top,
      right: measured.rect.right,
      bottom: measured.rect.bottom,
      width: own(css?.width, measured.frameX, measured.rect.width),
      height: own(css?.height, measured.frameY, measured.rect.height),
    },
  };
  const board = node.parent === null;
  const artboard = replica.artboardOf(node.id);
  const boardRect = artboard ? renderer.nodeRect(artboard.id) : null;
  const values: Record<Geometry, number> = {
    x: board
      ? (node.x ?? 0)
      : isPositioned(facts)
        ? facts.left
        : (facts.rect.left - (boardRect?.left ?? 0)) / facts.scale,
    y: board
      ? (node.y ?? 0)
      : isPositioned(facts)
        ? facts.top
        : (facts.rect.top - (boardRect?.top ?? 0)) / facts.scale,
    w: facts.rect.width / facts.scale,
    h: facts.rect.height / facts.scale,
  };
  const parent = node.parent === null ? null : renderer.computedStyle(node.parent);
  const main =
    parent && !isPositioned(facts)
      ? mainAxis(parentLayoutOf(parent.display, parent.flexDirection))
      : null;
  // With its ratio locked and no height of its own, its height follows its width.
  const declared = node.styles["aspect-ratio"];
  const ratio =
    declared !== undefined && node.styles.height === undefined ? ratioOf(declared) : null;
  /** Resizes one axis; along a flex parent's main axis, a size typed in replaces the `flex` that filled it. */
  const sized = (axis: "width" | "height", d: number) => {
    const edit =
      axis === "width"
        ? resize(node, facts, "e", { x: d, y: 0 })
        : resize(node, facts, "s", { x: 0, y: d });
    if (main !== axis) return edit;
    const styles = { ...edit.styles };
    for (const p of ["flex", "flex-basis"]) if (node.styles[p] !== undefined) styles[p] = null;
    // Taking `flex` off already stops it growing.
    if (node.styles.flex !== undefined && node.styles["flex-grow"] === undefined) {
      delete styles["flex-grow"];
    }
    return { ...edit, styles };
  };
  return {
    values,
    movable: board || isPositioned(facts),
    editFor: (field, n) => {
      const d = n - values[field];
      if (!Number.isFinite(n) || Math.abs(d) < 0.5) return null;
      if (field === "w") return sized("width", d);
      if (field === "h" && ratio !== null) {
        return sized("width", n * ratio - values.w);
      }
      if (field === "h") return sized("height", d);
      const delta = field === "x" ? { x: d, y: 0 } : { x: 0, y: d };
      if (board) return moveArtboards([{ id: node.id, x: node.x ?? 0, y: node.y ?? 0 }], delta);
      return isPositioned(facts) ? moveAbsolute(node, facts, delta) : null;
    },
  };
}
