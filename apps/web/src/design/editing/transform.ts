import { tokenOf } from "./inspect";
import { commas, parts } from "./lists";

/**
 * A layer's transform as the Transform section shows it. The browser
 * applies `translate`, `rotate` and `scale`, then `transform`, so this is
 * that order: a move, a turn, a scale (negative to flip) and a skew.
 */
export interface Transform {
  /** Lengths, with their units: `10px`, `50%`, or `0`. */
  readonly x: string;
  readonly y: string;
  /** Degrees. */
  readonly rotate: number;
  /** Factors: 1 is 100%, -1 a flip. */
  readonly scaleX: number;
  readonly scaleY: number;
  /** Degrees. */
  readonly skewX: number;
  readonly skewY: number;
}

export const NO_TRANSFORM: Transform = {
  x: "0",
  y: "0",
  rotate: 0,
  scaleX: 1,
  scaleY: 1,
  skewX: 0,
  skewY: 0,
};

/** The styles a transform reads: the three individual properties and `transform`. */
export type TransformStyles = Readonly<
  Partial<Record<"translate" | "rotate" | "scale" | "transform", string>>
>;

const round = (n: number) => Math.round(n * 1e4) / 1e4;

/** A length, a percentage or a length token, as written; `null` for a `calc()` or a keyword. */
function length(v: string): string | null {
  if (tokenOf(v)) return v.trim();
  const m = v.trim().match(/^(-?\d*\.?\d+)([a-z%]*)$/i);
  if (!m) return null;
  return Number(m[1]) === 0 ? "0" : `${m[1]}${m[2]}`;
}

/** An angle in degrees: `45deg`, `0.25turn`, `1rad`, `50grad` or `0`. */
export function angle(v: string): number | null {
  const m = v.trim().match(/^(-?\d*\.?\d+)(deg|turn|rad|grad)?$/i);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2]?.toLowerCase();
  if (unit === undefined) return n === 0 ? 0 : null;
  const k = { deg: 1, turn: 360, rad: 180 / Math.PI, grad: 0.9 }[unit]!;
  return round(n * k);
}

/** A scale factor: `1.2` or `120%`. */
function factor(v: string): number | null {
  const m = v.trim().match(/^(-?\d*\.?\d+)(%?)$/);
  if (!m) return null;
  return round(m[2] ? Number(m[1]) / 100 : Number(m[1]));
}

/** `translate`: `10px`, `10px 20px` or `none`; `null` for a 3D move or a `calc()`. */
export function parseTranslate(v: string | undefined): [string, string] | null {
  const all = parts(v ?? "none");
  if (all.length === 0 || (all.length === 1 && all[0] === "none")) return ["0", "0"];
  if (all.length > 2) return null;
  const [x, y = "0"] = all.map(length);
  return x === null || y === null || x === undefined ? null : [x, y];
}

/** `scale`: `1.2`, `120%`, `-1 1` or `none`; `null` for a 3D scale. */
export function parseScale(v: string | undefined): [number, number] | null {
  const all = parts(v ?? "none");
  if (all.length === 0 || (all.length === 1 && all[0] === "none")) return [1, 1];
  if (all.length > 2) return null;
  const [x, y = x] = all.map(factor);
  return x === null || y === null || x === undefined || y === undefined ? null : [x, y];
}

/** `rotate`: `45deg` or `none`, in degrees; `null` for a turn about another axis. */
export function parseRotate(v: string | undefined): number | null {
  const all = parts(v ?? "none");
  if (all.length === 0 || (all.length === 1 && all[0] === "none")) return 0;
  if (all.length === 2 && /^z$/i.test(all[0]!)) return angle(all[1]!);
  return all.length === 1 ? angle(all[0]!) : null;
}

/** Where each function goes in translate, rotate, scale, skew order. */
const RANK: Readonly<Record<string, number>> = {
  translate: 0,
  translatex: 0,
  translatey: 0,
  rotate: 1,
  rotatez: 1,
  scale: 2,
  scalex: 2,
  scaley: 2,
  skew: 3,
  skewx: 3,
  skewy: 3,
};

/**
 * A `transform` as the parts the controls show, and which kinds it holds;
 * `null` when it holds anything else (a `matrix()`, a 3D function, a
 * `calc()`) or its functions are out of translate, rotate, scale, skew
 * order, which the individual properties can't say.
 */
