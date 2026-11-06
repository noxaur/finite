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
  | "delay";

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
  eye: {
    d: "M3.5 12.1c2.3-3.7 5.2-5.6 8.6-5.6 3.3.1 6.2 1.9 8.4 5.5-2.2 3.6-5.1 5.5-8.5 5.5-3.4 0-6.3-1.8-8.5-5.4zM12 9.8c1.3 0 2.3 1 2.3 2.3 0 1.2-1 2.2-2.3 2.2-1.2 0-2.2-1-2.2-2.2 0-1.3 1-2.3 2.2-2.3z",
    filled: false,
    seed: 43,
  },
  eyeOff: {
    d: "M3.5 12.1c2.3-3.7 5.2-5.6 8.6-5.6 3.3.1 6.2 1.9 8.4 5.5-2.2 3.6-5.1 5.5-8.5 5.5-3.4 0-6.3-1.8-8.5-5.4zM4.6 19.3c4.9-4.9 9.9-9.8 14.8-14.7",
    filled: false,
    seed: 45,
  },
  lock: {
    d: "M6.2 11c3.9-.1 7.8-.1 11.7 0 .1 2.8.1 5.6 0 8.4-3.9.1-7.8.1-11.7 0-.1-2.8-.1-5.6 0-8.4zM8.6 10.9c-.1-1.6 0-3 .7-4 .7-1 1.6-1.6 2.8-1.6 1.2 0 2.1.6 2.7 1.5.7 1 .8 2.4.7 4.1",
    filled: false,
    seed: 47,
  },
  unlock: {
    d: "M6.2 11c3.9-.1 7.8-.1 11.7 0 .1 2.8.1 5.6 0 8.4-3.9.1-7.8.1-11.7 0-.1-2.8-.1-5.6 0-8.4zM8.6 10.9c-.1-1.6 0-3 .7-4 .7-1 1.6-1.6 2.8-1.6 1.2 0 2.1.5 2.7 1.4",
    filled: false,
    seed: 49,
  },
  wrap: {
    d: "M4.5 7.1c4 .1 8-.1 12 .1 4.6.2 4.6 6.8 0 7H8.2M11 11.3c-1 .9-2 1.9-2.8 2.9 1 .9 1.9 1.9 2.8 2.8",
    filled: false,
    seed: 51,
  },
  token: {
    d: "M12.1 4.3c2.5 2.6 5 5.1 7.6 7.7-2.6 2.6-5.1 5.1-7.7 7.7-2.6-2.6-5.1-5.1-7.7-7.6 2.6-2.6 5.2-5.2 7.8-7.8zM12 11.9l.1.2",
    filled: false,
    seed: 53,
  },
  eyedropper: {
    d: "M14.6 5.4c1.4-1.3 3.5-1.3 4.8.1 1.3 1.4 1.3 3.4 0 4.8l-1.7 1.6-4.8-4.8 1.7-1.7zM12.3 7.7l4 4c-2.7 2.6-5.3 5.3-7.9 7.9H4.5v-3.9c2.6-2.7 5.2-5.3 7.8-8z",
    filled: false,
    seed: 55,
  },
  gap: {
    d: "M5.1 5c-.1 4.7.1 9.3-.1 14M18.9 5c.1 4.7-.1 9.3.1 14M9 12.1c2-.1 4 .1 6 0",
    filled: false,
    seed: 57,
  },
  padding: {
    d: "M4.6 4.5h14.8v15H4.6zM9 9h6v6H9z",
    filled: false,
    seed: 59,
  },
  paddingX: {
    d: "M4.6 4.5h14.8v15H4.6zM8.6 8.6v6.8M15.4 8.6v6.8",
    filled: false,
    seed: 301,
  },
  paddingY: {
    d: "M4.6 4.5h14.8v15H4.6zM8.6 8.6h6.8M8.6 15.4h6.8",
    filled: false,
    seed: 303,
  },
  marginX: {
    d: "M8.1 8.2c2.6-.1 5.2 0 7.8-.1.1 2.6 0 5.2.1 7.8-2.6.1-5.2 0-7.8.1-.1-2.6 0-5.2-.1-7.8zM3.6 12h2.2M18.2 12h2.2",
    filled: false,
    seed: 305,
  },
  marginY: {
    d: "M8.1 8.2c2.6-.1 5.2 0 7.8-.1.1 2.6 0 5.2.1 7.8-2.6.1-5.2 0-7.8.1-.1-2.6 0-5.2-.1-7.8zM12 3.6v2.2M12 18.2v2.2",
    filled: false,
    seed: 307,
  },
  clip: {
    d: "M5 3.6c3-.1 6 .1 9-.1.8 0 1.5.7 1.5 1.5.1 3-.1 6 0 9 0 .8-.7 1.5-1.5 1.5-3 .1-6-.1-9 0-.8 0-1.5-.7-1.5-1.5-.1-3 .1-6 0-9 0-.8.7-1.4 1.5-1.4zM15.6 8.6h4.9v11.9H8.6v-4.9",
    filled: false,
    seed: 61,
  },
  sides: {
    d: "M7.5 5c3-.1 6 .1 9-.1M19 7.5c.1 3-.1 6 .1 9M16.5 19c-3 .1-6-.1-9 .1M5 16.5c-.1-3 .1-6-.1-9",
    filled: false,
    seed: 63,
  },
  borderWidth: {
    d: "M4.5 6.2c5-.1 10 .1 15-.1M4.5 11.9c5 .1 10-.1 15 0M4.6 17.6c5-.1 9.9.1 14.9-.1",
    filled: false,
    seed: 65,
  },
  chevronDown: {
    d: "M5 9.2c2.3 2.6 4.6 5 6.9 6.9 2.4-2.4 4.7-4.8 7.1-7.2",
    filled: false,
    seed: 67,
  },
  check: {
    d: "M5.2 12.6c1.6 1.5 3.1 3.3 4.4 5.2 2.6-4.3 5.6-8.2 9.2-11.4",
    filled: false,
    seed: 73,
  },
  radius: {
    d: "M5 9.2c-.1-2.4 1.8-4.3 4.2-4.2 1.9.1 3.8-.1 5.6 0 2.4-.1 4.3 1.8 4.2 4.2-.1 1.9.1 3.8 0 5.6.1 2.4-1.8 4.3-4.2 4.2-1.9-.1-3.8.1-5.6 0-2.4.1-4.3-1.8-4.2-4.2.1-1.9-.1-3.8 0-5.6z",
    filled: false,
    seed: 69,
  },
  corners: {
    d: "M5 9.2V7.1C5 5.9 5.9 5 7.1 5h2.1M14.8 5h2.1C18.1 5 19 5.9 19 7.1v2.1M19 14.8v2.1c0 1.2-.9 2.1-2.1 2.1h-2.1M9.2 19H7.1C5.9 19 5 18.1 5 16.9v-2.1",
    filled: false,
    seed: 71,
  },
  corner: {
    d: "M5.3 18.8V12c0-3.7 3-6.8 6.7-6.7h6.8",
    filled: false,
    seed: 73,
  },
  shadow: {
    d: "M5.9 3.8c2.8-.1 5.6.1 8.4-.1 1.2 0 2.1 1 2.2 2.2-.1 2.8.1 5.6 0 8.4 0 1.2-1 2.1-2.2 2.2-2.8-.1-5.6.1-8.4 0-1.2 0-2.1-1-2.2-2.2.1-2.8-.1-5.6 0-8.4.1-1.2 1-2.1 2.2-2.1zM20.2 8.3c.1 3.5-.1 7 .1 10.5 0 .8-.7 1.5-1.5 1.5-3.5-.1-7 .1-10.5-.1",
    filled: false,
    seed: 75,
  },
  innerShadow: {
    d: "M6 3.8c4-.1 8 .1 12-.1 1.2 0 2.2 1 2.3 2.2-.1 4 .1 8 0 12 0 1.2-1 2.2-2.2 2.3-4-.1-8 .1-12 0-1.2 0-2.2-1-2.3-2.2.1-4-.1-8 0-12 .1-1.2 1-2.2 2.2-2.2zM7.5 16.5c.1-2.3-.1-4.5 0-6.8 0-1.2 1-2.2 2.2-2.2 2.3.1 4.5-.1 6.8 0",
    filled: false,
    seed: 77,
  },
  opacity: {
    d: "M12 3.8c4.5 0 8.2 3.7 8.2 8.2 0 4.6-3.7 8.3-8.2 8.2-4.6 0-8.3-3.7-8.2-8.2 0-4.5 3.7-8.2 8.2-8.2zM12 4.2c.1 5.2-.1 10.4.1 15.6M15.6 6c.1 4 0 8 .1 12",
    filled: false,
    seed: 79,
  },
  fontSize: {
    d: "M4.5 18.5 9 6.5l4.5 12M6.2 14h5.6M15.5 18.5V12M13.5 12.2h4",
    filled: false,
    seed: 81,
  },
  lineHeight: {
    d: "M4.5 4.5h15M4.5 19.5h15M12 8v8M9.5 10.2 12 7.8l2.5 2.4M9.5 13.8 12 16.2l2.5-2.4",
    filled: false,
    seed: 83,
  },
  letterSpacing: {
    d: "M4.5 4.5v15M19.5 4.5v15M8 12h8M10.2 9.5 7.8 12l2.4 2.5M13.8 9.5l2.4 2.5-2.4 2.5",
    filled: false,
    seed: 85,
  },
  alignLeft: {
    d: "M4.5 6.5h15M4.5 12h9M4.5 17.5h12",
    filled: false,
    seed: 87,
  },
  alignCenter: {
    d: "M4.5 6.5h15M7.5 12h9M6 17.5h12",
    filled: false,
    seed: 89,
  },
  alignRight: {
    d: "M4.5 6.5h15M10.5 12h9M7.5 17.5h12",
    filled: false,
    seed: 91,
  },
  justify: {
    d: "M4.5 6.5h15M4.5 12h15M4.5 17.5h15",
    filled: false,
    seed: 93,
  }, // A square scribbled full.
  fillSolid: {
    d: "M5.2 5.1c4.6-.1 9.1.1 13.7-.1.1 4.6-.1 9.2.1 13.8-4.6.1-9.2-.1-13.8.1-.1-4.6.1-9.2 0-13.8zM7.9 7.9c2.7-.1 5.5.1 8.2 0M7.9 10.6c2.7.1 5.5-.1 8.2 0M7.9 13.3c2.7-.1 5.5.1 8.2 0M7.9 16c2.7.1 5.5-.1 8.2 0",
    filled: false,
    seed: 95,
  },
  // A square with lines that thin out across it.
  fillLinear: {
    d: "M5.2 5.1c4.6-.1 9.1.1 13.7-.1.1 4.6-.1 9.2.1 13.8-4.6.1-9.2-.1-13.8.1-.1-4.6.1-9.2 0-13.8zM7.9 7.9c-.1 2.7.1 5.4 0 8.1M10.5 7.9c.1 2.7-.1 5.4 0 8.1M13.6 9.8c.1 1.5-.1 2.9 0 4.4",
    filled: false,
    seed: 97,
  },
  // A square with a ring around its middle.
  fillRadial: {
    d: "M5.2 5.1c4.6-.1 9.1.1 13.7-.1.1 4.6-.1 9.2.1 13.8-4.6.1-9.2-.1-13.8.1-.1-4.6.1-9.2 0-13.8zM12 9.4c1.5 0 2.6 1.2 2.6 2.7 0 1.4-1.1 2.6-2.6 2.6s-2.6-1.2-2.6-2.6c0-1.5 1.1-2.7 2.6-2.7z",
    filled: false,
    seed: 99,
  },
  button: {
    d: "M6.6 8.4c3.6-.1 7.2-.1 10.8 0 1.6.1 2.4 1 2.4 2.5v2.3c0 1.5-.9 2.4-2.4 2.4-3.6.1-7.2.1-10.8 0-1.5 0-2.4-.9-2.4-2.4v-2.4c0-1.5.9-2.3 2.4-2.4z",
    filled: false,
    seed: 97,
  },
  rotate: {
    d: "M18.6 12.4c-.1 3.7-3.1 6.6-6.8 6.5-3.6-.1-6.5-3.1-6.4-6.7.1-3.6 3.1-6.4 6.7-6.3 1.9 0 3.5.8 4.8 2.1M17.4 4.6c.1 1.4 0 2.8-.1 4.1-1.4.1-2.7.1-4.1 0",
    filled: false,
    seed: 101,
  },
  italic: {
    d: "M10 5h7M7 19h7M14.5 5.2 9.5 18.8",
    filled: false,
    seed: 111,
  },
  underline: {
    d: "M7.5 4.8v6c0 2.8 1.9 4.6 4.5 4.6s4.5-1.8 4.5-4.6v-6M5.5 19.4h13",
    filled: false,
    seed: 113,
  },
  strike: {
    d: "M16.5 6.8c-.8-1.3-2.5-2.1-4.5-2.1-2.6 0-4.4 1.4-4.4 3.3 0 1.6 1 2.6 3.4 3.3M4.8 12.2h14.4M15.6 14.6c.6.6.9 1.3.9 2.1 0 2-1.9 3.2-4.6 3.2-2.1 0-3.9-.8-4.8-2.2",
    filled: false,
    seed: 115,
  },
  noWrap: {
    d: "M4.5 12h13M14.8 9.2l2.9 2.8-2.9 2.8M20 5v14",
    filled: false,
    seed: 117,
  },
  truncate: {
    d: "M4.5 12h7.5M15 12h.1M17.8 12h.1M20.5 12h.1",
    filled: false,
    seed: 119,
  },
  balance: {
    d: "M5.5 8h13M7.5 12.5h9M5.5 17h13",
    filled: false,
    seed: 121,
  },
  maxLines: {
    d: "M4.5 6.5h15M4.5 11.5h15M4.5 16.5h7M14.8 16.5h.1M17.4 16.5h.1M20 16.5h.1",
    filled: false,
    seed: 123,
  },
  flipH: {
    d: "M12 4v16M9.5 6.8 4.6 17.2h4.9zM14.5 6.8l4.9 10.4h-4.9z",
    filled: false,
    seed: 125,
  },
  flipV: {
    d: "M4 12h16M6.8 9.5 17.2 4.6v4.9zM6.8 14.5l10.4 4.9v-4.9z",
    filled: false,
    seed: 127,
  },
  link: {
    d: "M10.2 13.8c1.4 1.5 3.6 1.5 5 .1l2.7-2.7c1.4-1.4 1.4-3.6 0-5s-3.6-1.4-5 0l-1 1M13.8 10.2c-1.4-1.5-3.6-1.5-5-.1l-2.7 2.7c-1.4 1.4-1.4 3.6 0 5s3.6 1.4 5 0l1-1",
    filled: false,
    seed: 129,
  },
  unlink: {
    d: "M13.2 7.1 13 7.3c1.4-1.4 3.6-1.4 5 0s1.4 3.6 0 5l-1.8 1.8M10.8 16.9l-1 1c-1.4 1.4-3.6 1.4-5 0s-1.4-3.6 0-5l1.8-1.8M4.8 4.8l2 2M17.2 17.2l2 2",
    filled: false,
    seed: 131,
  }, // A square with a wedge swept from its middle.
  fillConic: {
    d: "M5.2 5.1c4.6-.1 9.1.1 13.7-.1.1 4.6-.1 9.2.1 13.8-4.6.1-9.2-.1-13.8.1-.1-4.6.1-9.2 0-13.8zM12 12.1c0-1.4.1-2.8 0-4.2M12 12.1c1.2.8 2.4 1.5 3.6 2.2",
    filled: false,
    seed: 133,
  },
  // Two circles that overlap.
  blend: {
    d: "M9.6 5.4c2.7 0 4.8 2.2 4.8 4.9s-2.2 4.8-4.8 4.8-4.9-2.2-4.9-4.8 2.2-4.9 4.9-4.9zM14.4 9c2.7 0 4.9 2.1 4.9 4.8s-2.2 4.9-4.9 4.9-4.8-2.2-4.8-4.9",
    filled: false,
    seed: 135,
  },
  // An arrow pointer.
  cursor: {
    d: "M6.3 4.9c4.1 1.6 8.3 3.1 12.4 4.8-1.9.7-3.8 1.3-5.6 2.1-.8 1.9-1.4 3.8-2.1 5.7-1.6-4.2-3.1-8.4-4.7-12.6zM13.3 12.2c1.5 1.5 3 3 4.4 4.5",
    filled: false,
    seed: 137,
  },
  margin: {
    d: "M8.1 8.2c2.6-.1 5.2 0 7.8-.1.1 2.6 0 5.2.1 7.8-2.6.1-5.2 0-7.8.1-.1-2.6 0-5.2-.1-7.8zM12 3.6v2.2M12 18.2v2.2M3.6 12h2.2M18.2 12h2.2",
    filled: false,
    seed: 103,
  },
  inset: {
    d: "M4.4 4.6c5.1.1 10.1-.1 15.2.1M8.2 10.1c2.6-.1 5.1 0 7.7-.1.1 2.9 0 5.8.1 8.7-2.6.1-5.1 0-7.7.1-.1-2.9 0-5.8-.1-8.7zM12 5.2v3.4",
    filled: false,
    seed: 107,
  },
  stack: {
    d: "M4.6 9.2c3.2-.1 6.3 0 9.5-.1.1 3.5 0 7 .1 10.4-3.2.1-6.3 0-9.5.1-.1-3.5 0-7-.1-10.4zM9.4 5.6c3.3-.1 6.6 0 9.9-.1.1 3.3 0 6.6.1 9.9",
    filled: false,
    seed: 109,
  },
  noneMark: {
    d: "M12 4.6c4.1 0 7.4 3.3 7.4 7.4s-3.3 7.4-7.4 7.4-7.4-3.3-7.4-7.4 3.3-7.4 7.4-7.4zM6.8 17.2 17.2 6.8",
    filled: false,
    seed: 141,
  },
  caseUpper: {
    d: "M2.8 18.5 6.8 5.5l4 13M4.2 14.2h5.2M13.2 18.5l4-13 4 13M14.6 14.2h5.2",
    filled: false,
    seed: 143,
  },
  caseLower: {
    d: "M9.6 11.2v7.3M9.6 14.8c0-2-1.2-3.4-2.9-3.4s-2.9 1.5-2.9 3.5 1.2 3.4 2.9 3.4 2.9-1.4 2.9-3.5M20.2 11.2v7.3M20.2 14.8c0-2-1.2-3.4-2.9-3.4s-2.9 1.5-2.9 3.5 1.2 3.4 2.9 3.4 2.9-1.4 2.9-3.5",
    filled: false,
    seed: 145,
  },
  caseTitle: {
    d: "M2.8 18.5 6.8 5.5l4 13M4.2 14.2h5.2M20.4 11.2v7.3M20.4 14.8c0-2-1.2-3.4-2.9-3.4s-2.9 1.5-2.9 3.5 1.2 3.4 2.9 3.4 2.9-1.4 2.9-3.5",
    filled: false,
    seed: 147,
  },
  upright: {
    d: "M6 5.5h12M12 5.5v13M9.5 18.5h5",
    filled: false,
    seed: 149,
  },
  move: {
    d: "M12 3.8v16.4M3.8 12h16.4M9.6 6.2 12 3.8l2.4 2.4M9.6 17.8l2.4 2.4 2.4-2.4M6.2 9.6 3.8 12l2.4 2.4M17.8 9.6l2.4 2.4-2.4 2.4",
    filled: false,
    seed: 151,
  },
  skew: {
    d: "M8.2 6h11.3l-3.7 12H4.5z",
    filled: false,
    seed: 153,
  }, // A box's corner, with its stroke inside the edge.
  strokeInside: { d: "M6 20V6h14M10 20v-10h10", filled: false, seed: 155 },
  // A box's corner, its stroke crossing the edge.
  strokeCenter: { d: "M6 20V6h14M3.5 10h5M3.5 15h5M10 3.5v5M15 3.5v5", filled: false, seed: 157 },
  // A box's corner, with its stroke outside the edge.
  strokeOutside: { d: "M9 20V9h11M4.5 20V4.5H20", filled: false, seed: 159 },
  // Two columns of dots, to drag a row by.
  grip: {
    d: "M9 6.5h.1M15 6.5h.1M9 12h.1M15 12h.1M9 17.5h.1M15 17.5h.1",
    filled: false,
    seed: 161,
  },
  scale: {
    d: "M4.5 19.5v-6h6v6zM10.5 13.5 19.5 4.5M14 4.5h5.5V10",
    filled: false,
    seed: 155,
  },
  origin: {
    d: "M12 4.6c4.1 0 7.4 3.3 7.4 7.4s-3.3 7.4-7.4 7.4-7.4-3.3-7.4-7.4 3.3-7.4 7.4-7.4zM12 11.2c.5 0 .8.3.8.8s-.3.8-.8.8-.8-.3-.8-.8.3-.8.8-.8z",
    filled: false,
    seed: 157,
  },
  clock: {
    d: "M12 4.4c4.2 0 7.6 3.4 7.6 7.6s-3.4 7.6-7.6 7.6-7.6-3.4-7.6-7.6 3.4-7.6 7.6-7.6zM12 7.8V12l2.8 1.9",
    filled: false,
    seed: 159,
  },
  delay: {
    d: "M12 4.4c4.2 0 7.6 3.4 7.6 7.6s-3.4 7.6-7.6 7.6-7.6-3.4-7.6-7.6M12 7.8V12l2.8 1.9M4.4 8.2h3.8V4.4",
    filled: false,
    seed: 161,
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
