import { angle } from "./transform";

/** How an element is positioned: in the flow, or moved by its insets. */
export type PositionKind = "static" | "relative" | "absolute" | "fixed" | "sticky";

export const POSITIONS: ReadonlyArray<readonly [PositionKind, string]> = [
  ["static", "In flow"],
  ["relative", "Relative"],
  ["absolute", "Absolute"],
  ["fixed", "Fixed"],
  ["sticky", "Sticky"],
];

const INSETS = ["inset", "top", "right", "bottom", "left"] as const;

/** Inline properties the Position section reads and writes. */
export const POSITION_PROPS = [...INSETS, "position", "z-index", "rotate"] as const;

/** A computed or inline `position` as one of the kinds; `null` for anything else. */
export function positionKindOf(raw: string | undefined): PositionKind | null {
  const v = raw?.trim() ?? "static";
  return POSITIONS.some(([k]) => k === v) ? (v as PositionKind) : null;
}

/**
 * The styles that position an element as `kind`. Going back into the flow
 * takes its insets off, and writes `static` only when a stylesheet would
 * otherwise position it. Sticky needs an inset to stick by, so it gets
 * `top: 0` when it has none. Absolute and fixed leave the insets as they
 * are: without any, the element stays where the flow put it.
 */
export function positionStyles(
  kind: PositionKind,
  styles: Readonly<Record<string, string>>,
  computed: string | undefined,
): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  if (kind === "static") {
    if (styles.position !== undefined) out.position = null;
    else if (computed && computed !== "static") out.position = "static";
    for (const p of INSETS) if (styles[p] !== undefined) out[p] = null;
    return out;
  }
  out.position = kind;
  const pinned = (p: string) => styles[p] !== undefined && styles[p] !== "auto";
  if (kind === "sticky" && !pinned("top") && !pinned("bottom") && !pinned("inset")) {
    out.top = "0px";
  }
  return out;
}

/**
 * A `rotate` in degrees: `45deg` is 45, `0.25turn` is 90, `none` is 0.
 * `null` for a rotation about another axis, like `x 45deg`, which the
 * field can't show.
 */
export function degreesOf(raw: string): number | null {
  const v = raw.trim();
  return v === "none" ? 0 : angle(v.replace(/^z\s+/i, ""));
}
