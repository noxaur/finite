import { APPEARANCE_PROPS } from "./appearance";
import { EFFECT_PROPS } from "./effects";
import { FILL_PROPS } from "./fills";
import { tokenOf } from "./inspect";
import { LAYOUT_PROPS } from "./layout";
import { commas, parts, STASH_PREFIX } from "./lists";
import { isPlaced, POSITION_PROPS } from "./position";
import { flexParts, SIZE_PROPS } from "./sizing";
import { isFlip, TRANSFORM_PROPS } from "./transform";
import { TEXT_PROPS } from "./typography";

/**
 * Inline properties a control in the inspector reads and writes, shorthands
 * included. Each section's module lists its own, so a new control is
 * claimed where it's written.
 */
const CLAIMED: ReadonlySet<string> = new Set([
  ...LAYOUT_PROPS,
  ...SIZE_PROPS,
  ...POSITION_PROPS,
  ...TRANSFORM_PROPS,
  "transition",
  "background",
  ...FILL_PROPS,
  ...APPEARANCE_PROPS,
  ...EFFECT_PROPS,
  ...TEXT_PROPS,
  "color",
  "-webkit-box-orient",
]);

/**
 * Whether a control shows `prop`, so Advanced leaves it out. With its
 * `value`, only a value the controls can show is claimed, so nothing set
 * goes unseen: a grow or shrink of 0 or 1 is the W and H modes', a `flex: 2`
 * isn't; a `scale` that only mirrors is the flip buttons'; insets are the
 * position's only when `position` (inline or computed) places the element
 * by them.
 */
export function isClaimed(prop: string, value?: string, position?: string): boolean {
  const named =
    CLAIMED.has(prop) ||
    prop.startsWith(STASH_PREFIX) ||
    /^(padding|margin)(-(top|right|bottom|left))?$/.test(prop) ||
    /^border(-(top|right|bottom|left))?(-(width|style|color))?$/.test(prop) ||
    /^border(-(top|bottom)-(left|right))?-radius$/.test(prop) ||
    /^outline(-(width|style|color|offset))?$/.test(prop);
  if (!named || value === undefined) return named;
  return claimsValue(prop, value.trim(), position?.trim());
}

const UNIT = /^[01]$/;
const BASIS = /^(0|0%|0px|auto)$/;
const INSET_PROPS = new Set(["inset", "top", "right", "bottom", "left"]);

/** Whether the control for a claimed `prop` can show `value`. */
function claimsValue(prop: string, value: string, position: string | undefined): boolean {
  if (INSET_PROPS.has(prop)) return isPlaced(position);
  switch (prop) {
    case "flex": {
      const p = flexParts(value);
      return p !== null && UNIT.test(p[0]) && UNIT.test(p[1]) && BASIS.test(p[2]);
    }
    case "flex-grow":
    case "flex-shrink":
      return UNIT.test(value);
    case "flex-basis":
      return BASIS.test(value);
    case "align-self":
      return /^(stretch|auto|normal)$/.test(value);
    case "scale":
      return isFlip(value);
    default:
      return true;
  }
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
  "grid-template-rows": (v) => count(parts(v).length, "row"),
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

/**
 * The selection's inline declarations no control shows, as [property, value].
 * `position` is how the element is positioned, when a stylesheet sets it.
 */
export function unclaimed(
  styles: Readonly<Record<string, string>>,
  position: string | undefined = styles.position,
): Array<[string, string]> {
  return Object.entries(styles).filter(
    ([prop, value]) => !isClaimed(prop, value, styles.position ?? position),
  );
}
