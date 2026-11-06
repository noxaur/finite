/** `n` rounded to `places` decimals, so 0.1 + 0.2 reads as 0.3. */
export const roundTo = (n: number, places: number) => {
  const k = 10 ** places;
  return Math.round(n * k) / k;
};

/** Degrees in one of each angle unit. */
export const DEGREES_PER = { deg: 1, turn: 360, rad: 180 / Math.PI, grad: 0.9 } as const;

/** An angle in degrees: `45deg`, `0.25turn`, `1rad`, `50grad` or `0`. */
export function parseAngle(v: string): number | null {
  const m = v.trim().match(/^(-?\d*\.?\d+)(deg|turn|rad|grad)?$/i);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2]?.toLowerCase() as keyof typeof DEGREES_PER | undefined;
  if (unit === undefined) return n === 0 ? 0 : null;
  return roundTo(n * DEGREES_PER[unit], 4);
}
