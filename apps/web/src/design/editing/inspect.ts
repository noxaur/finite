import { parts } from "./lists";
import { FLEX_PARTS, flexParts } from "./sizing";
import { outlinePart } from "./stroke";
import type { Node } from "../schema";

/**
 * What one style field shows for the selection. Only inline styles are the
 * selection's own: an edit writes them, and only they keep `var(--token)`.
 * When none of the selection sets the property, the browser's value shows
 * faintly instead, and is never written back.
 */
export type Reading =
  /** Every node sets it to `raw`. `token` is the name when `raw` is a whole `var(--name)`. */
  | { readonly kind: "value"; readonly raw: string; readonly token: string | null }
  /** Nobody sets it; the browser draws `raw` (from classes, `<style>` blocks or defaults). */
  | { readonly kind: "computed"; readonly raw: string }
  /** Nobody sets it, and the browser can't say: a script artboard, or a hidden one. */
  | { readonly kind: "unset" }
  /** The nodes disagree. Typing a value sets it on all of them. */
  | { readonly kind: "mixed" };

/** `var(--surface)` → `--surface`. A fallback or anything around it shows as plain CSS. */
export function tokenOf(raw: string): string | null {
  return raw.match(/^\s*var\(\s*(--[\w-]+)\s*\)\s*$/)?.[1] ?? null;
}

/**
 * Reads `prop` across `nodes`' inline styles, or `computed`, the browser's
 * value on the first node, when none of them sets it.
 */
export function readStyle(
  nodes: ReadonlyArray<Pick<Node, "styles">>,
  prop: string,
  computed: string | null,
): Reading {
  const values = new Set(nodes.map((n) => ownStyle(n.styles, prop)));
  if (values.size > 1) return { kind: "mixed" };
  const [raw] = values;
  if (raw !== undefined) return { kind: "value", raw, token: tokenOf(raw) };
  return computed ? { kind: "computed", raw: computed } : { kind: "unset" };
}

/** Properties whose bare numbers mean pixels. */
const LENGTHS = new Set([
  "gap",
  "row-gap",
  "column-gap",
  "padding",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "border-width",
  "border-top-width",
  "border-right-width",
  "border-bottom-width",
  "border-left-width",
  "outline-width",
  "outline-offset",
  "border-radius",
  "border-top-left-radius",
  "border-top-right-radius",
  "border-bottom-right-radius",
  "border-bottom-left-radius",
  "font-size",
  "letter-spacing",
  "width",
  "height",
  "min-width",
  "max-width",
  "min-height",
  "max-height",
  "margin",
  "margin-top",
  "margin-right",
  "margin-bottom",
  "margin-left",
  "inset",
  "top",
  "right",
  "bottom",
  "left",
  "flex-basis",
]);

/**
 * What typing `text` into `prop`'s field sets: `null` (empty) takes the
 * inline style off, a bare number on a length gets `px`, and a token name
 * becomes `var(--name)`. Anything else is CSS as typed; the browser decides
 * what it means, as it does for agents' edits.
 */
export function parseInput(prop: string, text: string): string | null {
  const value = text.trim().replace(/;+$/, "");
  if (value === "") return null;
  if (/^--[\w-]+$/.test(value)) return `var(${value})`;
  if (prop === "grid-template-columns" && /^\d+$/.test(value)) {
    return `repeat(${value}, minmax(0, 1fr))`;
  }
  if (LENGTHS.has(prop) && /^-?\d*\.?\d+(\s+-?\d*\.?\d+)*$/.test(value)) {
    return value.replace(/-?\d*\.?\d+/g, (n) => `${n}px`);
  }
  return value;
}

