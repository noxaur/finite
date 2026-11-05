import { type ReactElement, useId } from "react";

/**
 * Small hand-inked icons, drawn like the tool pill's pointer: path data written
 * by hand, run through a turbulence + displacement wobble, in `currentColor`.
 *
 * Every SVG carries its own filter, with an id unique to that copy, so an icon
 * works anywhere without a shared <defs> in the page, and hiding one copy with
 * `display: none` never takes another copy's filter with it.
 */

export type IconName = "play" | "previous" | "next" | "close" | "wifi";

interface Shape {
  readonly d: string;
  /** Filled shapes are also stroked, so the wobble rounds their corners. */
  readonly filled: boolean;
  /** Seeds the noise, so the icons don't all wobble the same way. */
  readonly seed: number;
}

const SHAPES: Record<IconName, Shape> = {
  play: {
    d: "M6.8 4.3c4.2 2.3 8.6 5 12.8 7.4-4 2.7-8.2 5.5-12.3 8.2-.5-5.2-.6-10.3-.5-15.6z",
    filled: true,
    seed: 3,
  },
  previous: { d: "M14.9 5.1c-2.5 2.4-5 4.5-6.8 7 2 2.2 4.5 4.3 7 6.6", filled: false, seed: 5 },
  next: { d: "M9.2 5c2.6 2.3 5 4.6 6.9 6.9-2.4 2.4-4.8 4.7-7.2 7.1", filled: false, seed: 8 },
  close: {
    d: "M6.2 6.5c3.9 3.6 7.7 7.4 11.6 11.2M17.7 5.9c-3.8 3.9-7.6 8-11.4 12.2",
    filled: false,
    seed: 11,
  },
  // Two arcs fanning up from a dot; the dot is a near-zero stroke the round cap fills.
  wifi: {
    d: "M12 19.6l.2.3M7.9 15.4c2.4-2.3 5.6-2.4 8.2.1M3.6 10.8c5.1-5 11.7-5.2 16.9-.1",
    filled: false,
    seed: 14,
  },
};

export const ICON_NAMES = Object.keys(SHAPES) as readonly IconName[];

/** Stroke width in the 24-unit box. Thick enough to survive 10px. */
const STROKE = 2.6;

/**
 * The icon as SVG markup, for plain DOM callers (`el.innerHTML = iconMarkup(...)`).
 * `key` makes its filter id unique: pass one per copy on the page.
 */
export function iconMarkup(name: IconName, size = 16, key = ""): string {
  const { d, filled, seed } = SHAPES[name];
  const id = `fin-ico-${name}${key.replace(/[^\w-]/g, "")}`;
  return (
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" aria-hidden="true" ` +
    `style="display:block;overflow:visible;flex:none">` +
    `<filter id="${id}" filterUnits="userSpaceOnUse" x="-3" y="-3" width="30" height="30">` +
    `<feTurbulence type="fractalNoise" baseFrequency="0.045" numOctaves="1" seed="${seed}"/>` +
    `<feDisplacementMap in="SourceGraphic" scale="2.6" xChannelSelector="R" yChannelSelector="G"/>` +
    `</filter>` +
    `<path d="${d}" fill="${filled ? "currentColor" : "none"}" stroke="currentColor" ` +
    `stroke-width="${STROKE}" stroke-linecap="round" stroke-linejoin="round" filter="url(#${id})"/>` +
    `</svg>`
  );
}

/** A hand-drawn icon that follows the surrounding text color. */
export function Icon({ name, size = 16 }: { name: IconName; size?: number }): ReactElement {
  const key = useId();
  // The markup is built from constants, a number and React's id, never from user input.
  return (
    <span
      style={{ display: "contents" }}
      dangerouslySetInnerHTML={{ __html: iconMarkup(name, size, key) }}
    />
  );
}
