import { commas, parts } from "./lists";

/**
 * A color taken apart into what it is and its opacity, so opacity can be
 * edited in place: a literal keeps its notation (`#rrggbbaa`,
 * `rgb(r g b / a)`, `hsl(… / a)`, `rgba(r, g, b, a)`), and anything else, a
 * token included, goes under `color-mix(in srgb, <color> N%, transparent)`,
 * so `var(--x)` keeps its name.
 */
type Parsed =
  | { readonly kind: "mix"; readonly base: string; readonly alpha: number }
  | { readonly kind: "hex"; readonly rgb: string; readonly alpha: number; readonly short: boolean }
  | {
      readonly kind: "fn";
      readonly name: string;
      readonly args: readonly string[];
      readonly comma: boolean;
      readonly alpha: number;
      /** Whether the alpha was written as a percentage. */
      readonly percent: boolean;
    }
  | { readonly kind: "other"; readonly base: string };

const FUNCTIONS = /^(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\((.*)\)$/is;

/** An alpha as typed in a color, `50%` or `0.5`, as a percentage; `null` when it isn't a number. */
function alphaNumber(text: string): { alpha: number; percent: boolean } | null {
  const m = text.trim().match(/^(\d*\.?\d+)(%?)$/);
  if (!m) return null;
  const n = Number(m[1]);
  return m[2] ? { alpha: n, percent: true } : { alpha: n * 100, percent: false };
}

function parse(value: string): Parsed {
  const v = value.trim();
  const mix = v.match(/^color-mix\(\s*in srgb\s*,\s*(.+?)\s+(\d*\.?\d+)%\s*,\s*transparent\s*\)$/i);
  if (mix) return { kind: "mix", base: mix[1]!, alpha: Number(mix[2]) };
  const hex = v.match(/^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i)?.[1];
  if (hex) {
    const short = hex.length <= 4;
    const long = short ? hex.replace(/./g, (c) => c + c) : hex;
    const a = long.length === 8 ? parseInt(long.slice(6), 16) / 2.55 : 100;
    return { kind: "hex", rgb: long.slice(0, 6).toLowerCase(), alpha: a, short };
  }
  const fn = v.match(FUNCTIONS);
  if (fn) {
    const name = fn[1]!.toLowerCase();
    const inner = fn[2]!;
    const byCommas = commas(inner);
    if (byCommas.length > 1) {
      const [r, g, b, a] = byCommas;
      const alpha = a === undefined ? { alpha: 100, percent: false } : alphaNumber(a);
      if (alpha && r && g && b) return { kind: "fn", name, args: [r, g, b], comma: true, ...alpha };
    } else {
      const [color = "", a] = inner.split("/");
      const alpha = a === undefined ? { alpha: 100, percent: true } : alphaNumber(a);
      if (alpha) return { kind: "fn", name, args: parts(color), comma: false, ...alpha };
    }
  }
  return { kind: "other", base: v };
}

const clamp = (alpha: number) => Math.min(100, Math.max(0, Math.round(alpha * 10) / 10));

/** A color's opacity, as a percentage from 0 to 100. */
export function alphaOf(value: string): number {
  const p = parse(value);
  return p.kind === "other" ? (/^transparent$/i.test(p.base) ? 0 : 100) : Math.round(p.alpha);
}

/** `value` at `alpha` percent opacity, in its own notation; at 100, the bare color. */
export function setAlpha(value: string, alpha: number): string {
  const a = clamp(alpha);
  const p = parse(value);
  switch (p.kind) {
    case "mix":
    case "other": {
      const base = p.base;
      return a >= 100 ? base : `color-mix(in srgb, ${base} ${a}%, transparent)`;
    }
    case "hex": {
      if (a >= 100) {
        const r = p.rgb;
        const shortens = p.short && r[0] === r[1] && r[2] === r[3] && r[4] === r[5];
        return `#${shortens ? `${r[0]}${r[2]}${r[4]}` : r}`;
      }
      return `#${p.rgb}${Math.round((a / 100) * 255)
        .toString(16)
        .padStart(2, "0")}`;
    }
    case "fn": {
      const amount = p.percent ? `${a}%` : String(Math.round(a * 10) / 1000);
      if (p.comma) {
        const name = p.name.replace(/a$/, "");
        return a >= 100
          ? `${name}(${p.args.join(", ")})`
          : `${name}a(${p.args.join(", ")}, ${amount})`;
      }
      return a >= 100
        ? `${p.name}(${p.args.join(" ")})`
        : `${p.name}(${p.args.join(" ")} / ${amount})`;
    }
  }
}

/** The color under its opacity: what the swatch's picker and the field's name show. */
export function opaque(value: string): string {
  return setAlpha(value, 100);
}

/**
 * A color as `#rrggbb`, for the picker and the field, its opacity
 * dropped; `null` when it can't be read without the browser.
 */
export function hexOf(color: string | undefined): string | null {
  if (!color) return null;
  const p = parse(color);
  if (p.kind === "hex") return `#${p.rgb}`;
  if (p.kind !== "fn" || (p.name !== "rgb" && p.name !== "rgba")) return null;
  const channels = p.args.map((c) => {
    const n = parseFloat(c);
    return c.trim().endsWith("%") ? (n / 100) * 255 : n;
  });
  if (channels.length !== 3 || channels.some((n) => !Number.isFinite(n))) return null;
  return `#${channels
    .map((n) =>
      Math.round(Math.min(255, Math.max(0, n)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

/** Whether a color mixes more than its own opacity, which the controls can't show. */
export function isOtherMix(value: string): boolean {
  return /^\s*color-mix\(/i.test(value) && parse(value).kind === "other";
}

/** `text` with each `var(--name)` in it replaced by what `lookup` says the token is. */
export function resolveVars(text: string, lookup: (name: string) => string | undefined): string {
  return text.replace(/var\(\s*(--[\w-]+)\s*(?:,[^()]*)?\)/g, (m, name: string) => {
    const value = lookup(name);
    return value === undefined ? m : resolveVars(value, lookup);
  });
}

let probe: CanvasRenderingContext2D | null | undefined;
const painted = new Map<string, string | null>();

/**
 * A color as `#rrggbb`, its opacity dropped, as the browser paints it:
 * for `hsl()`, `oklch()`, `lab()` or a mix of two colors, which only the
 * browser can read. `null` outside a browser, for a token it can't see,
 * or for what isn't a color.
 */
export function paintedHex(color: string | undefined): string | null {
  if (!color) return null;
  const fast = hexOf(color);
  if (fast || typeof document === "undefined" || /var\(/.test(color)) return fast;
  const seen = painted.get(color);
  if (seen !== undefined) return seen;
  probe ??= document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  let out: string | null = null;
  if (probe && typeof CSS !== "undefined" && CSS.supports("color", color)) {
    probe.clearRect(0, 0, 1, 1);
    probe.fillStyle = "#000000";
    probe.fillStyle = opaque(color);
    probe.fillRect(0, 0, 1, 1);
    const [r = 0, g = 0, b = 0] = probe.getImageData(0, 0, 1, 1).data;
    out = `#${[r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
  }
  painted.set(color, out);
  return out;
}