export function parseTransform(
  v: string | undefined,
): { value: Transform; holds: ReadonlySet<number> } | null {
  const holds = new Set<number>();
  const out = { ...NO_TRANSFORM };
  const fns = parts(v ?? "none");
  if (fns.length === 1 && fns[0] === "none") return { value: out, holds };
  // What the browser computes for any 2D transform; a move and a scale with nothing between can be split out.
  const matrix = fns.length === 1 ? fns[0]!.match(/^matrix\(([^()]*)\)$/i) : null;
  if (matrix) {
    const [a, b, c, d, e, f, ...more] = commas(matrix[1]!).map(Number);
    if (more.length > 0 || [a, b, c, d, e, f].some((n) => n === undefined || !Number.isFinite(n))) {
      return null;
    }
    if (b !== 0 || c !== 0) return null;
    if (e !== 0 || f !== 0) holds.add(0);
    if (a !== 1 || d !== 1) holds.add(2);
    const px = (n: number) => (n === 0 ? "0" : `${round(n)}px`);
    return { value: { ...out, x: px(e!), y: px(f!), scaleX: round(a!), scaleY: round(d!) }, holds };
  }
  let last = -1;
  const seen = new Set<string>();
  for (const fn of fns) {
    const m = fn.match(/^([a-z]+)\((.*)\)$/is);
    if (!m) return null;
    const name = m[1]!.toLowerCase();
    const rank = RANK[name];
    // Each axis once, in order: two moves, or a scale after a skew, can't be split out.
    const axes = name.endsWith("x") || name.endsWith("y") ? [name] : [`${name}x`, `${name}y`];
    if (rank === undefined || rank < last || axes.some((a) => seen.has(a))) return null;
    for (const a of axes) seen.add(a);
    last = rank;
    holds.add(rank);
    const args = commas(m[2]!);
    if (args.length > 2 || args.some((a) => a === "")) return null;
    const [a = "", b] = args;
    switch (name) {
      case "translate":
      case "translatex":
      case "translatey": {
        const x = length(a);
        const y = b === undefined ? "0" : length(b);
        if (x === null || y === null) return null;
        if (name === "translatey") out.y = x;
        else Object.assign(out, name === "translatex" ? { x } : { x, y });
        break;
      }
      case "rotate":
      case "rotatez": {
        const deg = b === undefined ? angle(a) : null;
        if (deg === null) return null;
        out.rotate = deg;
        break;
      }
      case "scale":
      case "scalex":
      case "scaley": {
        const x = factor(a);
        const y = b === undefined ? x : factor(b);
        if (x === null || y === null) return null;
        if (name === "scalex") out.scaleX = x;
        else if (name === "scaley") out.scaleY = x;
        else Object.assign(out, { scaleX: x, scaleY: y });
        break;
      }
      default: {
        const x = angle(a);
        const y = b === undefined ? 0 : angle(b);
        if (x === null || y === null) return null;
        if (name === "skewy") out.skewY = x;
        else Object.assign(out, name === "skewx" ? { skewX: x } : { skewX: x, skewY: y });
      }
    }
  }
  return { value: out, holds };
}

/** Two lengths added, when they share a unit or one is 0. */
function add(a: string, b: string): string | null {
  if (a === "0") return b;
  if (b === "0") return a;
  const [m, n] = [a, b].map((v) => v.match(/^(-?\d*\.?\d+)([a-z%]*)$/i));
  if (!m || !n || m[2] !== n[2]) return null;
  return length(`${round(Number(m[1]) + Number(n[1]))}${m[2]}`);
}

/**
 * What the controls show for `styles`: the individual properties with a
 * `transform` folded into them where that's the same picture. `custom` is
 * set when they can't say it: then the section shows a Custom row, and the
 * fields edit only the individual properties.
 */
export function readTransform(styles: TransformStyles): {
  value: Transform | null;
  custom: boolean;
} {
  const t = parseTranslate(styles.translate);
  const r = parseRotate(styles.rotate);
  const s = parseScale(styles.scale);
  if (!t || r === null || !s) return { value: null, custom: true };
  const own: Transform = {
    ...NO_TRANSFORM,
    x: t[0],
    y: t[1],
    rotate: r,
    scaleX: s[0],
    scaleY: s[1],
  };
  const parsed = parseTransform(styles.transform);
  if (!parsed) return { value: own, custom: true };
  const { value: tf, holds } = parsed;
  // `transform` comes after the individual properties: a move in it can
  // join `translate` only when no turn or scale comes between them.
  const turned = own.rotate !== 0;
  const scaled = own.scaleX !== 1 || own.scaleY !== 1;
  if ((holds.has(0) && (turned || scaled)) || (holds.has(1) && scaled)) {
    return { value: own, custom: true };
  }
  const x = add(own.x, tf.x);
  const y = add(own.y, tf.y);
  if (x === null || y === null) return { value: own, custom: true };
  return {
    value: {
      x,
      y,
      rotate: round(own.rotate + tf.rotate),
      scaleX: round(own.scaleX * tf.scaleX),
      scaleY: round(own.scaleY * tf.scaleY),
      skewX: tf.skewX,
      skewY: tf.skewY,
    },
    custom: false,
  };
}

