/**
 * Hand-inked cursors as CSS custom properties on :root. Each renders at 24px (the comment pin at 28)
 * with an ink stroke, a white halo and a small wobble filter, so they stay sharp and under 32px.
 */

const INK = "#1a1a18";

/** The speech-bubble outline every pin is drawn from, tail tip at (3, 34). */
export const PIN_PATH =
  "M3 34C5 31 7 28 8 25C4 22 2 18 2 14C2 7 10 2 20 2C30 2 38 7 38 14C38 22 30 27 20 27C17 27 15 27 13 26C10 30 6 33 3 34Z";

const HAND_POINTER =
  "M10.5 19V4.5A2.5 2.5 0 0 1 15.5 4.5V12.5A1.75 1.75 0 0 1 19 12.5V13A1.75 1.75 0 0 1 22.5 13.5A1.75 1.75 0 0 1 26 15V22C26 26.5 23.5 29 19.5 29H17C14 29 12.5 27.5 11 25.5L6.5 20.5C5.5 19.2 6 17.5 7.5 17.5C8.5 17.5 9.5 18 10.5 19Z";
const OPEN_HAND =
  "M16 23V12A2.75 2.75 0 0 1 21.5 12V9.5A2.75 2.75 0 0 1 27 9.5V11A2.75 2.75 0 0 1 32.5 11V15A2.25 2.25 0 0 1 37 15V29C37 37 34.5 41.5 28.5 41.5H24.5C20.5 41.5 18 39.5 16 36.5L10.5 29A2.75 2.75 0 0 1 14.5 25.5L16 26.5Z";
const CLOSED_HAND =
  "M13 18.5C13 12 19 12.5 19 17C19 11.5 25 11.5 25 17C25 11.5 31 11.5 31 17C31 12.5 37 12.5 37 18L37.5 30C37.5 35 34.5 38 30 38L20 38C16 38 14 36 13 32.5L10.5 26.5C9.5 23.5 11.5 21.5 13.5 22.5Z";

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

