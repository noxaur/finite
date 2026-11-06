import { alphaOf, setAlpha } from "./colors";
import { urlOf } from "./inspect";
import { commas, parts, readList, writeList } from "./lists";

/**
 * A layer's fill as the Fill section shows it. Gradient stops sit at a
 * percentage along the gradient; `auto` says none of them was placed in the
 * CSS, so they're written back without positions until one is moved.
 */
export type Fill =
  | { readonly type: "solid"; readonly color: string }
  | {
      readonly type: "linear";
      readonly angle: number;
      /** `to top right` and the like, kept as written until the angle changes. */
      readonly side: string | null;
      readonly stops: ReadonlyArray<Stop>;
      readonly auto: boolean;
      readonly repeating: boolean;
    }
  | {
      readonly type: "radial";
      readonly shape: "circle" | "ellipse";
      /** Its size, like `closest-side` or `40px`, kept as written. */
      readonly extent: string | null;
      /** Its center, as a CSS position. */
      readonly at: string;
      readonly stops: ReadonlyArray<Stop>;
      readonly auto: boolean;
      readonly repeating: boolean;
    }
  | {
      readonly type: "conic";
      readonly angle: number;
      readonly at: string;
      readonly stops: ReadonlyArray<Stop>;
      readonly auto: boolean;
      readonly repeating: boolean;
    }
  | { readonly type: "image"; readonly url: string }
  /** What the controls can't show, with why in plain words. */
  | { readonly type: "custom"; readonly css: string; readonly why: string };

export type FillType = Exclude<Fill["type"], "custom">;
export type Gradient = Extract<Fill, { stops: ReadonlyArray<Stop> }>;

/** One color stop: its color and where it sits, from 0 to 100. */
export interface Stop {
  readonly color: string;
  readonly at: number;
}

/** What a layer is, as a designer names it. */
export const FILL_NAMES: Readonly<Record<Fill["type"], string>> = {
  solid: "Solid",
  linear: "Linear gradient",
  radial: "Radial gradient",
  conic: "Conic gradient",
  image: "Image",
  custom: "Custom",
};

const SIDES: Readonly<Record<string, number>> = {
  top: 0,
  "top right": 45,
  right: 90,
  "bottom right": 135,
  bottom: 180,
  "bottom left": 225,
  left: 270,
  "top left": 315,
};

/** An angle in degrees, from `45deg`, `0.25turn`, `1rad` or `100grad`; `null` for anything else. */
function degrees(text: string): number | null {
  const m = text.trim().match(/^(-?\d*\.?\d+)(deg|turn|rad|grad)?$/i);
  if (!m || (!m[2] && Number(m[1]) !== 0)) return null;
  const n = Number(m[1]);
  const k = { deg: 1, turn: 360, rad: 180 / Math.PI, grad: 0.9 }[m[2]?.toLowerCase() ?? "deg"]!;
  return Math.round(n * k * 100) / 100;
}

/** `to top right` (either way round) as the side it names, or `null`. */
function sideOf(text: string): string | null {
  const words = text.trim().toLowerCase().split(/\s+/);
  if (words[0] !== "to") return null;
  const rest = words.slice(1);
  const y = rest.find((w) => w === "top" || w === "bottom");
  const x = rest.find((w) => w === "left" || w === "right");
  if (rest.length !== (x ? 1 : 0) + (y ? 1 : 0) || rest.length === 0) return null;
  return [y, x].filter(Boolean).join(" ");
}

/** A stop's position as a percentage; conic stops may be angles. */
function percent(text: string, conic: boolean): number | null {
  const m = text.trim().match(/^(-?\d*\.?\d+)(%?)$/);
  if (m && (m[2] || Number(m[1]) === 0)) return Number(m[1]);
  if (!conic) return null;
  const deg = degrees(text);
  return deg === null ? null : (deg / 360) * 100;
}

