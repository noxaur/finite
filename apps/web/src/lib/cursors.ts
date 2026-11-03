/**
 * Hand-inked cursors as CSS custom properties on :root. Each renders at 24px (the comment pin at 28)
 * in black ink with a white outline, a small wobble filter and a soft drop shadow, so they stay
 * sharp, readable on any background and under 32px.
 */

const INK = "#1a1a18";

/** The speech-bubble outline every pin is drawn from, tail tip at (3, 34). */
export const PIN_PATH =
  "M3 34C5 31 7 28 8 25C4 22 2 18 2 14C2 7 10 2 20 2C30 2 38 7 38 14C38 22 30 27 20 27C17 27 15 27 13 26C10 30 6 33 3 34Z";

const HAND_POINTER =
  "M11 18.6V7A1.8 1.8 0 0 1 14.6 7V14.6L15.1 15.6L15.6 14.6A2 2 0 0 1 19.6 14.6L20.1 15.6L20.6 14.8A1.9 1.9 0 0 1 24.4 14.8L24.9 15.8L25.4 16.2A1.6 1.6 0 0 1 28.6 16.2V21.5C28.6 26.5 25.6 29.6 21 29.6H17C14 29.6 12.4 28.2 10.9 26L6 19.8C4.9 18.4 5.8 16.4 7.6 16.6C9 16.8 10.1 17.6 11 18.6Z";
const OPEN_HAND =
  "M10 18.6V8.8A1.8 1.8 0 0 1 13.6 8.8V14L14.3 15.2L15 14V6.8A1.8 1.8 0 0 1 18.6 6.8V14L19.3 15.2L20 14V7.8A1.8 1.8 0 0 1 23.6 7.8V14.4L24.3 15.6L25 14.4V11.1A1.6 1.6 0 0 1 28.2 11.1V21.5C28.2 26.5 25.4 29.6 21 29.6H16.6C13.6 29.6 12 28.2 10.4 26L5 19.6C3.9 18.2 4.8 16.2 6.6 16.4C8 16.6 9.2 17.6 10 18.6Z";
const CLOSED_HAND =
  "M9.6 15.2L9.4 12.4A2 2 0 0 1 13.4 12.4L13.8 13.4L14.2 11.6A2 2 0 0 1 18.2 11.6L18.6 12.8L19 12A2 2 0 0 1 23 12L23.4 13.2L23.8 13.4A1.8 1.8 0 0 1 27.4 13.4V20C27.4 25 25 27.6 21 27.6H15.6C12.8 27.6 11.2 26.4 10 24.4L6.4 20.4C5.2 19 5.4 16.8 7.2 16C8 15.6 8.9 15.4 9.6 15.2Z";

type Point = readonly [number, number];

/** A closed polygon path, optionally rotated about (12, 12). */
function polygon(points: ReadonlyArray<Point>, degrees = 0) {
  const rad = (degrees * Math.PI) / 180;
  const [cos, sin] = [Math.cos(rad), Math.sin(rad)];
  const round = (n: number) => Math.round(n * 10) / 10;
  return (
    points
      .map(([x, y], i) => {
        const [dx, dy] = [x - 12, y - 12];
        return `${i ? "L" : "M"}${round(12 + dx * cos - dy * sin)} ${round(12 + dx * sin + dy * cos)}`;
      })
      .join("") + "Z"
  );
}

/** The arrow's tip is (4, 3); the small arrows on progress, help and copy share it. */
const ARROW = "M4 3L4 19L8.4 14.9L14.6 14.6Z";
const ARROW_SMALL = "M4 3L4 16.5L7.4 13.4L12.2 13.2Z";

const DOUBLE_ARROW: ReadonlyArray<Point> = [
  [3, 12],
  [7.5, 7.5],
  [7.5, 10.4],
  [16.5, 10.4],
  [16.5, 7.5],
  [21, 12],
  [16.5, 16.5],
  [16.5, 13.6],
  [7.5, 13.6],
  [7.5, 16.5],
];

const MOVE =
  "M12 3L15.2 6.6H13.2V10.8H17.4V8.8L21 12L17.4 15.2V13.2H13.2V17.4H15.2L12 21L8.8 17.4H10.8V13.2H6.6V15.2L3 12L6.6 8.8V10.8H10.8V6.6H8.8Z";

const HOURGLASS =
  "M7 4H17V6.5C17 9 14.2 10.6 12 12C14.2 13.4 17 15 17 17.5V20H7V17.5C7 15 9.8 13.4 12 12C9.8 10.6 7 9 7 6.5Z";