/** What a value the fields can't show is, in plain words, by its outer function. */
const CUSTOM: ReadonlyArray<readonly [RegExp, string]> = [
  [/^calc\(/, "Calculated value"],
  [/^(min|max)\(/, "Calculated value"],
  [/^clamp\(/, "Clamped value: it grows and shrinks between limits"],
  [/^var\(/, "Token with a fallback"],
  [/^env\(/, "Value from the device"],
  [/^color-mix\(/, "Mixed color"],
  [/^(repeat|minmax)\(/, "Track list"],
  [/^(linear|radial|conic|repeating-[a-z]+)-gradient\(/, "Gradient"],
  [/^url\(/, "Image"],
];

/**
 * Why a field can't show `raw` as a number, a keyword or a token, in plain
 * words; `null` when it can. Such a value shows as a Custom chip, never as CSS.
 */
export function customOf(raw: string): string | null {
  const v = raw.trim();
  if (tokenOf(v) || !v.includes("(")) return null;
  return CUSTOM.find(([re]) => re.test(v))?.[1] ?? "Custom value";
}

/** A length as a field shows it: `12px` as `12`, `8px 16px` as `8 16`; other units stay. */
export function bare(raw: string): string {
  return raw.replace(/(\d)px\b/g, "$1");
}

/** `raw` as `prop`'s field shows it: without `px` where typing a bare number adds it back. */
export function shownAs(prop: string, raw: string): string {
  return LENGTHS.has(prop) ? bare(raw) : raw;
}

/** How a field shows a reading: the token's name, the value, or a placeholder. */
export function shown(reading: Reading): { text: string; placeholder: string } {
  switch (reading.kind) {
    case "value":
      return { text: reading.token ?? reading.raw, placeholder: "" };
    case "computed":
      return { text: "", placeholder: reading.raw };
    case "mixed":
      return { text: "", placeholder: "Mixed" };
    case "unset":
      return { text: "", placeholder: "" };
  }
}

const ALIGN = ["flex-start", "center", "flex-end"] as const;

/** Where `justify-content` and `align-items` put the children, as a column and row of a 3×3 grid. */
export function alignCell(
  kind: "row" | "column",
  justify: string,
  align: string,
): { x: number; y: number } | null {
  const at = (v: string) => {
    if (v === "start" || v === "left" || v === "normal" || v === "stretch" || v === "") return 0;
    const i = ALIGN.indexOf(v as (typeof ALIGN)[number]);
    return i === -1 ? (v === "end" || v === "right" ? 2 : -1) : i;
  };
  const main = at(justify);
  const cross = at(align);
  if (main === -1 || cross === -1) return null;
  return kind === "row" ? { x: main, y: cross } : { x: cross, y: main };
}

/** The styles that put children in cell (`x`, `y`) of the 3×3 align grid. */
export function alignStyles(kind: "row" | "column", x: number, y: number): Record<string, string> {
  const [main, cross] = kind === "row" ? [x, y] : [y, x];
  return { "justify-content": ALIGN[main]!, "align-items": ALIGN[cross]! };
}

const BORDER_STYLES = new Set([
  "none",
  "hidden",
  "dotted",
  "dashed",
  "solid",
  "double",
  "groove",
  "ridge",
  "inset",
  "outset",
]);

/** Which part of a `border` shorthand `part` is. A `var()` counts as the color. */
function borderPart(part: string): "border-width" | "border-style" | "border-color" {
  if (BORDER_STYLES.has(part)) return "border-style";
  if (/^(-?\d|\.|thin$|medium$|thick$|calc\()/.test(part)) return "border-width";
  return "border-color";
}

/** A `background` that is only a color, like `var(--surface)` or `#fff`. */
function backgroundColor(value: string): string | undefined {
  const all = parts(value);
  const [only] = all;
  if (all.length !== 1 || !only || /url\(|gradient\(|^(none|initial|inherit|unset)$/.test(only)) {
    return undefined;
  }
  return only;
}

/** The four sides of a box value, top first: `4px 8px` is 4, 8, 4, 8. */
export function sides(value: string): [string, string, string, string] {
  const [t = "", r = t, b = t, l = r] = parts(value);
  return [t, r, b, l];
}

/** The longhands each side of a box shorthand sets, top (or top left) first. */
const BOXES: Readonly<Record<string, readonly string[]>> = {
  "border-width": [
    "border-top-width",
    "border-right-width",
    "border-bottom-width",
    "border-left-width",
  ],
  "border-radius": [
    "border-top-left-radius",
    "border-top-right-radius",
    "border-bottom-right-radius",
    "border-bottom-left-radius",
  ],
  padding: ["padding-top", "padding-right", "padding-bottom", "padding-left"],
  margin: ["margin-top", "margin-right", "margin-bottom", "margin-left"],
  inset: ["top", "right", "bottom", "left"],
};

/** What a side left out of a box shorthand becomes. */
const UNSET_SIDE: Readonly<Record<string, string>> = { inset: "auto" };

/** `row-gap` and `column-gap` are the first and second parts of `gap`. */
const GAPS = ["row-gap", "column-gap"];

/** The box shorthand `prop` is one side of, and which side. */
function boxOf(prop: string): [string, number] | null {
  for (const [box, longs] of Object.entries(BOXES)) {
    const i = longs.indexOf(prop);
    if (i !== -1) return [box, i];
  }
  return null;
}

/**
 * The inline value of `prop`, or its part of an inline shorthand: the
 * `border-color` of `border: 1px solid red`, the `background-color` of
 * `background: var(--surface)`, or one side of `border-radius: 8px 4px`.
 */
export function ownStyle(
  styles: Readonly<Record<string, string>>,
  prop: string,
): string | undefined {
  const own = styles[prop];
  if (own !== undefined) return own;
  // One side's part of `border-bottom: 2px solid red`, or of `border-style: solid none`.
  const side = prop.match(/^border-(top|right|bottom|left)-(width|style|color)$/);
  if (side) {
    const short = styles[`border-${side[1]}`];
    if (short !== undefined) return parts(short).find((p) => borderPart(p) === `border-${side[2]}`);
    if (side[2] !== "width") {
      const whole = ownStyle(styles, `border-${side[2]}`);
      const i = ["top", "right", "bottom", "left"].indexOf(side[1]!);
      return whole === undefined ? undefined : sides(whole)[i];
    }
  }
  if (prop === "background-color" && styles.background !== undefined) {
    return backgroundColor(styles.background);
  }
  // One part of `outline: 2px solid red`.
  if (/^outline-(width|style|color)$/.test(prop) && styles.outline !== undefined) {
    return outlinePart(styles, prop);
  }
  const box = boxOf(prop);
  if (box) {
    const whole = ownStyle(styles, box[0]);
    return whole === undefined || whole.includes("/") ? undefined : sides(whole)[box[1]];
  }
  if (
    (prop === "border-color" || prop === "border-width" || prop === "border-style") &&
    styles.border !== undefined
  ) {
    return parts(styles.border).find((p) => borderPart(p) === prop);
  }
  const gap = GAPS.indexOf(prop);
  if (gap !== -1 && styles.gap !== undefined) {
    const [row, column = row] = parts(styles.gap);
    return gap === 0 ? row : column;
  }
  const flex = (FLEX_PARTS as readonly string[]).indexOf(prop);
  if (flex !== -1 && styles.flex !== undefined) return flexParts(styles.flex)?.[flex];
  return undefined;
}

/**
 * The styles to set on an element with `styles` so it gets `changes`. A
 * part of a shorthand the element sets inline is written into that
 * shorthand, so `border: 1px solid red` with a new color stays one
 * declaration and a later longhand can't lose to it. When it also sets
 * longhands of that shorthand, the change goes in as a longhand instead.
 */
export function routeStyles(
  styles: Readonly<Record<string, string>>,
  changes: Readonly<Record<string, string | null>>,
): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  const current = (prop: string) => (prop in out ? (out[prop] ?? undefined) : styles[prop]);
  for (const [prop, value] of Object.entries(changes)) {
    if (styles[prop] !== undefined) {
      out[prop] = value;
      continue;
    }
    const border = current("border");
    const bg = current("background");
    const side = prop.match(/^border-(top|right|bottom|left)-(width|style|color)$/);
    const sideShort = side ? current(`border-${side[1]}`) : undefined;
    if (
      side &&
      sideShort !== undefined &&
      !Object.keys(styles).some((k) => k.startsWith(`border-${side[1]}-`))
    ) {
      // `border-bottom: 2px solid red` takes a new bottom width as one declaration.
      const part = `border-${side[2]}` as keyof typeof ORDER;
      const kept = parts(sideShort).filter((p) => borderPart(p) !== part);
      const next =
        value === null
          ? kept
          : [...kept, value].sort((a, b) => ORDER[borderPart(a)] - ORDER[borderPart(b)]);
      out[`border-${side[1]}`] = next.length > 0 ? next.join(" ") : null;
      continue;
    }
    const box = boxOf(prop);
    const boxValue = box ? current(box[0]) : undefined;
    const gap = GAPS.indexOf(prop);
    const gapValue = current("gap");
    const flex = (FLEX_PARTS as readonly string[]).indexOf(prop);
    const flexValue = current("flex");
    const flexAll = flex !== -1 && flexValue !== undefined ? flexParts(flexValue) : null;
    if (
      (prop === "border-color" || prop === "border-width" || prop === "border-style") &&
      border !== undefined &&
      !Object.keys(styles).some(
        (k) => k !== "border" && k.startsWith("border-") && !k.includes("radius"),
      )
    ) {
      const kept = parts(border).filter((p) => borderPart(p) !== prop);
      const next =
        value === null
          ? kept
          : [...kept, value].sort((a, b) => ORDER[borderPart(a)] - ORDER[borderPart(b)]);
      out.border = next.length > 0 ? next.join(" ") : null;
    } else if (
      prop === "background-color" &&
      bg !== undefined &&
      backgroundColor(bg) !== undefined
    ) {
      out.background = value;
    } else if (box && boxValue !== undefined && !boxValue.includes("/")) {
      const all = sides(boxValue);
      all[box[1]] = value ?? UNSET_SIDE[box[0]] ?? "0";
      out[box[0]] = tidyBox(all);
    } else if (gap !== -1 && gapValue !== undefined && !GAPS.some((g) => styles[g] !== undefined)) {
      const [row = "normal", column = row] = parts(gapValue);
      const pair = gap === 0 ? [value ?? "normal", column] : [row, value ?? "normal"];
      out.gap = pair[0] === pair[1] ? pair[0]! : pair.join(" ");
    } else if (flexAll && !FLEX_PARTS.some((f) => styles[f] !== undefined)) {
      flexAll[flex] = value ?? ["0", "1", "auto"][flex]!;
      out.flex = flexAll.join(" ");
    } else out[prop] = value;
  }
  return out;
}

const ORDER = { "border-width": 0, "border-style": 1, "border-color": 2 } as const;

/** Four sides as the shortest box value that says them. */
function tidyBox([t, r, b, l]: readonly string[]): string {
  if (r === l) {
    if (t === b) return t === r ? t! : `${t} ${r}`;
    return `${t} ${r} ${b}`;
  }
  return `${t} ${r} ${b} ${l}`;
}
