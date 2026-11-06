import { parts } from "./lists";
import { roundTo } from "./units";

/** One `box-shadow` or `text-shadow` entry, taken apart. Lengths keep their units. */
export interface Shadow {
  readonly inset: boolean;
  readonly x: string;
  readonly y: string;
  readonly blur: string;
  readonly spread: string;
  readonly color: string;
}

/** A single shadow as its parts, or `null` for a list, `none` or anything the fields can't show. */
export function parseShadow(value: string): Shadow | null {
  if (value.includes(",") && !/\(.*,.*\)/.test(value)) return null;
  const all = parts(value);
  if (all.some((p) => p.endsWith(","))) return null;
  const inset = all.includes("inset");
  const lengths = all.filter((p) => /^-?\d*\.?\d+[a-z]*$/i.test(p));
  const rest = all.filter((p) => p !== "inset" && !lengths.includes(p));
  if (lengths.length < 2 || lengths.length > 4 || rest.length > 1) return null;
  const [x, y, blur = "0", spread = "0"] = lengths as [string, string, ...string[]];
  return { inset, x, y, blur, spread, color: rest[0] ?? "currentcolor" };
}

/** A shadow as CSS. A text shadow has no spread and no inset. */
export function shadowText(s: Shadow, text = false): string {
  return text
    ? [s.x, s.y, s.blur, s.color].join(" ")
    : [s.inset ? "inset" : "", s.x, s.y, s.blur, s.spread, s.color].filter(Boolean).join(" ");
}

/** What a filter function does, as a designer names it, and the unit its amount shows in. */
export const FILTERS: Readonly<Record<string, { readonly name: string; readonly unit: string }>> = {
  blur: { name: "Layer blur", unit: "px" },
  brightness: { name: "Brightness", unit: "%" },
  contrast: { name: "Contrast", unit: "%" },
  saturate: { name: "Saturation", unit: "%" },
  grayscale: { name: "Grayscale", unit: "%" },
  "hue-rotate": { name: "Hue", unit: "deg" },
  invert: { name: "Invert", unit: "%" },
  sepia: { name: "Sepia", unit: "%" },
  opacity: { name: "Opacity", unit: "%" },
};

/** One filter entry, like `blur(4px)` or `brightness(1.2)`, as its function and amount. */
export interface Filter {
  readonly fn: string;
  /** In the function's unit: px for blur, degrees for hue, a percentage for the rest. */
  readonly amount: number;
}

/** A filter entry as its function and amount; `null` for `url()`, `drop-shadow()` or a `calc()`. */
export function parseFilter(entry: string): Filter | null {
  const m = entry.trim().match(/^([\w-]+)\(\s*(-?\d*\.?\d+)([a-z%]*)\s*\)$/i);
  if (!m) return null;
  const fn = m[1]!.toLowerCase();
  const info = FILTERS[fn];
  if (!info) return null;
  const n = Number(m[2]);
  const unit = m[3]!.toLowerCase();
  if (info.unit === "%")
    return unit === "%" || unit === "" ? { fn, amount: unit ? n : n * 100 } : null;
  if (info.unit === "deg") {
    const turns: Record<string, number> = { deg: 1, "": 1, turn: 360, rad: 180 / Math.PI };
    const k = turns[unit];
    return k === undefined ? null : { fn, amount: roundTo(n * k, 2) };
  }
  return unit === "px" || (unit === "" && n === 0) ? { fn, amount: n } : null;
}

export function filterText({ fn, amount }: Filter): string {
  return `${fn}(${amount}${FILTERS[fn]?.unit ?? ""})`;
}

/** The lists the Effects section shows, top first. */
export const EFFECT_PROPS = ["box-shadow", "text-shadow", "filter", "backdrop-filter"] as const;
export type EffectProp = (typeof EFFECT_PROPS)[number];

/** What a row in Effects is, by the list it's in and its entry. */
export function effectName(prop: EffectProp, entry: Shadow | Filter | null, css: string): string {
  if (prop === "backdrop-filter")
    return css.startsWith("blur(") ? "Background blur" : "Background filter";
  if (prop === "text-shadow") return "Text shadow";
  if (prop === "box-shadow")
    return entry && "inset" in entry && entry.inset ? "Inner shadow" : "Drop shadow";
  if (entry && "fn" in entry) return FILTERS[entry.fn]?.name ?? "Filter";
  return css.startsWith("drop-shadow(") ? "Filter shadow" : "Filter";
}
