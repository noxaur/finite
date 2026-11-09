import { layoutOf } from "./layout";
import { parts } from "./lists";

/**
 * How W and H size an element, as a design tool says it: a fixed number,
 * hugging its content, or filling its parent. Which CSS each means depends
 * on how the parent lays it out, so these take the parent's layout as read
 * from the browser.
 */
export type SizeMode = "fixed" | "hug" | "fill";

export type Axis = "width" | "height";

/** How the parent places the element: a flex row or column, a grid, block flow, or not at all. */
export type ParentLayout = "row" | "column" | "grid" | "block" | "none";

/** What the browser says about the element and its parent, which the inline styles can't. */
export interface SizeContext {
  readonly parent: ParentLayout;
  /** The parent's computed `align-items`, for whether a flex child stretches. */
  readonly parentAlign: string;
  /** The element's computed `display`. */
  readonly display: string;
  /** The element's computed `flex-grow`. */
  readonly grow: number;
  /** The element's computed `align-self`. */
  readonly alignSelf: string;
  /** What the bridge measured about each axis in a flex layout, when it did. */
  readonly sized?: Readonly<Partial<Record<Axis, string>>>;
}

type Computed = Pick<CSSStyleDeclaration, "display" | "position" | "flexGrow" | "alignSelf"> & {
  readonly sizedWidth?: string;
  readonly sizedHeight?: string;
};
type ParentComputed = Pick<CSSStyleDeclaration, "display" | "flexDirection" | "alignItems">;

/** The context from the element's and its parent's computed styles. An out-of-flow element has no parent layout. */
export function sizeContextOf(own: Computed, parent: ParentComputed | null): SizeContext {
  const out = own.position === "absolute" || own.position === "fixed";
  return {
    parent: out || !parent ? "none" : parentLayoutOf(parent.display, parent.flexDirection),
    parentAlign: parent?.alignItems ?? "",
    display: own.display,
    grow: parseFloat(own.flexGrow) || 0,
    alignSelf: own.alignSelf,
    ...(own.sizedWidth && own.sizedHeight
      ? { sized: { width: own.sizedWidth, height: own.sizedHeight } }
      : {}),
  };
}

export function parentLayoutOf(display: string, direction: string): ParentLayout {
  return display === "none" || display === "contents" ? "none" : layoutOf(display, direction);
}

/** The axis a flex parent lays its children along, or `null` when it isn't flex. */
export function mainAxis(parent: ParentLayout): Axis | null {
  return parent === "row" ? "width" : parent === "column" ? "height" : null;
}

const STRETCHES = new Set(["stretch", "normal"]);

/** How `axis` is sized now, from the inline styles and what the browser says. */
export function sizeModeOf(
  axis: Axis,
  styles: Readonly<Record<string, string>>,
  ctx: SizeContext,
): SizeMode {
  const v = styles[axis]?.trim();
  const main = mainAxis(ctx.parent);
  if (v && /^(100%|stretch|-webkit-fill-available)$/.test(v)) return "fill";
  if (v && /^(fit|max|min)-content\b/.test(v)) return "hug";
  if (main === axis && ctx.grow > 0) return "fill";
  if (v !== undefined && v !== "auto") return "fixed";
  if (ctx.sized?.[axis] === "fixed" || ctx.sized?.[axis] === "hug")
    return ctx.sized[axis] as SizeMode;
  if (main === axis || ctx.parent === "none") return "hug";
  if (main) {
    const self =
      ctx.alignSelf === "auto" || ctx.alignSelf === "normal" ? ctx.parentAlign : ctx.alignSelf;
    return STRETCHES.has(self || "normal") ? "fill" : "hug";
  }
  // Block and grid children fill their width; inline ones, and every height, hug.
  return axis === "width" && !ctx.display.startsWith("inline") ? "fill" : "hug";
}

/**
 * The styles that size `axis` as `mode`. Fixed is `current`, in pixels;
 * Hug is `fit-content`; Fill is `flex: 1 1 0` along a flex parent's main
 * axis, `align-self: stretch` across it, and `100%` anywhere else. Leaving
 * Fill takes off what made it fill. Along a flex parent's main axis, Fixed
 * and Hug also set `flex-shrink: 0`, so the size holds when room runs short.
 */
