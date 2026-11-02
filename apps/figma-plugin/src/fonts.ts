// Font styles and weights. The payload carries a numeric weight beside
// Figma's style name, so both directions need to turn one into the other.

export interface FontName {
  family: string;
  style: string;
}

/** Checked in order, so `extralight` wins over `light`, and `semibold` over `bold`. */
const WEIGHT_WORDS: ReadonlyArray<readonly [string, number]> = [
  ["extralight", 200],
  ["ultralight", 200],
  ["extrabold", 800],
  ["ultrabold", 800],
  ["semibold", 600],
  ["demibold", 600],
  ["thin", 100],
  ["hairline", 100],
  ["light", 300],
  ["medium", 500],
  ["bold", 700],
  ["black", 900],
  ["heavy", 900],
  ["regular", 400],
  ["normal", 400],
  ["book", 400],
];

const squash = (style: string) => style.toLowerCase().replace(/[\s_-]+/g, "");

/** The CSS weight a Figma style name stands for: `Thin` is 100, `Semi Bold Italic` 600, `Black` 900. */
export function weightOf(style: string): number {
  const s = squash(style);
  for (const [word, weight] of WEIGHT_WORDS) if (s.includes(word)) return weight;
  return 400;
}

export function isItalic(style: string): boolean {
  const s = squash(style);
  return s.includes("italic") || s.includes("oblique");
}

const STYLE_BY_WEIGHT: Readonly<Record<number, string>> = {
  100: "Thin",
  200: "Extra Light",
  300: "Light",
  400: "Regular",
  500: "Medium",
  600: "Semi Bold",
  700: "Bold",
  800: "Extra Bold",
  900: "Black",
};

/** A style name for a weight, rounded to the nearest hundred: `(600, true)` is `Semi Bold Italic`. */
export function styleOf(weight: number, italic: boolean): string {
  const hundreds = Math.min(9, Math.max(1, Math.round(weight / 100))) * 100;
  const name = STYLE_BY_WEIGHT[hundreds] ?? "Regular";
  if (!italic) return name;
  return name === "Regular" ? "Italic" : `${name} Italic`;
}

export interface WantedFont {
  family: string;
  /** Figma's style name, when the payload has one. */
  style?: string | undefined;
  weight: number;
  italic: boolean;
}

export interface PickedFont {
  font: FontName;
  /** `true` when `font` isn't what the payload asked for. */
  replaced: boolean;
}

export const FALLBACK: FontName = { family: "Inter", style: "Regular" };

/**
 * Chooses the installed font closest to `wanted`. An exact style wins, then
 * the same weight and slant under another spelling (`SemiBold` for
 * `Semi Bold`), then the nearest weight in the family. A family that isn't
 * installed falls back to Inter at the wanted weight, or Inter Regular.
 */
export function pickFont(wanted: WantedFont, available: readonly FontName[]): PickedFont {
  const family = available.filter((f) => f.family === wanted.family);
  if (wanted.style !== undefined) {
    const exact = family.find((f) => f.style === wanted.style);
    if (exact) return { font: exact, replaced: false };
  }
  const same = family.find(
    (f) => weightOf(f.style) === wanted.weight && isItalic(f.style) === wanted.italic,
  );
  if (same) return { font: same, replaced: false };
  const near = nearest(family, wanted);
  if (near) return { font: near, replaced: true };
  const inter = nearest(
    available.filter((f) => f.family === FALLBACK.family),
    wanted,
  );
  return { font: inter ?? FALLBACK, replaced: true };
}

/** The font whose weight is closest, preferring the same slant. */
function nearest(fonts: readonly FontName[], wanted: WantedFont): FontName | undefined {
  let best: FontName | undefined;
  let bestScore = Infinity;
  for (const font of fonts) {
    const slant = isItalic(font.style) === wanted.italic ? 0 : 1000;
    const score = slant + Math.abs(weightOf(font.style) - wanted.weight);
    if (score < bestScore) {
      best = font;
      bestScore = score;
    }
  }
  return best;
}
