import type { ReactElement } from "react";

/**
 * The app's icon set: outline glyphs on a 24-unit grid, drawn for 15px.
 *
 * - Strokes are 1.6 units, which is exactly 1px at 15px. Below 15px the stroke
 *   grows so it stays 1px (2 units at 12px), which keeps small chevrons crisp.
 * - At 15px one pixel is 1.6 units, so pixel centers fall on 0.8 + 1.6k:
 *   4, 5.6, 7.2, 8.8, 10.4, 12, 13.6, 15.2, 16.8, 18.4, 20. Horizontal and
 *   vertical strokes sit on those lines, so they render without a blur.
 * - The live area is 4 to 20 for square shapes, with 2.4 to 21.6 for wide ones.
 * - Rectangles have rounded corners (2.4 units, 1.5px; 1.6 for small ones), and
 *   every cap and join is round.
 * - A glyph is filled only where filled is the convention (play, the solid
 *   fill swatch, dots), and everything is drawn in `currentColor`.
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
  | "sidebar"
  | "eye"
  | "eyeOff"
  | "lock"
  | "unlock"
  | "wrap"
  | "token"
  | "eyedropper"
  | "gap"
  | "padding"
  | "paddingX"
  | "paddingY"
  | "marginX"
  | "marginY"
  | "clip"
  | "sides"
  | "borderWidth"
  | "chevronDown"
  | "check"
  | "radius"
  | "corners"
  | "corner"
  | "shadow"
  | "innerShadow"
  | "opacity"
  | "fontSize"
  | "lineHeight"
  | "letterSpacing"
  | "alignLeft"
  | "alignCenter"
  | "alignRight"
  | "justify"
  | "fillSolid"
  | "fillLinear"
  | "fillRadial"
  | "button"
  | "rotate"
  | "italic"
  | "underline"
  | "strike"
  | "noWrap"
  | "truncate"
  | "balance"
  | "maxLines"
  | "flipH"
  | "flipV"
  | "link"
  | "unlink"
  | "fillConic"
  | "blend"
  | "cursor"
  | "margin"
  | "inset"
  | "stack"
  | "noneMark"
  | "caseUpper"
  | "caseLower"
  | "caseTitle"
  | "upright"
  | "move"
  | "skew"
  | "strokeInside"
  | "strokeCenter"
  | "strokeOutside"
  | "grip"
  | "scale"
  | "origin"
  | "clock"
  | "delay"
  | "angle"
  | "arrowUp";

const path = (d: string, extra = "") => `<path d="${d}"${extra}/>`;
const rect = (x: number, y: number, w: number, h: number, r: number, extra = "") =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}"${extra}/>`;
const circle = (cx: number, cy: number, r: number, extra = "") =>
  `<circle cx="${cx}" cy="${cy}" r="${r}"${extra}/>`;
/** A small solid dot. */
const dot = (cx: number, cy: number, r = 1.2) =>
  circle(cx, cy, r, ' fill="currentColor" stroke="none"');
const FILL = ' fill="currentColor"';
/** A diamond: a rounded square turned 45°, corner to corner 4 to 20. */
const diamond = rect(6.4, 6.4, 11.2, 11.2, 2, ' transform="rotate(45 12 12)"');
/** The standard 16-unit square frame. */
const square = rect(4, 4, 16, 16, 2.4);
/** A lowercase single-storey "a", its bowl centered on `x`. */
const lowerA = (x: number) => circle(x, 15.2, 3.2) + path(`M${x + 3.2} 12v6.4`);
/** An uppercase "A" from `x` to `x + 8`. */
const upperA = (x: number) => path(`M${x} 18.4l4-12.8 4 12.8M${x + 1.25} 14.4h5.5`);