export function sizeModeStyles(
  axis: Axis,
  mode: SizeMode,
  styles: Readonly<Record<string, string>>,
  ctx: SizeContext,
  current: number,
): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  const main = mainAxis(ctx.parent);
  const drop = (...props: string[]) => {
    for (const p of props) if (styles[p] !== undefined) out[p] = null;
  };
  if (mode === "fill") {
    // A size the bridge measured holding it (Hug or Fixed) has to come off for it to fill.
    if (ctx.sized && ctx.sized[axis] !== "auto") out[axis] = null;
    if (main === axis) {
      out.flex = "1 1 0";
      drop("flex-grow", "flex-shrink", "flex-basis", axis);
    } else if (main) {
      out["align-self"] = "stretch";
      drop(axis);
    } else out[axis] = "100%";
    return out;
  }
  if (main === axis) {
    const own = styles.flex !== undefined || styles["flex-grow"] !== undefined;
    drop("flex", "flex-grow", "flex-basis");
    // A class or stylesheet makes it grow: `flex-1` has to come off, or its 0 basis beats the
    // size, and only a 0 stops a growth this can't see.
    if (!own && ctx.grow > 0) {
      out.flex = null;
      out["flex-grow"] = "0";
    }
    // A fixed or hugging size holds when the line runs short of room, as in a design tool.
    if (styles["flex-shrink"]?.trim() !== "0") out["flex-shrink"] = "0";
  } else if (main && styles["align-self"]?.trim() === "stretch") out["align-self"] = null;
  out[axis] = mode === "hug" ? "fit-content" : `${Math.round(current)}px`;
  return out;
}

/** What the mode choice says, in order. */
export const SIZE_MODES: ReadonlyArray<readonly [SizeMode, string]> = [
  ["fixed", "Fixed"],
  ["hug", "Hug"],
  ["fill", "Fill"],
];

const NUMBER = /^-?\d*\.?\d+$/;

/**
 * A `flex` shorthand as its grow, shrink and basis, the way the browser
 * expands it: `1` is `1 1 0%`, `none` is `0 0 auto`. `null` when it isn't
 * one the fields can take apart, like a `var()`.
 */
export function flexParts(flex: string): [string, string, string] | null {
  const v = flex.trim();
  if (v === "none") return ["0", "0", "auto"];
  if (v === "auto") return ["1", "1", "auto"];
  if (v === "initial") return ["0", "1", "auto"];
  if (v.includes("var(")) return null;
  const all = parts(v);
  if (all.length === 0 || all.length > 3) return null;
  const numbers = all.filter((p) => NUMBER.test(p));
  const basis = all.filter((p) => !NUMBER.test(p));
  if (all.length === 3 && numbers.length === 3) return [numbers[0]!, numbers[1]!, numbers[2]!];
  if (basis.length > 1 || numbers.length > 2) return null;
  // A basis comes first or last, never between the two numbers.
  if (basis.length === 1 && numbers.length === 2 && all[1] === basis[0]) return null;
  const [grow = "1", shrink = "1"] = numbers;
  return [grow, shrink, basis[0] ?? (numbers.length > 0 ? "0%" : "auto")];
}

/** Which part of `flex` a longhand is. */
export const FLEX_PARTS = ["flex-grow", "flex-shrink", "flex-basis"] as const;

/** Inline properties the Size section reads and writes, shorthands included. */
export const SIZE_PROPS = [
  "width",
  "height",
  "min-width",
  "max-width",
  "min-height",
  "max-height",
  "aspect-ratio",
  "overflow",
  "overflow-x",
  "overflow-y",
  "flex",
  ...FLEX_PARTS,
] as const;

/** An `aspect-ratio` as width over height: `16 / 9` is 1.78; `null` for `auto` or a `var()`. */
export function ratioOf(raw: string): number | null {
  const m = raw.trim().match(/^(?:auto\s+)?(\d*\.?\d+)(?:\s*\/\s*(\d*\.?\d+))?(?:\s+auto)?$/);
  if (!m) return null;
  const r = parseFloat(m[1]!) / (m[2] === undefined ? 1 : parseFloat(m[2]));
  return Number.isFinite(r) && r > 0 ? r : null;
}