/** One inked stroke. Every layer gets a white halo (`halo: false` opts out) under the ink pass. */
interface Layer {
  readonly d: string;
  /** Ink stroke width in viewBox units. */
  readonly width: number;
  readonly fill?: string;
  readonly dash?: string;
  readonly halo?: boolean;
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
  const stroke = (l: Layer, color: string, width: number) =>
    `stroke="${color}" stroke-linecap="round" stroke-linejoin="round" stroke-width="${width}"` +
    (l.dash ? ` stroke-dasharray="${l.dash}"` : "");
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${frame.size}" height="${height}" viewBox="${frame.box.join(" ")}">` +
    `<filter id="w" x="-20%" y="-20%" width="140%" height="140%">` +
    `<feTurbulence type="fractalNoise" baseFrequency="${+(0.07 * px).toFixed(4)}" numOctaves="1" seed="3"/>` +
    `<feDisplacementMap in="SourceGraphic" scale="${+(1.3 / px).toFixed(2)}" xChannelSelector="R" yChannelSelector="G"/></filter>` +
    layers
      .filter((l) => l.halo !== false)
      .map((l) => `<path d="${l.d}" fill="none" ${wobble} ${stroke(l, "#fff", l.width * 2)}/>`)
      .join("") +
    layers
      .map(
        (l) => `<path d="${l.d}" fill="${l.fill ?? "none"}" ${wobble} ${stroke(l, INK, l.width)}/>`,
      )
      .join("") +
    `</svg>`;
  const x = Math.round((frame.hotspot[0] - bx) * px);
  const y = Math.round((frame.hotspot[1] - by) * px);
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${x} ${y}, ${frame.fallback}`;
}

const W = "#fff";
const unit = (hotspot: Point, fallback: string): Frame => ({
  box: [0, 0, 24, 24],
  size: 24,
  hotspot,
  fallback,
});
const CENTER: Point = [12, 12];

const CURSORS: Record<string, string> = {
  arrow: cursor(unit([4, 3], "default"), [{ d: ARROW, fill: W, width: 1.5 }]),
  pointer: cursor({ box: [0, -1, 32, 32], size: 24, hotspot: [13, 2], fallback: "pointer" }, [
    { d: HAND_POINTER, fill: W, width: 2.4 },
    { d: "M15.5 13V16M19 13.5V16M22.5 14V16.5", width: 2, halo: false },
  ]),
  grab: cursor({ box: [5, 3, 41, 41], size: 24, hotspot: [24, 26], fallback: "grab" }, [
    { d: OPEN_HAND, fill: W, width: 3 },
    { d: "M21.5 12.5V21M27 11.5V21M32.5 15.5V21", width: 2.5, halo: false },
  ]),
  grabbing: cursor({ box: [6, 7, 36, 36], size: 24, hotspot: [24, 25], fallback: "grabbing" }, [
    { d: CLOSED_HAND, fill: W, width: 2.9 },
    {
      d: "M19 17V20.5M25 17V20.5M31 17V20.5M13.5 22.5C16 24 19 24.5 22 24",
      width: 2.3,
      halo: false,
    },
  ]),
  // The comment tool's cursor is the draft pin, so the bubble you place lands where its tail tip is.
  comment: cursor({ box: [-2, -1, 44, 40], size: 28, hotspot: [3, 34], fallback: "crosshair" }, [
    { d: PIN_PATH, fill: W, width: 2.5, dash: "4 3" },
  ]),
  text: cursor(unit(CENTER, "text"), [{ d: "M8.5 4H15.5M12 4V20M8.5 20H15.5", width: 1.5 }]),
  crosshair: cursor(unit(CENTER, "crosshair"), [
    { d: "M12 3V9M12 15V21M3 12H9M15 12H21", width: 1.5 },
    { d: "M12 12H12.01", width: 1.5, halo: false },
  ]),
  "not-allowed": cursor(unit(CENTER, "not-allowed"), [
    { d: circle(12, 12, 7.5), fill: W, width: 1.6 },
    { d: "M6.7 6.7L17.3 17.3", width: 1.6, halo: false },
  ]),
  wait: cursor(unit(CENTER, "wait"), [
    { d: HOURGLASS, fill: W, width: 1.5 },
    { d: "M9.6 17.6H14.4", width: 1.5, halo: false },
  ]),
  progress: cursor(unit([4, 3], "progress"), [
    { d: ARROW_SMALL, fill: W, width: 1.5 },
    { d: circle(16.5, 16.5, 4.5), fill: W, width: 1.5 },
    { d: "M16.5 13.9V16.5H18.5", width: 1.4, halo: false },
  ]),
  help: cursor(unit([4, 3], "help"), [
    { d: ARROW_SMALL, fill: W, width: 1.5 },
    {
      d: "M13.6 11.6C13.8 9.2 18.6 9.2 18.6 12.1C18.6 14 16.2 14.2 16.2 16.2M16.2 19.6H16.21",
      width: 1.6,
    },
  ]),
  move: cursor(unit(CENTER, "move"), [{ d: MOVE, fill: W, width: 1.4 }]),
  "zoom-in": cursor(unit([10, 10], "zoom-in"), [
    { d: "M14.6 14.6L20 20", width: 2.2 },
    { d: circle(10, 10, 6), fill: W, width: 1.5 },
    { d: "M7.2 10H12.8M10 7.2V12.8", width: 1.4, halo: false },
  ]),
  "zoom-out": cursor(unit([10, 10], "zoom-out"), [
    { d: "M14.6 14.6L20 20", width: 2.2 },
    { d: circle(10, 10, 6), fill: W, width: 1.5 },
    { d: "M7.2 10H12.8", width: 1.4, halo: false },
  ]),
  "resize-ew": cursor(unit(CENTER, "ew-resize"), [
    { d: polygon(DOUBLE_ARROW), fill: W, width: 1.4 },
  ]),
  "resize-ns": cursor(unit(CENTER, "ns-resize"), [
    { d: polygon(DOUBLE_ARROW, 90), fill: W, width: 1.4 },
  ]),
  "resize-nwse": cursor(unit(CENTER, "nwse-resize"), [
    { d: polygon(DOUBLE_ARROW, 45), fill: W, width: 1.4 },
  ]),
  "resize-nesw": cursor(unit(CENTER, "nesw-resize"), [
    { d: polygon(DOUBLE_ARROW, -45), fill: W, width: 1.4 },
  ]),
  copy: cursor(unit([4, 3], "copy"), [
    { d: ARROW_SMALL, fill: W, width: 1.5 },
    { d: "M13 13H21V21H13Z", fill: W, width: 1.4 },
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
