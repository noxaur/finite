import { sides } from "./inspect";
import { parts } from "./lists";
import { roundTo } from "./units";

/** `opacity` as a percentage: `0.5` and `50%` are 50; `null` for a `calc()` or a token. */
export function opacityPercent(raw: string): number | null {
  const m = raw.trim().match(/^(\d*\.?\d+)(%?)$/);
  if (!m) return null;
  const n = Number(m[1]);
  return roundTo(m[2] ? n : n * 100, 1);
}

/** Inline properties the Appearance section reads and writes. */
export const APPEARANCE_PROPS = ["opacity", "mix-blend-mode", "cursor"] as const;

/** A percentage as `opacity` writes it, from 0 to 1. */
export function opacityValue(percent: number): string {
  return String(Math.round(Math.min(100, Math.max(0, percent)) * 10) / 1000);
}

const title = (v: string) => v[0]!.toUpperCase() + v.slice(1).replace(/-/g, " ");

/** `mix-blend-mode`'s choices, as [CSS, name]. */
export const BLENDS: ReadonlyArray<readonly [string, string]> = [
  "normal",
  "multiply",
  "screen",
  "overlay",
  "darken",
  "lighten",
  "color-dodge",
  "color-burn",
  "hard-light",
  "soft-light",
  "difference",
  "exclusion",
  "hue",
  "saturation",
  "color",
  "luminosity",
  "plus-lighter",
].map((v) => [v, title(v)] as const);

/** `cursor`'s choices, as [CSS, name]: what a person sees over the layer. */
export const CURSORS: ReadonlyArray<readonly [string, string]> = [
  ["auto", "Auto"],
  ["default", "Arrow"],
  ["pointer", "Hand"],
  ["text", "Text"],
  ["move", "Move"],
  ["grab", "Grab"],
  ["grabbing", "Grabbing"],
  ["crosshair", "Crosshair"],
  ["not-allowed", "Not allowed"],
  ["help", "Help"],
  ["wait", "Wait"],
  ["progress", "Progress"],
  ["zoom-in", "Zoom in"],
  ["zoom-out", "Zoom out"],
  ["ew-resize", "Resize left and right"],
  ["ns-resize", "Resize up and down"],
  ["none", "Hidden"],
];

/** Four corners' horizontal and vertical radii, top left first. */
export interface Ellipse {
  readonly h: readonly [string, string, string, string];
  readonly v: readonly [string, string, string, string];
}

/** An elliptical `border-radius`, like `10px / 20px`; `null` when it has no `/`. */
export function ellipseOf(value: string): Ellipse | null {
  const [h, v, ...rest] = value.split("/");
  if (v === undefined || rest.length > 0 || parts(h!).length === 0) return null;
  return { h: sides(h!), v: sides(v) };
}

/** Each corner's radius from its longhand, `h v` or one value for both. */
export function cornerOf(value: string): readonly [string, string] {
  const [h = "0", v = h] = parts(value);
  return [h, v];
}

/** An ellipse as one `border-radius`, each half in the fewest values. */
export function ellipseText({ h, v }: Ellipse): string {
  const tidy = ([t, r, b, l]: readonly string[]) =>
    r === l ? (t === b ? (t === r ? t! : `${t} ${r}`) : `${t} ${r} ${b}`) : `${t} ${r} ${b} ${l}`;
  return `${tidy(h)} / ${tidy(v)}`;
}
