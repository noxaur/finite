import type { Rect } from "@finite/protocol";
import type { StyleEdit, Target } from "./styleEditor";

export type Geometry = "x" | "y" | "w" | "h";

export interface GeometryFacts {
  readonly values: Record<Geometry, number>;
  /** Whether X and Y can move it. An element in the flow is placed by its layout. */
  readonly movable: boolean;
  /** The edit that gives `field` the value `n`. */
  readonly editFor: (field: Geometry, n: number) => StyleEdit | null;
}

/**
 * The selected element's place in its frame and its size, in CSS pixels. X and Y only show
 * where it is (its layout places it); W and H write `width` and `height`.
 */
export function geometryOf(target: Target, rect: Rect): GeometryFacts {
  const values: Record<Geometry, number> = {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    w: Math.round(rect.width),
    h: Math.round(rect.height),
  };
  return {
    values,
    movable: false,
    editFor: (field, n) => {
      if (!Number.isFinite(n) || Math.abs(n - values[field]) < 0.5) return null;
      if (field === "w")
        return { kind: "setStyles", ids: [target.id], styles: { width: `${n}px` } };
      if (field === "h")
        return { kind: "setStyles", ids: [target.id], styles: { height: `${n}px` } };
      return null;
    },
  };
}