/** The stops of a gradient, with the unplaced ones spread between their neighbors. */
function stopsOf(
  args: ReadonlyArray<string>,
  conic: boolean,
): { stops: Stop[]; auto: boolean } | null {
  const raw: Array<{ color: string; at: number | null }> = [];
  for (const arg of args) {
    const [color, ...at] = parts(arg);
    // A lone position is a hint between stops, which the bar can't show.
    if (!color || at.length > 2 || percent(color, conic) !== null) return null;
    if (at.length === 0) raw.push({ color, at: null });
    for (const a of at) {
      const p = percent(a, conic);
      if (p === null) return null;
      raw.push({ color, at: p });
    }
  }
  if (raw.length < 2) return null;
  const auto = raw.every((s) => s.at === null);
  const at = raw.map((s) => s.at);
  at[0] ??= 0;
  at[at.length - 1] ??= 100;
  // CSS never lets a stop sit before the one ahead of it.
  for (let i = 1; i < at.length; i++) if (at[i] !== null) at[i] = Math.max(at[i]!, at[i - 1]!);
  for (let i = 1; i < at.length; i++) {
    if (at[i] !== null) continue;
    let j = i;
    while (at[j] === null) j++;
    const from = at[i - 1]!;
    const step = (at[j]! - from) / (j - i + 1);
    for (let k = i; k < j; k++) at[k] = from + step * (k - i + 1);
  }
  return {
    stops: raw.map((s, i) => ({ color: s.color, at: Math.round(at[i]! * 100) / 100 })),
    auto,
  };
}

const GRADIENT = /^(repeating-)?(linear|radial|conic)-gradient\((.*)\)$/is;