const deg = (n: number) => `${round(n)}deg`;

/** `styles` with what a class or the browser sets filled in where the element sets nothing inline. */
export function withSheet(styles: TransformStyles, sheet: TransformStyles): TransformStyles {
  const out: Partial<Record<keyof TransformStyles, string>> = {};
  for (const prop of ["translate", "rotate", "scale", "transform"] as const) {
    const v = styles[prop] ?? sheet[prop];
    if (v !== undefined) out[prop] = v;
  }
  return out;
}

/**
 * The styles that give an element with `styles` the transform `next`:
 * `translate`, `rotate` and `scale`, and `transform` for a skew only. A
 * `transform` that held a move, a turn or a scale gives them to the
 * individual properties in the same edit. `sheet` is what classes set
 * where the element sets nothing inline, so a reset covers it with `none`.
 * A `transform` the controls can't say is left as it is, inline or from a
 * class, so an edit never covers what the section didn't show.
 */
export function transformStyles(
  styles: TransformStyles,
  next: Transform,
  sheet: TransformStyles = {},
): Record<string, string | null> {
  const want: Record<"translate" | "rotate" | "scale" | "transform", string | null> = {
    translate:
      next.x === "0" && next.y === "0" ? null : next.y === "0" ? next.x : `${next.x} ${next.y}`,
    rotate: next.rotate === 0 ? null : deg(next.rotate),
    scale:
      next.scaleX === 1 && next.scaleY === 1
        ? null
        : next.scaleX === next.scaleY
          ? `${round(next.scaleX)}`
          : `${round(next.scaleX)} ${round(next.scaleY)}`,
    transform:
      next.skewX === 0 && next.skewY === 0
        ? null
        : next.skewY === 0
          ? `skewX(${deg(next.skewX)})`
          : next.skewX === 0
            ? `skewY(${deg(next.skewY)})`
            : `skew(${deg(next.skewX)}, ${deg(next.skewY)})`,
  };
  const out: Record<string, string | null> = {};
  // A `transform` the controls can't say stays as it is.
  const keep = readTransform(withSheet(styles, sheet)).custom;
  for (const [prop, value] of Object.entries(want) as Array<[keyof typeof want, string | null]>) {
    if (prop === "transform" && keep) continue;
    const own = styles[prop];
    const drawn = own === undefined ? sheet[prop] : undefined;
    const v = value ?? (drawn !== undefined && drawn !== "none" ? "none" : null);
    if (v !== (own ?? null)) out[prop] = v;
  }
  return out;
}

/** The rotation `styles` draw, in degrees, through `rotate` or a `transform` folded into it; `null` when the controls can't say. */
export function rotationOf(styles: TransformStyles): number | null {
  const { value, custom } = readTransform(styles);
  return value && !custom ? value.rotate : (parseRotate(styles.rotate) ?? null);
}

/** The styles that turn an element to `degrees`, keeping the rest of its transform. */
export function withRotation(
  styles: TransformStyles,
  degrees: number,
  sheet: TransformStyles = {},
): Record<string, string | null> {
  const { value, custom } = readTransform(withSheet(styles, sheet));
  if (!value || custom) return { rotate: degrees === 0 ? null : deg(degrees) };
  return transformStyles(styles, { ...value, rotate: degrees }, sheet);
}

/** A rotation `by` degrees on from `degrees`, kept within -180 to 180: a quarter turn on from 135 is -135. */
export function turned(degrees: number, by: number): number {
  const n = (((degrees + by) % 360) + 360) % 360;
  return round(n > 180 ? n - 360 : n);
}

/** Whether a `scale` only mirrors, each axis at 1 or -1, like a flip; `none` is one too. */
export function isFlip(scale: string | undefined): boolean {
  const s = parseScale(scale);
  return s !== null && Math.abs(s[0]) === 1 && Math.abs(s[1]) === 1;
}

