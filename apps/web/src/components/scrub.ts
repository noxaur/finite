import { roundTo } from "../design/editing/units";

/** A number with its unit, like `12px` or `-0.5em`; `null` for anything else. */
export function numberOf(text: string): { value: number; unit: string } | null {
  const m = text.trim().match(/^(-?\d*\.?\d+)([a-z%]*)$/i);
  return m ? { value: parseFloat(m[1]!), unit: m[2]! } : null;
}

/** `n` without float noise: 0.1 + 0.2 shows as 0.3. */
export const tidy = (n: number) => String(roundTo(n, 3));

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
 * ten times that with Shift, a tenth with Alt. Half a step's travel either
 * way rounds to a whole step.
 */
export function scrubbed(
  start: number,
  travel: number,
  { step = 1, shift = false, fine = false, min, max }: ScrubLimits,
): number {
  const by = shift ? 10 : fine ? 0.1 : 1;
  const steps = travel / PX_PER_STEP;
  return clamp(start + Math.sign(steps) * Math.round(Math.abs(steps)) * step * by, min, max);
}

/**
 * One scrub from `start`: it takes the pointer's travel since the press and
 * gives the value, as `scrubbed` does. Travel past `min` or `max` is dropped
 * as it happens, so the scrub starts again from the limit: dragging back
 * moves the number one step after `PX_PER_STEP` of travel, however far the
 * pointer went past it.
 */
export function scrubber(start: number): (travel: number, limits: ScrubLimits) => number {
  let from = start;
  let base = 0;
  return (travel, limits) => {
    const value = scrubbed(from, travel - base, { ...limits, min: undefined, max: undefined });
    const held = clamp(value, limits.min, limits.max);
    if (held !== value) {
      // Half a step back toward the press, so the next step back is a
      // whole step's travel away.
      from = held;
      base = travel + (Math.sign(held - value) * PX_PER_STEP) / 2;
    }
    return held;
  };
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
