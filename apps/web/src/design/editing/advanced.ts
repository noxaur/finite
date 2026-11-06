import { tokenOf } from "./inspect";
import { commas } from "./lists";

/** Inline properties a control in the inspector reads and writes, shorthands included. */
const CLAIMED = new Set([
  "display",
  "flex-direction",
  "flex-wrap",
  "justify-content",
  "align-items",
  "gap",
  "row-gap",
  "column-gap",
  "grid-template-columns",
  "width",
  "height",
  "left",
  "top",
  "right",
  "bottom",
  "inset",
  "position",
  "z-index",
  "rotate",
  "grid-template-rows",
  "flex",
  "flex-grow",
  "flex-shrink",
  "flex-basis",
  "align-self",
  "min-width",
  "max-width",
  "min-height",
  "max-height",
  "aspect-ratio",
  "overflow-x",
  "overflow-y",
  "overflow",
  "background",
  "background-color",
  "background-image",
  "background-size",
  "background-position",
  "background-repeat",
  "mix-blend-mode",
  "cursor",
  "box-shadow",
  "text-shadow",
  "filter",
  "backdrop-filter",
  "opacity",
  "font",
  "font-family",
  "font-size",
  "font-weight",
  "line-height",
  "letter-spacing",
  "text-align",
  "color",
  "font-style",
  "text-transform",
  "text-decoration",
  "text-decoration-line",
  "white-space",
  "text-overflow",
  "text-wrap",
  "line-clamp",
  "-webkit-line-clamp",
  "-webkit-box-orient",
  "translate",
  "scale",
  "rotate",
  "transform",
  "transform-origin",
  "transition",
]);

/** Whether a control shows `prop`, so Advanced leaves it out. */
export function isClaimed(prop: string): boolean {
  return (
    CLAIMED.has(prop) ||
    prop.startsWith("--finite-off-") ||
    /^(padding|margin)(-(top|right|bottom|left))?$/.test(prop) ||
    /^border(-(top|right|bottom|left))?(-(width|style|color))?$/.test(prop) ||
    /^border(-(top|bottom)-(left|right))?-radius$/.test(prop) ||
    /^outline(-(width|style|color|offset))?$/.test(prop)
  );
}

/** What some properties hold, said plainly. */
const SUMMARIES: Readonly<Record<string, (value: string) => string>> = {
  mask: (v) => layers(v),
  "mask-image": (v) => layers(v),
  "clip-path": (v) =>
    /^(inset|circle|ellipse|polygon|path|rect|xywh)\(/.test(v) ? "Shape" : word(v),
  transform: () => "Custom transform",
  transition: (v) => count(commas(v).length, "transition"),
  animation: (v) => count(commas(v).length, "animation"),
  "grid-template-areas": () => "Named areas",
  "grid-template-rows": (v) => count(v.split(/\s+(?![^(]*\))/).length, "row"),
  columns: (v) => `${v}`,
};

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
const layers = (v: string) => count(commas(v).length, "layer");
const word = (v: string) =>
  /^[a-z-]+$/i.test(v) ? v[0]!.toUpperCase() + v.slice(1).replace(/-/g, " ") : "Custom value";

/** `clip-path` → `Clip path`; a custom property keeps its name. */
export function propName(prop: string): string {
  if (prop.startsWith("--")) return prop;
  const name = prop.replace(/^-(webkit|moz)-/, "").replace(/-/g, " ");
  return name[0]!.toUpperCase() + name.slice(1);
}

/**
 * One line that says what `value` is without showing CSS: a token's name, a
 * number with its unit, a keyword, or a plain description.
 */
export function summary(prop: string, value: string): string {
  const v = value.trim();
  const token = tokenOf(v);
  if (token) return token;
  const known = SUMMARIES[prop];
  if (known) return known(v);
  if (/^-?\d*\.?\d+[a-z%]*(\s+-?\d*\.?\d+[a-z%]*)*$/i.test(v)) return v.replace(/(\d)px\b/g, "$1");
  return word(v);
}

/** The selection's inline declarations no control shows, as [property, value]. */
export function unclaimed(styles: Readonly<Record<string, string>>): Array<[string, string]> {
  return Object.entries(styles).filter(([prop]) => !isClaimed(prop));
}