/** Whether `styles` draw the element mirrored along x and y; `null` when the controls can't say. */
export function flipsOf(styles: TransformStyles): { x: boolean; y: boolean } | null {
  const { value } = readTransform(styles);
  return value ? { x: value.scaleX < 0, y: value.scaleY < 0 } : null;
}

/** The styles that mirror an element along `axis`, keeping the rest of its transform. */
export function flipStyles(
  styles: TransformStyles,
  axis: "x" | "y",
  sheet: TransformStyles = {},
): Record<string, string | null> {
  const { value } = readTransform(withSheet(styles, sheet));
  if (!value) return {};
  const next =
    axis === "x" ? { ...value, scaleX: -value.scaleX } : { ...value, scaleY: -value.scaleY };
  return transformStyles(styles, next, sheet);
}

const X = ["left", "center", "right"] as const;
const Y = ["top", "center", "bottom"] as const;

/** Where one `transform-origin` part sits along its axis, and which axis it must be: `left` is x. */
function originPart(p: string): { at: number; axis: "x" | "y" | null } | null {
  const i = { "0%": 0, "50%": 1, "100%": 2, center: 1 }[p];
  if (i !== undefined) return { at: i, axis: null };
  if ((X as readonly string[]).includes(p))
    return { at: X.indexOf(p as (typeof X)[number]), axis: "x" };
  if ((Y as readonly string[]).includes(p))
    return { at: Y.indexOf(p as (typeof Y)[number]), axis: "y" };
  return null;
}

/** Which cell of a 3×3 grid `transform-origin` names, or `null` when it's off the grid. */
export function originCell(v: string | undefined): { x: number; y: number } | null {
  const all = parts(v ?? "");
  // A third part is the depth, which the grid leaves at 0.
  if (all.length === 3 && /^0(px)?$/.test(all[2]!)) all.pop();
  if (all.length === 0) return { x: 1, y: 1 };
  if (all.length > 2) return null;
  const [a, b] = all.map(originPart);
  if (!a || b === null) return null;
  if (b === undefined) return a.axis === "y" ? { x: 1, y: a.at } : { x: a.at, y: 1 };
  // Keywords may come either way round, `top left`; numbers are x then y.
  const [x, y] = a.axis === "y" || b.axis === "x" ? [b, a] : [a, b];
  if (x.axis === "y" || y.axis === "x") return null;
  return { x: x.at, y: y.at };
}

/** `transform-origin` for cell (`x`, `y`): `left top`, `center`, `right bottom`. */
export function originValue(x: number, y: number): string {
  return x === 1 && y === 1 ? "center" : `${X[x]} ${Y[y]}`;
}

/**
 * The styles that take off what makes `styles` a Custom transform: an
 * individual property the controls can't read, and a `transform` they
 * can't fold in. One set by a class is covered with `none`.
 */
export function transformResets(
  styles: TransformStyles,
  sheet: TransformStyles = {},
): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  const off = (prop: keyof TransformStyles) => {
    if (styles[prop] !== undefined) {
      out[prop] = null;
      // Taking it off shows what a class sets, so cover that too when the controls can't read it.
      if (prop !== "transform" && sheet[prop] !== undefined && !readable(prop, sheet[prop])) {
        out[prop] = "none";
      }
    } else if (sheet[prop] !== undefined) out[prop] = "none";
  };
  const value = (prop: "translate" | "rotate" | "scale") => styles[prop] ?? sheet[prop];
  for (const prop of ["translate", "rotate", "scale"] as const) {
    if (!readable(prop, value(prop))) off(prop);
  }
  const rest = {
    ...withSheet(styles, sheet),
    ...Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v === null ? undefined : v])),
  };
  if (readTransform(rest).custom) {
    if (styles.transform !== undefined) out.transform = null;
    if (sheet.transform !== undefined && sheet.transform !== "none") {
      // Taking the inline one off shows the class's, so cover it if the controls can't read that either.
      const under = { ...rest, transform: sheet.transform };
      if (styles.transform === undefined || readTransform(under).custom) out.transform = "none";
    }
  }
  return out;
}

function readable(prop: "translate" | "rotate" | "scale", v: string | undefined): boolean {
  if (prop === "translate") return parseTranslate(v) !== null;
  if (prop === "rotate") return parseRotate(v) !== null;
  return parseScale(v) !== null;
}