/** Each icon's SVG children; `s` is the stroke width, for the few that vary it. */
const SHAPES: Record<IconName, string | ((s: number) => string)> = {
  play: path("M8.4 5.6 18.8 12 8.4 18.4z", FILL),
  previous: path("M14.8 6 8.8 12l6 6"),
  next: path("M9.2 6l6 6-6 6"),
  close: path("M6.4 6.4l11.2 11.2M17.6 6.4 6.4 17.6"),
  // Two arcs fanning up from a dot.
  wifi: path("M8.6 13.4a4.8 4.8 0 0 1 6.8 0M5.2 10a9.6 9.6 0 0 1 13.6 0") + dot(12, 16.8, 1.3),
  search: circle(10.4, 10.4, 6.4) + path("M15.2 15.2 20 20"),
  // A frame: two crossing pairs of lines.
  artboard: path("M8.8 4v16M15.2 4v16M4 8.8h16M4 15.2h16"),
  text: path("M5.6 7.2V5.6h12.8v1.6M12 5.6v12.8"),
  box: square,
  // Two bars stacked, two side by side, and four cells: the layout kinds next to `box`.
  column: rect(4, 4, 16, 6.4, 1.6) + rect(4, 13.6, 16, 6.4, 1.6),
  row: rect(4, 4, 6.4, 16, 1.6) + rect(13.6, 4, 6.4, 16, 1.6),
  grid:
    rect(4, 4, 6.4, 6.4, 1.6) +
    rect(13.6, 4, 6.4, 6.4, 1.6) +
    rect(4, 13.6, 6.4, 6.4, 1.6) +
    rect(13.6, 13.6, 6.4, 6.4, 1.6),
  component: diamond,
  image: square + circle(15.2, 8.8, 1.6) + path("M4.4 16 9.2 11.2l8.4 8.4"),
  // A sheet with its corner folded.
  page: path(
    "M13.6 3.2H8a2.4 2.4 0 0 0-2.4 2.4v12.8A2.4 2.4 0 0 0 8 20.8h8a2.4 2.4 0 0 0 2.4-2.4V8zM13.6 3.2v3.2a1.6 1.6 0 0 0 1.6 1.6h3.2",
  ),
  plus: path("M12 5.6v12.8M5.6 12h12.8"),
  minus: path("M5.6 12h12.8"),
  sidebar: rect(4, 5.6, 16, 12.8, 2.4) + path("M9.6 5.6v12.8"),
  eye:
    path("M3.2 12c1.9-3.7 5-5.6 8.8-5.6s6.9 1.9 8.8 5.6c-1.9 3.7-5 5.6-8.8 5.6S5.1 15.7 3.2 12z") +
    circle(12, 12, 2.4),
  eyeOff:
    path("M3.2 12c1.9-3.7 5-5.6 8.8-5.6s6.9 1.9 8.8 5.6c-1.9 3.7-5 5.6-8.8 5.6S5.1 15.7 3.2 12z") +
    path("M5.2 18.8 18.8 5.2"),
  lock: rect(5.6, 10.4, 12.8, 9.6, 2.4) + path("M8.8 10.4V8a3.2 3.2 0 0 1 6.4 0v2.4"),
  unlock: rect(5.6, 10.4, 12.8, 9.6, 2.4) + path("M8.8 10.4V8a3.2 3.2 0 0 1 6.3-.8"),
  // A line that runs out and turns back under itself.
  wrap: path("M4 6.4h12a4 4 0 0 1 0 8H8.8M11.2 12l-2.4 2.4 2.4 2.4"),
  token: diamond + dot(12, 12, 2),
  eyedropper: path(
    "M12 6.4l5.6 5.6M14.8 9.2l2.4-2.4a2.26 2.26 0 0 1 3.2 3.2L18 12.4M16 10.4l-7.6 7.6-3.2.8.8-3.2 7.6-7.6",
  ),
  // Two walls with the space between them.
  gap: path("M4 4.8v14.4M20 4.8v14.4M9.6 12h4.8"),
  padding: square + rect(8.8, 8.8, 6.4, 6.4, 1.2),
  paddingX: square + path("M8.8 8.8v6.4M15.2 8.8v6.4"),
  paddingY: square + path("M8.8 8.8h6.4M8.8 15.2h6.4"),
  marginX: rect(7.2, 7.2, 9.6, 9.6, 1.6) + path("M2.4 12h2.4M19.2 12h2.4"),
  marginY: rect(7.2, 7.2, 9.6, 9.6, 1.6) + path("M12 2.4v2.4M12 19.2v2.4"),
  // A box over a larger one, whose hidden part is faded.
  clip:
    rect(4, 4, 11.2, 11.2, 2.4) +
    path(
      "M15.2 8.8h2.4a2.4 2.4 0 0 1 2.4 2.4v6.4a2.4 2.4 0 0 1-2.4 2.4h-6.4a2.4 2.4 0 0 1-2.4-2.4v-2.4",
      ' stroke-opacity=".4"',
    ),
  // A box's four sides, apart at the corners.
  sides: path("M8 4h8M20 8v8M16 20H8M4 16V8"),
  // Three lines, each thicker than the last.
  borderWidth: (s) =>
    path("M4 5.6h16", ` stroke-width="${s}"`) +
    path("M4 11.6h16", ` stroke-width="${+(s * 1.35).toFixed(2)}"`) +
    path("M4 17.6h16", ` stroke-width="${+(s * 1.75).toFixed(2)}"`),
  chevronDown: path("M6 9l6 6 6-6"),
  check: path("M5.2 12.4l4.4 4.4 9.2-9.6"),
  radius: rect(4, 4, 16, 16, 5.6),
  corners: path(
    "M4 8.8V7.2A3.2 3.2 0 0 1 7.2 4h1.6M15.2 4h1.6A3.2 3.2 0 0 1 20 7.2v1.6M20 15.2v1.6a3.2 3.2 0 0 1-3.2 3.2h-1.6M8.8 20H7.2A3.2 3.2 0 0 1 4 16.8v-1.6",
  ),
  corner: path("M5.6 19.2V12a6.4 6.4 0 0 1 6.4-6.4h7.2"),
  // A box with the edge of its shadow below and to the right.
  shadow: rect(4, 4, 12.8, 12.8, 2.4) + path("M20 8.8v8.8a2.4 2.4 0 0 1-2.4 2.4H8.8"),
  innerShadow: square + path("M7.2 16V9.6a2.4 2.4 0 0 1 2.4-2.4H16"),
  // A disc, half solid: see-through to solid.
  opacity: circle(12, 12, 8) + path("M12 4a8 8 0 0 1 0 16z", FILL),
  // A large A beside a small T.
  fontSize: path("M3.2 18.4 8 5.6l4.8 12.8M5 14.4h6M14.4 11.2h6.4M17.6 11.2v7.2"),
  lineHeight: path("M4 4h16M4 20h16M12 8v8M9.6 10.4 12 8l2.4 2.4M9.6 13.6 12 16l2.4-2.4"),
  letterSpacing: path("M4 4v16M20 4v16M8 12h8M10.4 9.6 8 12l2.4 2.4M13.6 9.6 16 12l-2.4 2.4"),
  alignLeft: path("M4 5.6h16M4 12h10.4M4 18.4h12.8"),
  alignCenter: path("M4 5.6h16M7.2 12h9.6M5.6 18.4h12.8"),
  alignRight: path("M4 5.6h16M9.6 12h10.4M7.2 18.4h12.8"),
  justify: path("M4 5.6h16M4 12h16M4 18.4h16"),
  // A square with a solid square inside, built like the other fill kinds.
  fillSolid: square + rect(7.2, 7.2, 9.6, 9.6, 1.2, FILL),
  // A square with lines that shorten across it.
  fillLinear: square + path("M8.8 7.2v9.6M12 8.8v6.4M15.2 10.4v3.2"),
  // A square with a ring around a dot.
  fillRadial: square + circle(12, 12, 4) + dot(12, 12),
  // A square with a wedge swept from its middle.
  fillConic: square + path("M12 12V6.4a5.6 5.6 0 0 1 4.85 8.4z", FILL),
  button: rect(2.4, 7.2, 19.2, 9.6, 3.2),
  rotate: path("M19.2 12a7.2 7.2 0 1 1-1.6-4.8M17.6 3.2v4h-4"),
  italic: path("M10.4 4.8h7.2M6.4 19.2h7.2M14 4.8 10 19.2"),
  underline: path("M7.2 4.8v5.6a4.8 4.8 0 0 0 9.6 0V4.8M5.6 19.2h12.8"),
  strike: path(
    "M16.4 7.2c-.8-1.4-2.4-2.4-4.4-2.4-2.6 0-4.4 1.4-4.4 3.4 0 1.6 1 2.6 3.2 3.4M4.8 12h14.4M15.6 14.4c.5.6.8 1.3.8 2.2 0 2-1.9 3.2-4.4 3.2-2.2 0-3.8-.9-4.6-2.4",
  ),
  // A line that runs into a wall instead of wrapping.
  noWrap: path("M4 12h12M12.8 8.8 16 12l-3.2 3.2M20 4.8v14.4"),
  truncate: path("M4 12h7.2") + dot(14.4, 12) + dot(17.2, 12) + dot(20, 12),
  balance: path("M5.6 7.2h12.8M7.2 12h9.6M5.6 16.8h12.8"),
  maxLines:
    path("M4 5.6h16M4 12h16M4 18.4h7.2") + dot(14.4, 18.4) + dot(17.2, 18.4) + dot(20, 18.4),
  // Mirrored across a vertical axis: one arrowhead points left, its solid twin right.
  flipH: path("M12 3.2v17.6") + path("M8.8 7.2v9.6L3.2 12z") + path("M15.2 7.2v9.6l5.6-4.8z", FILL),
  // Mirrored across a horizontal axis: one arrowhead points up, its solid twin down.
  flipV: path("M3.2 12h17.6") + path("M7.2 8.8h9.6L12 3.2z") + path("M7.2 15.2h9.6L12 20.8z", FILL),
  link: path(
    "M10.4 13.6a3.4 3.4 0 0 0 4.8 0l3.2-3.2a3.4 3.4 0 0 0-4.8-4.8l-.8.8M13.6 10.4a3.4 3.4 0 0 0-4.8 0l-3.2 3.2a3.4 3.4 0 0 0 4.8 4.8l.8-.8",
  ),
  unlink: path(
    "M13.2 7.2l.8-.8a3.4 3.4 0 0 1 4.8 4.8l-.8.8M10.8 16.8l-.8.8a3.4 3.4 0 0 1-4.8-4.8l.8-.8M4.8 4.8l2.4 2.4M16.8 16.8l2.4 2.4",
  ),
  // Two circles that overlap.
  blend: circle(9.2, 12, 5.2) + circle(14.8, 12, 5.2),
  // An arrow pointer.
  cursor: path("M5.6 5.6l13.6 4.8-6.4 2.4-2.4 6.4z"),
  margin: rect(7.2, 7.2, 9.6, 9.6, 1.6) + path("M12 2.4v2.4M12 19.2v2.4M2.4 12h2.4M19.2 12h2.4"),
  // A box hanging below an edge.
  inset: path("M4 4h16M12 6.4v2.4") + rect(7.2, 10.4, 9.6, 8.8, 1.6),
  // A box in front of another.
  stack: rect(4, 8.8, 11.2, 11.2, 2.4) + path("M8.8 4h8.8A2.4 2.4 0 0 1 20 6.4v8.8"),
  noneMark: circle(12, 12, 7.2) + path("M6.9 17.1 17.1 6.9"),
  caseUpper: upperA(2.4) + upperA(13.6),
  caseLower: lowerA(6.8) + lowerA(15.6),
  caseTitle: upperA(2.4) + lowerA(15.6),
  // An upright T with a foot: not italic.
  upright: path("M6.4 5.6h11.2M12 5.6v12.8M9.6 18.4h4.8"),
  move: path(
    "M12 3.2v17.6M3.2 12h17.6M9.6 5.6 12 3.2l2.4 2.4M9.6 18.4l2.4 2.4 2.4-2.4M5.6 9.6 3.2 12l2.4 2.4M18.4 9.6l2.4 2.4-2.4 2.4",
  ),
  skew: path("M8.8 5.6H20l-4.8 12.8H4z"),
  // A box's corner (the solid line) with its stroke (the shaded band) inside, across or outside it.
  strokeInside:
    path("M11.2 20V11.2H20", ' stroke-width="4" stroke-opacity=".35"') + path("M8.8 20V8.8H20"),
  strokeCenter:
    path("M8.8 20V8.8H20", ' stroke-width="4" stroke-opacity=".35"') + path("M8.8 20V8.8H20"),
  strokeOutside:
    path("M6.4 20V6.4H20", ' stroke-width="4" stroke-opacity=".35"') + path("M8.8 20V8.8H20"),
  // Two columns of dots, to drag a row by.
  grip:
    dot(9.6, 7.2) +
    dot(14.4, 7.2) +
    dot(9.6, 12) +
    dot(14.4, 12) +
    dot(9.6, 16.8) +
    dot(14.4, 16.8),
  scale: rect(4, 12.8, 7.2, 7.2, 1.6) + path("M14.4 4H20v5.6M20 4l-7.2 7.2"),
  origin: circle(12, 12, 7.2) + dot(12, 12, 1.6),
  clock: circle(12, 12, 8) + path("M12 7.2V12l3.2 2.4"),
  // A clock hand inside an arrow turning back: time before it starts.
  delay: path("M4.8 12a7.2 7.2 0 1 0 1.6-4.8M6.4 3.2v4h4M12 8.8V12l2.4 1.6"),
  // Two arms meeting at a corner, with the arc between them: an angle, for a rotation's degrees.
  angle: path("M4.8 19.2h14.4M4.8 19.2 15.2 6.4M12.8 19.2a8 8 0 0 0-2.95-6.21"),
  // A shaft on the center pixel column, under a head that meets it at its tip: send.
  arrowUp: path("M12 19.2V5.6M6.4 11.2 12 5.6l5.6 5.6"),
};