const circle = (cx: number, cy: number, r: number) =>
  `M${cx} ${cy - r}A${r} ${r} 0 1 0 ${cx} ${cy + r}A${r} ${r} 0 1 0 ${cx} ${cy - r}Z`;

/**
 * One inked stroke. Every layer gets a white outline under the ink pass; `halo: false` marks a
 * detail drawn over a filled shape, which is inked in white instead.
 */
interface Layer {
  readonly d: string;
  /** Ink stroke width in viewBox units. */
  readonly width: number;
  readonly fill?: string;
  readonly halo?: boolean;
  /** How far the white outline reaches past the ink edge; defaults to half the ink width. */
  readonly outline?: number;
}

interface Frame {
  /** viewBox `[x, y, width, height]`; shapes are drawn in these units. */
  readonly box: readonly [number, number, number, number];
  /** Rendered width in CSS px; the height follows the box's aspect ratio. */
  readonly size: number;
  /** The click point in viewBox units. */
  readonly hotspot: Point;
  readonly fallback: string;
}

function cursor(frame: Frame, layers: ReadonlyArray<Layer>) {
  const [bx, by, bw, bh] = frame.box;
  const px = frame.size / bw;
  const height = Math.round(bh * px);
  const wobble = 'filter="url(#w)"';
  const stroke = (color: string, width: number) =>
    `stroke="${color}" stroke-linecap="round" stroke-linejoin="round" stroke-width="${width}"`;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${frame.size}" height="${height}" viewBox="${frame.box.join(" ")}">` +
    `<filter id="w" x="-20%" y="-20%" width="140%" height="140%">` +
    `<feTurbulence type="fractalNoise" baseFrequency="${+(0.07 * px).toFixed(4)}" numOctaves="1" seed="3"/>` +
    `<feDisplacementMap in="SourceGraphic" scale="${+(1.3 / px).toFixed(2)}" xChannelSelector="R" yChannelSelector="G"/></filter>` +
    `<filter id="s" x="-30%" y="-30%" width="160%" height="160%">` +
    `<feDropShadow dx="0" dy="${+(0.8 / px).toFixed(2)}" stdDeviation="${+(0.7 / px).toFixed(2)}" flood-color="#000" flood-opacity="0.35"/></filter>` +
    `<g filter="url(#s)">` +
    layers
      .filter((l) => l.halo !== false)
      .map(
        (l) =>
          `<path d="${l.d}" fill="none" ${wobble} ${stroke("#fff", l.width + 2 * (l.outline ?? l.width / 2))}/>`,
      )
      .join("") +
    layers
      .map(
        (l) =>
          `<path d="${l.d}" fill="${l.fill ?? "none"}" ${wobble} ${stroke(l.halo === false ? "#fff" : INK, l.width)}/>`,
      )
      .join("") +
    `</g></svg>`;
  const x = Math.round((frame.hotspot[0] - bx) * px);
  const y = Math.round((frame.hotspot[1] - by) * px);
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${x} ${y}, ${frame.fallback}`;
}

const unit = (hotspot: Point, fallback: string): Frame => ({
  box: [0, 0, 24, 24],
  size: 24,
  hotspot,
  fallback,
});
const CENTER: Point = [12, 12];

const CURSORS: Record<string, string> = {
  arrow: cursor(unit([4, 3], "default"), [{ d: ARROW, fill: INK, width: 1.5 }]),
  // The hands are thin-inked with a wide outline, so the notches between fingers show white.
  pointer: cursor({ box: [1, 2, 30, 30], size: 24, hotspot: [12.8, 5.5], fallback: "pointer" }, [
    { d: HAND_POINTER, fill: INK, width: 0.6, outline: 1 },
  ]),
  grab: cursor({ box: [1, 2, 30, 30], size: 24, hotspot: [19, 18], fallback: "grab" }, [
    { d: OPEN_HAND, fill: INK, width: 0.6, outline: 1 },
  ]),
  grabbing: cursor({ box: [3, 3, 30, 30], size: 24, hotspot: [18, 17], fallback: "grabbing" }, [
    { d: CLOSED_HAND, fill: INK, width: 0.6, outline: 1 },
  ]),
  // The comment tool's cursor is the draft pin, so the bubble you place lands where its tail tip is.
  comment: cursor({ box: [-2, -1, 44, 40], size: 28, hotspot: [3, 34], fallback: "crosshair" }, [
    { d: PIN_PATH, fill: INK, width: 2.5 },
  ]),
  text: cursor(unit(CENTER, "text"), [{ d: "M8.5 4H15.5M12 4V20M8.5 20H15.5", width: 1.5 }]),
  crosshair: cursor(unit(CENTER, "crosshair"), [
    { d: "M12 3V9M12 15V21M3 12H9M15 12H21", width: 1.5 },
    { d: "M12 12H12.01", width: 1.5 },
  ]),
  "not-allowed": cursor(unit(CENTER, "not-allowed"), [
    { d: circle(12, 12, 7.5), fill: INK, width: 1.6 },
    { d: "M6.7 6.7L17.3 17.3", width: 1.6, halo: false },
  ]),
  wait: cursor(unit(CENTER, "wait"), [
    { d: HOURGLASS, fill: INK, width: 1.5 },
    { d: "M9.6 17.6H14.4", width: 1.5, halo: false },
  ]),
  progress: cursor(unit([4, 3], "progress"), [
    { d: ARROW_SMALL, fill: INK, width: 1.5 },
    { d: circle(16.5, 16.5, 4.5), fill: INK, width: 1.5 },
    { d: "M16.5 13.9V16.5H18.5", width: 1.4, halo: false },
  ]),
  help: cursor(unit([4, 3], "help"), [
    { d: ARROW_SMALL, fill: INK, width: 1.5 },
    {
      d: "M13.6 11.6C13.8 9.2 18.6 9.2 18.6 12.1C18.6 14 16.2 14.2 16.2 16.2M16.2 19.6H16.21",
      width: 1.6,
    },
  ]),
  move: cursor(unit(CENTER, "move"), [{ d: MOVE, fill: INK, width: 1.4 }]),
  "zoom-in": cursor(unit([10, 10], "zoom-in"), [
    { d: "M14.6 14.6L20 20", width: 2.2 },
    { d: circle(10, 10, 6), fill: INK, width: 1.5 },
    { d: "M7.2 10H12.8M10 7.2V12.8", width: 1.4, halo: false },
  ]),
  "zoom-out": cursor(unit([10, 10], "zoom-out"), [
    { d: "M14.6 14.6L20 20", width: 2.2 },
    { d: circle(10, 10, 6), fill: INK, width: 1.5 },
    { d: "M7.2 10H12.8", width: 1.4, halo: false },
  ]),
  "resize-ew": cursor(unit(CENTER, "ew-resize"), [
    { d: polygon(DOUBLE_ARROW), fill: INK, width: 1.4 },
  ]),
  "resize-ns": cursor(unit(CENTER, "ns-resize"), [
    { d: polygon(DOUBLE_ARROW, 90), fill: INK, width: 1.4 },
  ]),
  "resize-nwse": cursor(unit(CENTER, "nwse-resize"), [
    { d: polygon(DOUBLE_ARROW, 45), fill: INK, width: 1.4 },
  ]),
  "resize-nesw": cursor(unit(CENTER, "nesw-resize"), [
    { d: polygon(DOUBLE_ARROW, -45), fill: INK, width: 1.4 },
  ]),
  copy: cursor(unit([4, 3], "copy"), [
    { d: ARROW_SMALL, fill: INK, width: 1.5 },
    { d: "M13 13H21V21H13Z", fill: INK, width: 1.4 },
    { d: "M17 15V19M15 17H19", width: 1.3, halo: false },
  ]),
};

/**
 * `:root { --cursor-arrow: …; }` for every cursor, plus global rules so the browser's own cursors
 * never show. The rules are :where() wrapped (zero specificity), so a component's `cursor:` wins.
 */
export const CURSOR_CSS =
  `:root{${Object.entries(CURSORS)
    .map(([name, value]) => `--cursor-${name}:${value}`)
    .join(";")}}` +
  `@layer cursor-defaults,priority1,priority2,priority3,priority4,priority5;` +
  `@layer cursor-defaults{` +
  `:where(html,body){cursor:var(--cursor-arrow)}` +
  `:where(button,[role=button],a[href],summary,select,label,input[type=checkbox],input[type=radio],input[type=submit],input[type=button]){cursor:var(--cursor-pointer)}` +
  `:where(input:not([type=checkbox]):not([type=radio]):not([type=submit]):not([type=button]),textarea,[contenteditable=true]){cursor:var(--cursor-text)}` +
  `:where(:disabled,[aria-disabled=true]){cursor:var(--cursor-not-allowed)}` +
  `}`;