/** One `background-image` layer as a fill. A gradient from a color to itself is a solid. */
export function parseFill(css: string): Fill {
  const v = css.trim();
  if (/^url\(/i.test(v)) return { type: "image", url: urlOf(v) };
  const m = v.match(GRADIENT);
  if (!m) {
    return {
      type: "custom",
      css: v,
      why: v.startsWith("var(") ? "A fill from a token" : "Custom fill",
    };
  }
  const custom: Fill = { type: "custom", css: v, why: "A gradient the controls can't show" };
  const repeating = m[1] !== undefined;
  const kind = m[2]!.toLowerCase() as "linear" | "radial" | "conic";
  const args = commas(m[3]!);
  const first = args[0] ?? "";
  if (kind === "linear") {
    const side = sideOf(first);
    const angle = side !== null ? SIDES[side]! : degrees(first);
    const head = side !== null || angle !== null;
    const read = stopsOf(head ? args.slice(1) : args, false);
    if (!read) return custom;
    const [a, b] = read.stops;
    if (!head && !repeating && read.auto && read.stops.length === 2 && a!.color === b!.color) {
      return { type: "solid", color: a!.color };
    }
    return { type: "linear", angle: angle ?? 180, side, ...read, repeating };
  }
  if (kind === "radial") {
    const head = /^(circle|ellipse|closest-|farthest-|at\s|-?\d)/i.test(first);
    const read = stopsOf(head ? args.slice(1) : args, false);
    if (!read) return custom;
    const [shapeText = "", at = "center"] = head ? first.split(/\s*\bat\s+/i) : [];
    const words = parts(shapeText);
    const shape = words.includes("circle") ? "circle" : "ellipse";
    const rest = words.filter((w) => w !== "circle" && w !== "ellipse");
    return {
      type: "radial",
      shape,
      extent: rest.length > 0 ? rest.join(" ") : null,
      at: at.trim() || "center",
      ...read,
      repeating,
    };
  }
  const head = /^(from\s|at\s)/i.test(first);
  const read = stopsOf(head ? args.slice(1) : args, true);
  if (!read) return custom;
  const from = head ? first.match(/from\s+(\S+)/i)?.[1] : undefined;
  const angle = from === undefined ? 0 : degrees(from);
  if (angle === null) return custom;
  const at = head ? (first.match(/\bat\s+(.+)$/i)?.[1]?.trim() ?? "center") : "center";
  return { type: "conic", angle, at, ...read, repeating };
}

const round = (n: number) => Math.round(n * 10) / 10;

/** A fill as one `background-image` layer. A solid is a gradient from its color to itself. */
export function fillText(fill: Fill): string {
  switch (fill.type) {
    case "solid":
      return `linear-gradient(${fill.color}, ${fill.color})`;
    case "image":
      return `url(${JSON.stringify(fill.url)})`;
    case "custom":
      return fill.css;
  }
  const stops = fill.stops.map((s) => (fill.auto ? s.color : `${s.color} ${round(s.at)}%`));
  const head =
    fill.type === "linear"
      ? fill.side !== null
        ? `to ${fill.side}`
        : fill.angle === 180
          ? ""
          : `${round(fill.angle)}deg`
      : fill.type === "radial"
        ? [
            fill.shape === "circle" || fill.extent ? fill.shape : "",
            fill.extent ?? "",
            fill.at === "center" ? "" : `at ${fill.at}`,
          ]
            .filter(Boolean)
            .join(" ")
        : [
            fill.angle === 0 ? "" : `from ${round(fill.angle)}deg`,
            fill.at === "center" ? "" : `at ${fill.at}`,
          ]
            .filter(Boolean)
            .join(" ");
  const fn = `${fill.repeating ? "repeating-" : ""}${fill.type}-gradient`;
  return `${fn}(${[head, ...stops].filter(Boolean).join(", ")})`;
}

/** The fill of `type` that carries `color` over from the one before. */
export function newFill(type: FillType, color: string): Fill {
  const stops = [
    { color, at: 0 },
    { color: setAlpha(color, 0), at: 100 },
  ];
  const base = { stops, auto: true, repeating: false };
  switch (type) {
    case "solid":
      return { type, color };
    case "linear":
      return { type, angle: 180, side: null, ...base };
    case "radial":
      return { type, shape: "ellipse", extent: null, at: "center", ...base };
    case "conic":
      return { type, angle: 0, at: "center", ...base };
    case "image":
      return { type, url: "" };
  }
}

/** `fill` as a `type`: a gradient keeps its stops, and anything else carries its color over. */
export function switchFill(fill: Fill, type: FillType): Fill {
  if ("stops" in fill && type !== "solid" && type !== "image") {
    const fresh = newFill(type, fill.stops[0]!.color) as Gradient;
    return { ...fresh, stops: fill.stops, auto: fill.auto, repeating: fill.repeating };
  }
  const color =
    fill.type === "solid" ? fill.color : "stops" in fill ? fill.stops[0]!.color : "#d9d9d9";
  return newFill(type, color);
}

/** A gradient's opacity: its most opaque stop's. */
export function gradientAlpha(fill: Gradient): number {
  return Math.max(...fill.stops.map((s) => alphaOf(s.color)));
}

/** `fill` with every stop's opacity scaled so the most opaque is at `alpha`. */
export function withGradientAlpha(fill: Gradient, alpha: number): Gradient {
  const top = gradientAlpha(fill);
  return {
    ...fill,
    stops: fill.stops.map((s) => ({
      ...s,
      color: setAlpha(s.color, top === 0 ? alpha : (alphaOf(s.color) * alpha) / top),
    })),
  };
}

/** `fill` with its stops in place, sorted by where they sit; placing one writes every position. */
export function withStops(fill: Gradient, stops: ReadonlyArray<Stop>, placed = true): Gradient {
  return {
    ...fill,
    stops: [...stops].sort((a, b) => a.at - b.at),
    auto: fill.auto && !placed,
  };
}

/** The color a new stop at `at` takes: the nearest stop's before it, or the first's. */
export function colorAt(fill: Gradient, at: number): string {
  const before = fill.stops.filter((s) => s.at <= at);
  return (before[before.length - 1] ?? fill.stops[0])!.color;
}

/**
 * A gradient as the bar under its stops draws it, left to right, with each
 * stop's color through `paint` (which resolves tokens).
 */
export function barText(fill: Gradient, paint: (color: string) => string): string {
  return `linear-gradient(90deg, ${fill.stops.map((s) => `${paint(s.color)} ${round(s.at)}%`).join(", ")})`;
}

/** `fill` as a swatch draws it, its colors through `paint`. */
export function previewText(fill: Fill, paint: (color: string) => string): string {
  switch (fill.type) {
    case "solid":
      return paint(fill.color);
    case "custom":
      return "transparent";
    case "image":
      return fillText(fill);
    default:
      return fillText({ ...fill, stops: fill.stops.map((s) => ({ ...s, color: paint(s.color) })) });
  }
}

/** How an image fills its layer: Fill, Fit, Stretch or Tile. */
export type Fit = "fill" | "fit" | "stretch" | "tile";

export const FITS: Readonly<Record<Fit, { readonly size: string; readonly repeat: string }>> = {
  fill: { size: "cover", repeat: "no-repeat" },
  fit: { size: "contain", repeat: "no-repeat" },
  stretch: { size: "100% 100%", repeat: "no-repeat" },
  tile: { size: "auto", repeat: "repeat" },
};

/** Which fit a layer's `background-size` and `-repeat` make; `null` for another. */
export function fitOf(size: string, repeat: string): Fit | null {
  const s = size.trim().replace(/^auto auto$/, "auto");
  if (s === "cover") return "fill";
  if (s === "contain") return "fit";
  if (s === "100% 100%") return "stretch";
  return s === "auto" && /^repeat( repeat)?$/.test(repeat.trim()) ? "tile" : null;
}

const XS = ["left", "center", "right"] as const;
const YS = ["top", "center", "bottom"] as const;

/** Which cell of a 3×3 grid a CSS position names; `null` when it's between cells. */
export function cellOf(position: string): { x: number; y: number } | null {
  const words = parts(position.toLowerCase());
  const cell = (w: string): { axis: "x" | "y" | null; at: number } | null => {
    if (w === "left" || w === "right") return { axis: "x", at: w === "left" ? 0 : 2 };
    if (w === "top" || w === "bottom") return { axis: "y", at: w === "top" ? 0 : 2 };
    if (w === "center") return { axis: null, at: 1 };
    const n = { "0": 0, "0%": 0, "50%": 1, "100%": 2 }[w];
    return n === undefined ? null : { axis: null, at: n };
  };
  const read = words.map(cell);
  if (read.length === 0 || read.length > 2 || read.some((r) => r === null)) return null;
  const [a, b = { axis: null, at: 1 }] = read as Array<{ axis: "x" | "y" | null; at: number }>;
  const swap = a!.axis === "y" || b.axis === "x";
  const [x, y] = swap ? [b, a!] : [a!, b];
  if (x.axis === "y" || y.axis === "x") return null;
  return { x: x.at, y: y.at };
}

/** Cell (`x`, `y`) of a 3×3 grid as a CSS position, in the fewest words. */
export function cellPosition(x: number, y: number): string {
  if (x === 1 && y === 1) return "center";
  if (y === 1) return XS[x]!;
  if (x === 1) return YS[y]!;
  return `${XS[x]} ${YS[y]}`;
}

/** One row of the Fill list: its fill, whether the eye hides it, and how an image sits. */
export interface FillLayer {
  readonly fill: Fill;
  readonly hidden: boolean;
  readonly size: string;
  readonly position: string;
  readonly repeat: string;
}

/** An element's background as longhands, its layers' lists comma-separated. */
export interface Background {
  readonly image: string;
  readonly color: string;
  readonly size: string;
  readonly position: string;
  readonly repeat: string;
}

const DEFAULTS = { size: "auto", position: "0% 0%", repeat: "repeat" } as const;
const LAYER_PROPS = {
  size: "background-size",
  position: "background-position",
  repeat: "background-repeat",
} as const;

/** The stash that keeps a hidden bottom color, as the lists' stashes do. */
export const COLOR_STASH = "--finite-off-background-color";

const painted = (color: string) =>
  color !== "" && !/^(transparent|rgba\(0, 0, 0, 0\)|none)$/i.test(color.trim());

/**
 * The layers of a background, top first: each `background-image` entry
 * (hidden ones read back from the stash), then `background-color` at the
 * bottom when it paints. `styles` holds the stashes.
 */
export function readFills(styles: Readonly<Record<string, string>>, bg: Background): FillLayer[] {
  const at = (list: string, i: number) => {
    const all = commas(list);
    return all[i % all.length] ?? "";
  };
  const layers: FillLayer[] = readList(styles, "background-image", bg.image).flatMap((e, i) =>
    // A layer with no image, like a shorthand's color-only bottom one, paints nothing.
    e.css === "none"
      ? []
      : [
          {
            fill: parseFill(e.css),
            hidden: e.hidden,
            size: at(bg.size, i) || DEFAULTS.size,
            position: at(bg.position, i) || DEFAULTS.position,
            repeat: at(bg.repeat, i) || DEFAULTS.repeat,
          },
        ],
  );
  const stash = styles[COLOR_STASH];
  const hidden = !painted(bg.color) && stash !== undefined;
  if (painted(bg.color) || hidden) {
    layers.push({
      fill: { type: "solid", color: hidden ? stash! : bg.color },
      hidden,
      ...DEFAULTS,
    });
  }
  return layers;
}

/** A layer with `fill` and where an image sits by default. */
export function layerOf(fill: Fill): FillLayer {
  return {
    fill,
    hidden: false,
    ...(fill.type === "image" ? { ...DEFAULTS, ...FITS.fill, position: "center" } : DEFAULTS),
  };
}

const IMAGE_START = /^(url|image-set|(repeating-)?(linear|radial|conic)-gradient)\(|^none$/i;
const REPEATS = /^(repeat-x|repeat-y|repeat|space|round|no-repeat)$/i;
const BOXES = /^(border-box|padding-box|content-box|text)$/i;
const SIZE = /^(auto|cover|contain|-?\d*\.?\d+[a-z%]*|calc\(.*\))$/i;
const POSITION = /^(left|right|top|bottom|center|-?\d*\.?\d+[a-z%]*|calc\(.*\))$/i;

/** `value` split at spaces and at a `/` outside brackets, which stays as its own part. */
function words(value: string): string[] {
  let depth = 0;
  let out = "";
  for (const c of value) {
    if (c === "(") depth++;
    else if (c === ")") depth--;
    out += c === "/" && depth === 0 ? " / " : c;
  }
  return parts(out);
}

/**
 * A `background` shorthand as the longhands it sets, each layer's value in
 * a comma list; only the ones it names. `null` when a layer has a part
 * nothing here knows, so it's left alone.
 */
export function expandBackground(value: string): Record<string, string> | null {
  const layers = commas(value);
  const named = new Set<string>();
  const read = layers.map((layer) => {
    const out: Record<string, string> = {};
    const position: string[] = [];
    const size: string[] = [];
    const repeat: string[] = [];
    const boxes: string[] = [];
    let afterSlash = false;
    for (const w of words(layer)) {
      if (w === "/") afterSlash = true;
      else if (IMAGE_START.test(w)) out["background-image"] = w;
      else if (REPEATS.test(w)) repeat.push(w);
      else if (/^(scroll|fixed|local)$/i.test(w)) out["background-attachment"] = w;
      else if (BOXES.test(w)) boxes.push(w);
      else if (afterSlash && SIZE.test(w) && size.length < 2) size.push(w);
      else if (!afterSlash && POSITION.test(w) && position.length < 4) position.push(w);
      else if (out["background-color"] === undefined) out["background-color"] = w;
      else return null;
    }
    if (position.length > 0) out["background-position"] = position.join(" ");
    if (size.length > 0) out["background-size"] = size.join(" ");
    if (repeat.length > 0) out["background-repeat"] = repeat.join(" ");
    if (boxes[0]) out["background-origin"] = boxes[0];
    if (boxes[0] || boxes[1]) out["background-clip"] = boxes[1] ?? boxes[0]!;
    for (const k of Object.keys(out)) named.add(k);
    return out;
  });
  if (read.some((r) => r === null)) return null;
  const all = read as Array<Record<string, string>>;
  const initial: Record<string, string> = {
    "background-image": "none",
    "background-position": DEFAULTS.position,
    "background-size": DEFAULTS.size,
    "background-repeat": DEFAULTS.repeat,
    "background-attachment": "scroll",
    "background-origin": "padding-box",
    "background-clip": "border-box",
  };
  const out: Record<string, string> = {};
  for (const prop of named) {
    if (prop === "background-color") {
      // Only the bottom layer may have a color.
      const color = all[all.length - 1]!["background-color"];
      if (color === undefined || all.slice(0, -1).some((l) => l["background-color"])) return null;
      out[prop] = color;
    } else out[prop] = all.map((l) => l[prop] ?? initial[prop]!).join(", ");
  }
  return out;
}

/** The background an element sets inline: its `background` shorthand, under its longhands. */
export function ownBackground(styles: Readonly<Record<string, string>>): Record<string, string> {
  const short = styles.background === undefined ? {} : (expandBackground(styles.background) ?? {});
  const own: Record<string, string> = { ...short };
  for (const [k, v] of Object.entries(styles)) if (k.startsWith("background-")) own[k] = v;
  return own;
}

/** A background from what `get` reads for each longhand, the initial value where it reads none. */
export function backgroundOf(get: (prop: string) => string | undefined): Background {
  return {
    image: get("background-image") ?? "none",
    color: get("background-color") ?? "transparent",
    size: get(LAYER_PROPS.size) ?? DEFAULTS.size,
    position: get(LAYER_PROPS.position) ?? DEFAULTS.position,
    repeat: get(LAYER_PROPS.repeat) ?? DEFAULTS.repeat,
  };
}

/** What taking a property off does when nothing's left: `null`, or a value that covers a class's. */
export interface Empties {
  readonly image: string | null;
  readonly color: string | null;
}

/**
 * The styles that make an element with `styles` show `layers`, top first.
 * A solid at the bottom is `background-color`; every other layer is a
 * `background-image` entry, with hidden ones behind the eye's placeholder,
 * and `background-size`, `-position` and `-repeat` kept in step when an
 * image needs them. A `background` shorthand that can't hold the change
 * is expanded into the longhands it carried and taken off in the same edit.
 */
export function writeFills(
  styles: Readonly<Record<string, string>>,
  layers: ReadonlyArray<FillLayer>,
  empty: Empties = { image: null, color: null },
): Record<string, string | null> {
  const last = layers[layers.length - 1];
  const base = last?.fill.type === "solid" ? { color: last.fill.color, hidden: last.hidden } : null;
  const images = base ? layers.slice(0, -1) : layers;
  const short = styles.background;
  const expanded = short === undefined ? null : (expandBackground(short) ?? {});
  // What the shorthand sets counts as the element's own, under its longhands.
  const own: Record<string, string> = { ...expanded };
  for (const [k, v] of Object.entries(styles)) if (k !== "background") own[k] = v;

  const want: Record<string, string | null> = writeList(
    own,
    "background-image",
    images.map((l) => ({ css: fillText(l.fill), hidden: l.hidden })),
    empty.image,
  );
  for (const [part, prop] of Object.entries(LAYER_PROPS) as Array<
    [keyof typeof LAYER_PROPS, string]
  >) {
    const values = images.map((l) => (l.fill.type === "image" ? l[part] : DEFAULTS[part]));
    want[prop] = values.every((v) => v === DEFAULTS[part]) ? null : values.join(", ");
  }
  want["background-color"] = base ? (base.hidden ? "transparent" : base.color) : empty.color;
  want[COLOR_STASH] = base?.hidden ? base.color : null;

  const out: Record<string, string | null> = {};
  const onlyColor =
    expanded !== null &&
    Object.keys(expanded).length > 0 &&
    Object.keys(expanded).every((k) => k === "background-color");
  if (expanded !== null && !(onlyColor && images.length === 0)) {
    // The shorthand can't hold the change: it goes, and what it set stays as longhands.
    out.background = null;
    for (const [k, v] of Object.entries(expanded)) if (!(k in want)) out[k] = v;
  }
  for (const [k, v] of Object.entries(want)) {
    // Nothing to take off where the element set nothing; a color-only
    // shorthand that stays takes its new color through the router.
    const had =
      styles[k] !== undefined || (onlyColor && k === "background-color" && !("background" in out));
    if (v !== null || had) out[k] = v;
  }
  return out;
}