export const ICON_NAMES = Object.keys(SHAPES) as readonly IconName[];

/** Stroke width in the 24-unit box: 1px at 15px and below, so small icons don't thin out. */
export function strokeFor(size: number): number {
  return size >= 15 ? 1.6 : +(24 / size).toFixed(2);
}

/**
 * The icon as SVG markup, for plain DOM callers (`el.innerHTML = iconMarkup(...)`).
 * The markup carries no ids, so any number of copies can share a page.
 * `_key` is accepted for older callers and ignored.
 */
export function iconMarkup(name: IconName, size = 16, _key = ""): string {
  const s = strokeFor(size);
  const shape = SHAPES[name];
  const body = typeof shape === "function" ? shape(s) : shape;
  return (
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" aria-hidden="true" ` +
    `stroke="currentColor" stroke-width="${s}" stroke-linecap="round" stroke-linejoin="round" ` +
    `style="display:block;overflow:visible;flex:none">${body}</svg>`
  );
}

/** An icon that follows the surrounding text color. */
export function Icon({ name, size = 16 }: { name: IconName; size?: number }): ReactElement {
  // The markup is built from constants and a number, never from user input.
  return (
    <span
      style={{ display: "contents" }}
      dangerouslySetInnerHTML={{ __html: iconMarkup(name, size) }}
    />
  );
}
