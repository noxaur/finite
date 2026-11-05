import { type ReactElement, useId } from "react";

/**
 * Small hand-inked icons, drawn like the tool pill's pointer: path data written
 * by hand, run through a turbulence + displacement wobble, in `currentColor`.
 *
 * Every SVG carries its own filter, with an id unique to that copy, so an icon
 * works anywhere without a shared <defs> in the page, and hiding one copy with
 * `display: none` never takes another copy's filter with it.
 */

export type IconName =
  | "play"
  | "previous"
  | "next"
  | "close"
  | "wifi"
  | "search"
  | "artboard"
  | "text"
  | "box"
  | "column"
  | "row"
  | "grid"
  | "component"
  | "image"
  | "page"
  | "plus"
  | "minus"
  | "sidebar";

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
  search: {
    d: "M10.5 4.6c3.4-.2 6 2.4 5.9 5.8-.1 3.2-2.8 5.7-6 5.6-3.2-.1-5.6-2.8-5.5-5.9.1-3 2.6-5.4 5.6-5.5zM15 15.2c1.5 1.4 2.9 2.9 4.4 4.4",
    filled: false,
    seed: 17,
  },
  artboard: {
    d: "M8.6 4.2c-.2 5.2-.4 10.4-.6 15.6M15.6 4.4c-.1 5.1-.3 10.2-.4 15.4M4.3 8.8c5.1-.1 10.3-.2 15.4-.1M4.2 15.3c5.2-.1 10.3 0 15.5 0",
    filled: false,
    seed: 19,
  },
  text: { d: "M5.6 5.8c4.3-.2 8.6-.1 12.9 0M12 5.9c-.1 4.2 0 8.4.1 12.6", filled: false, seed: 21 },
  box: {
    d: "M5.3 5.4c4.5-.2 9-.1 13.4 0 .1 4.4.1 8.9 0 13.3-4.4.1-8.9.1-13.3 0-.2-4.4-.2-8.9-.1-13.3z",
    filled: false,
    seed: 23,
  },
  column: {
    d: "M5.2 7c4.6-.1 9.1 0 13.7.1M5.1 12c4.6 0 9.2-.1 13.8 0M5.3 17c4.5-.1 9 0 13.5 0",
    filled: false,
    seed: 25,
  },
  row: {
    d: "M7 5.2c.1 4.6 0 9.1-.1 13.7M12 5.1c0 4.6.1 9.2 0 13.8M17 5.3c-.1 4.5 0 9 0 13.5",
    filled: false,
    seed: 27,
  },
  grid: {
    d: "M5.4 5.5c1.7-.1 3.5-.1 5.2 0 .1 1.7.1 3.4 0 5.1-1.7.1-3.5.1-5.2 0-.1-1.7-.1-3.4 0-5.1zM13.4 5.4c1.7 0 3.5 0 5.2.1 0 1.7 0 3.4-.1 5.1-1.7.1-3.4.1-5.1 0-.1-1.7-.1-3.5 0-5.2zM5.5 13.4c1.7 0 3.4 0 5.1.1.1 1.7.1 3.4 0 5.1-1.7.1-3.4.1-5.1 0-.1-1.7-.1-3.5 0-5.2zM13.4 13.5c1.7-.1 3.5-.1 5.2 0 .1 1.7.1 3.4 0 5.1-1.7.1-3.5.1-5.2 0-.1-1.7-.1-3.4 0-5.1z",
    filled: false,
    seed: 29,
  },
  component: {
    d: "M12 4.2c2.6 2.6 5.2 5.2 7.8 7.8-2.6 2.6-5.2 5.2-7.8 7.8-2.6-2.6-5.2-5.2-7.8-7.8 2.6-2.6 5.2-5.2 7.8-7.8z",
    filled: false,
    seed: 31,
  },
  image: {
    d: "M5.2 5.3c4.5-.1 9-.1 13.6 0 .1 4.5.1 8.9 0 13.4-4.5.1-9 .1-13.6 0-.1-4.5-.1-8.9 0-13.4zM5.4 16.2c2.4-2.5 4.4-4.4 6.4-6.2 2.3 2 4.6 4.2 7 6.6",
    filled: false,
    seed: 33,
  },
  page: {
    d: "M7 3.8c3.3 0 6.6 0 9.9.1.1 5.4.1 10.8 0 16.2-3.3.1-6.6.1-9.9 0-.1-5.4-.1-10.9 0-16.3z",
    filled: false,
    seed: 35,
  },
  plus: { d: "M12 5.2c0 4.6.1 9.1 0 13.6M5.2 12c4.6-.1 9.1 0 13.6 0", filled: false, seed: 37 },
  minus: { d: "M5.2 12c4.6-.1 9.1 0 13.6 0", filled: false, seed: 39 },
  sidebar: {
    d: "M4.5 5.3c5-.1 10-.1 15 0 .1 4.5.1 9 0 13.5-5 .1-10 .1-15 0-.1-4.5-.1-9 0-13.5zM9.5 5.4c-.1 4.4-.1 8.8 0 13.2",
    filled: false,
    seed: 41,
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
