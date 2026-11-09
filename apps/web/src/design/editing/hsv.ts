/**
 * The color picker's math: a color as hue, saturation and value (HSV, also
 * called HSB), to and from `#rrggbb`, and hex typed with its alpha. Hue is
 * in degrees, 0 to 360; saturation and value from 0 to 1; alpha a
 * percentage, 0 to 100, as `alphaOf` reads it.
 */

export interface Hsv {
  readonly h: number;
  readonly s: number;
  readonly v: number;
}

type Rgb = readonly [number, number, number];

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** `#rgb` or `#rrggbb` (the `#` optional) as its three channels, 0 to 255; `null` for anything else. */
function rgbOf(hex: string): Rgb | null {
  const m = hex.trim().match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i)?.[1];
  if (!m) return null;
  const long = m.length === 3 ? m.replace(/./g, (c) => c + c) : m;
  return [0, 2, 4].map((i) => parseInt(long.slice(i, i + 2), 16)) as unknown as Rgb;
}

const hexOfRgb = (rgb: Rgb) =>
  `#${rgb
    .map((n) =>
      Math.round(clamp(n, 0, 255))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;

/**
 * `hex` as HSV. A gray has no hue and black no saturation either, so those
 * come from `keep`, the color the picker showed before: dragging to a corner
 * and back doesn't lose the hue. `null` when `hex` isn't `#rgb` or `#rrggbb`.
 */
export function hsvOf(hex: string, keep?: Hsv): Hsv | null {
  const rgb = rgbOf(hex);
  if (!rgb) return null;
  const [r, g, b] = rgb.map((n) => n / 255) as unknown as Rgb;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  const v = max;
  if (v === 0) return { h: keep?.h ?? 0, s: keep?.s ?? 0, v: 0 };
  const s = d / max;
  if (d === 0) return { h: keep?.h ?? 0, s, v };
  const h =
    max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: h * 60, s, v };
}

/** An HSV color as `#rrggbb`. */
export function hexOfHsv({ h, s, v }: Hsv): string {
  const hue = (((h % 360) + 360) % 360) / 60;
  const sat = clamp(s, 0, 1);
  const val = clamp(v, 0, 1);
  const channel = (n: number) => {
    const k = (n + hue) % 6;
    return val - val * sat * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return hexOfRgb([channel(5) * 255, channel(3) * 255, channel(1) * 255]);
}

/** The fully saturated, full-value color of hue `h`, as `#rrggbb`: what the area fades from. */
export const hueHex = (h: number): string => hexOfHsv({ h, s: 1, v: 1 });

/**
 * Hex as it's typed into the picker: 3, 4, 6 or 8 digits, the `#` optional,
 * as `#rrggbb` and its alpha percentage. 4 and 8 digits carry an alpha; 3 and
 * 6 leave it `null`, so the alpha the color had stays.
 */
export function parseHex(text: string): { hex: string; alpha: number | null } | null {
  const m = text.trim().match(/^#?([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i)?.[1];
  if (!m) return null;
  const long = (m.length <= 4 ? m.replace(/./g, (c) => c + c) : m).toLowerCase();
  const alpha = long.length === 8 ? Math.round(parseInt(long.slice(6), 16) / 2.55) : null;
  return { hex: `#${long.slice(0, 6)}`, alpha };
}

/** Whether `text` is typed as a hex, `#` first, so it's read as one or not at all. */
/** A bare hex as a person types it, with its `#`; anything else as it was. */
export function withHash(text: string): string {
  const value = text.trim();
  return /^[0-9a-f]+$/i.test(value) && [3, 4, 6, 8].includes(value.length) ? `#${value}` : text;
}

export const isHexLike = (text: string): boolean => /^\s*#/.test(text);

/**
 * Hex as it's being typed into a field: while typing (`done` false), only a
 * whole 6- or 8-digit hex, since `#1f3a` on the way to `#1f3a44` would read
 * as a short hex with 67% opacity; once it's done, on Enter or leaving, any
 * of 3, 4, 6 or 8 digits, as `parseHex` reads them.
 */
export function typedHex(text: string, done: boolean): ReturnType<typeof parseHex> {
  const digits = text.trim().replace(/^#/, "").length;
  return done || digits === 6 || digits === 8 ? parseHex(text) : null;
}
