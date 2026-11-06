import { parts } from "./lists";

/**
 * A stroke's position. Inside is a `border` (Finite's boxes are
 * border-box, so it eats into the size); center and outside are an
 * `outline`, which takes no room, at `outline-offset` minus half its width
 * and at zero.
 */
export type StrokePosition = "inside" | "center" | "outside";

/** The parts of a stroke, as CSS values. */
export interface StrokeParts {
  readonly width: string;
  readonly style: string;
  readonly color: string;
}

const painted = (style: string | undefined) =>
  style !== undefined && style !== "" && style !== "none" && style !== "hidden";

/** A box's sides, in the order CSS lists them. */
export const SIDES = ["top", "right", "bottom", "left"] as const;
export type Side = (typeof SIDES)[number];

/** One side's border style, from its own longhand or its place in `border-style`. */
export function sideStyle(
  read: (prop: string) => string | undefined,
  side: Side,
): string | undefined {
  const own = read(`border-${side}-style`);
  if (own !== undefined) return own;
  const all = parts(read("border-style") ?? "");
  const [t, r = t, b = t, l = r] = all;
  return { top: t, right: r, bottom: b, left: l }[side];
}

/** Whether a border style draws a line. */
export const isPaintedStyle = painted;

/** The offset that centers an outline of `width` on the edge. */
export function centerOffset(width: string): string {
  const m = width.trim().match(/^(\d*\.?\d+)([a-z%]*)$/i);
  if (m) {
    const half = Number(m[1]) / 2;
    return half === 0 ? "0px" : `-${half}${m[2] || "px"}`;
  }
  return `calc(${width} / -2)`;
}

/** Whether any side of the border draws a line. */
export const hasBorder = (read: (prop: string) => string | undefined) =>
  SIDES.some((side) => painted(sideStyle(read, side)));

/**
 * Where the outline is, center or outside, from its style, width and
 * offset; `null` when there's none. A layer can have it beside a border.
 */
export function outlinePosition(
  read: (prop: string) => string | undefined,
): "center" | "outside" | null {
  if (!painted(read("outline-style"))) return null;
  const width = read("outline-width") ?? "medium";
  const offset = read("outline-offset")?.trim() ?? "0px";
  return offset === centerOffset(width) && offset !== "0px" ? "center" : "outside";
}

/** The longhands each position writes, by part. */
const PROPS: Readonly<Record<"border" | "outline", StrokeParts>> = {
  border: { width: "border-width", style: "border-style", color: "border-color" },
  outline: { width: "outline-width", style: "outline-style", color: "outline-color" },
};

/** Which property sets `part` of a stroke at `position`. */
export const strokeProp = (position: StrokePosition, part: keyof StrokeParts) =>
  PROPS[position === "inside" ? "border" : "outline"][part];

/**
 * The styles that move a stroke with `parts` to `to`, in one edit: the new
 * one as longhands (never a shorthand the element didn't have), and the old
 * one taken off from `from`. `own` is the element's inline styles; a stroke drawn by a
 * class is covered with `none` instead.
 */
export function moveStroke(
  own: Readonly<Record<string, string>>,
  from: StrokePosition,
  to: StrokePosition,
  parts: StrokeParts,
): Record<string, string | null> {
  const out = (from === "inside") !== (to === "inside") ? removeStroke(own, from) : {};
  const target = to === "inside" ? "border" : "outline";
  if (to !== "inside") out["outline-offset"] = to === "center" ? centerOffset(parts.width) : "0px";
  out[PROPS[target].width] = parts.width;
  out[PROPS[target].style] = parts.style;
  out[PROPS[target].color] = parts.color;
  return out;
}

/**
 * The styles that take the stroke at `position` off: its inline
 * declarations go, and one a class draws is covered with `none`.
 */
export function removeStroke(
  own: Readonly<Record<string, string>>,
  position: StrokePosition,
): Record<string, string | null> {
  const kind = position === "inside" ? "border" : "outline";
  const out: Record<string, string | null> = {};
  for (const prop of Object.keys(own)) {
    if (prop === kind || (prop.startsWith(`${kind}-`) && !prop.includes("radius")))
      out[prop] = null;
  }
  if (!(kind in out) && !(`${kind}-style` in out)) out[`${kind}-style`] = "none";
  return out;
}

const OUTLINE_STYLES = /^(none|hidden|dotted|dashed|solid|double|groove|ridge|inset|outset|auto)$/;

/** A part of an `outline` shorthand an element sets, like the width of `2px dotted blue`. */
export function outlinePart(
  styles: Readonly<Record<string, string>>,
  prop: string,
): string | undefined {
  const short = styles.outline;
  const part = prop.match(/^outline-(width|style|color)$/)?.[1];
  if (short === undefined || !part || styles[prop] !== undefined) return styles[prop];
  return parts(short).find((p) =>
    part === "style"
      ? OUTLINE_STYLES.test(p)
      : part === "width"
        ? /^(-?\d|\.|thin$|medium$|thick$|calc\()/.test(p)
        : !OUTLINE_STYLES.test(p) && !/^(-?\d|\.|thin$|medium$|thick$|calc\()/.test(p),
  );
}
