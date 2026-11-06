/** A number with its unit, like `12px` or `-0.5em`; `null` for anything else. */
export function numberOf(text: string): { value: number; unit: string } | null {
  const m = text.trim().match(/^(-?\d*\.?\d+)([a-z%]*)$/i);
  return m ? { value: parseFloat(m[1]!), unit: m[2]! } : null;
}

/** `n` without float noise: 0.1 + 0.2 shows as 0.3. */
export const tidy = (n: number) => String(Math.round(n * 1000) / 1000);

/** How far the pointer travels to move a scrubbed number one step; a step a pixel was too fast to aim. */
export const PX_PER_STEP = 4;

/** Where a number can go: `n` held to `min` and `max`, where they're given. */
export function clamp(n: number, min?: number, max?: number): number {
  if (min !== undefined && n < min) return min;
  if (max !== undefined && n > max) return max;
  return n;
}

/**
 * The value `travel` pixels from `start`: each `PX_PER_STEP` is a `step`,
 * ten times that with Shift, a tenth with Alt. It's cut off from `start`, not
 * from the last value, so dragging back from the limit answers at once.
 */
export function scrubbed(
  start: number,
  travel: number,
  { step = 1, shift = false, fine = false, min, max }: ScrubLimits,
): number {
  const by = shift ? 10 : fine ? 0.1 : 1;
  return clamp(start + Math.round(travel / PX_PER_STEP) * step * by, min, max);
}

export interface ScrubLimits {
  /** What one step moves the number. */
  step?: number;
  shift?: boolean;
  /** Alt is held: a tenth of a step, for a number that has decimals. */
  fine?: boolean;
  min?: number | undefined;
  max?: number | undefined;
}

/** Typed text with its number held to `min` and `max`; anything that isn't a number stays as it is. */
export function clampedText(text: string, min?: number, max?: number): string {
  const n = numberOf(text);
  if (!n) return text;
  const value = clamp(n.value, min, max);
  return value === n.value ? text : `${tidy(value)}${n.unit}`;
}

/** The text after an arrow key steps its number by `by`, held to `min` and `max`. */
export function steppedText(
  n: { value: number; unit: string },
  by: number,
  min?: number,
  max?: number,
): string {
  return `${tidy(clamp(n.value + by, min, max))}${n.unit}`;
}
