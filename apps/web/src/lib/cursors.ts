/** Hand-inked cursors from the "Finite icons" artboard, as CSS custom properties on :root. */

const INK = "#1a1a18";

/** The speech-bubble outline every pin is drawn from, tail tip at (3, 34). */
export const PIN_PATH =
  "M3 34C5 31 7 28 8 25C4 22 2 18 2 14C2 7 10 2 20 2C30 2 38 7 38 14C38 22 30 27 20 27C17 27 15 27 13 26C10 30 6 33 3 34Z";

const ARROW = "M5 3 L5 24 L11.5 17.5 L21.5 17 Z";
const POINTER =
  "M10.5 19V4.5A2.5 2.5 0 0 1 15.5 4.5V12.5A1.75 1.75 0 0 1 19 12.5V13A1.75 1.75 0 0 1 22.5 13.5A1.75 1.75 0 0 1 26 15V22C26 26.5 23.5 29 19.5 29H17C14 29 12.5 27.5 11 25.5L6.5 20.5C5.5 19.2 6 17.5 7.5 17.5C8.5 17.5 9.5 18 10.5 19Z";
const OPEN_HAND =
  "M16 23V12A2.75 2.75 0 0 1 21.5 12V9.5A2.75 2.75 0 0 1 27 9.5V11A2.75 2.75 0 0 1 32.5 11V15A2.25 2.25 0 0 1 37 15V29C37 37 34.5 41.5 28.5 41.5H24.5C20.5 41.5 18 39.5 16 36.5L10.5 29A2.75 2.75 0 0 1 14.5 25.5L16 26.5Z";
const CLOSED_HAND =
  "M13 18.5C13 12 19 12 19 17C19 11.5 25 11.5 25 17C25 11.5 31 11.5 31 17C31 12.5 37 12.5 37 18L37.5 30C37.5 35 34.5 38 30 38L20 38C16 38 14 36 13 32.5L10.5 26.5C9.5 23.5 11.5 21.5 13.5 22.5Z";

interface Shape {
  readonly d: string;
  readonly fill: string;
  readonly width: number;
  readonly dash?: string;
}

/** A shape with its white halo; `details` are inner strokes in ink. */
function inked(
  viewBox: string,
  shape: Shape,
  details: ReadonlyArray<{ d: string; width: number }> = [],
) {
  const wobble = 'filter="url(#w)"';
  const dash = shape.dash ? ` stroke-dasharray="${shape.dash}"` : "";
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="${viewBox}">` +
    `<filter id="w" x="-20%" y="-20%" width="140%" height="140%">` +
    `<feTurbulence type="fractalNoise" baseFrequency="0.045" numOctaves="1" seed="3"/>` +
    `<feDisplacementMap in="SourceGraphic" scale="3" xChannelSelector="R" yChannelSelector="G"/></filter>` +
    `<path d="${shape.d}" fill="none" ${wobble} stroke="#fff" stroke-linejoin="round" stroke-width="${shape.width * 2}"/>` +
    `<path d="${shape.d}" fill="${shape.fill}" ${wobble} stroke="${INK}" stroke-linecap="round" stroke-linejoin="round" stroke-width="${shape.width}"${dash}/>` +
    details
      .map(
        (s) =>
          `<path d="${s.d}" fill="none" ${wobble} stroke="${INK}" stroke-linecap="round" stroke-width="${s.width}"/>`,
      )
      .join("") +
    `</svg>`
  );
}

function cursor(svg: string, x: number, y: number, fallback: string) {
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${x} ${y}, ${fallback}`;
}

const CURSORS: Record<string, string> = {
  arrow: cursor(
    inked("-2 -1.75 30.5 30.5", { d: ARROW, fill: "#fff", width: 2.4 }),
    7,
    5,
    "default",
  ),
  pointer: cursor(
    inked("-2 -2.5 36 36", { d: POINTER, fill: "#fff", width: 2.8 }, [
      { d: "M15.5 13V16M19 13.5V16M22.5 14V16.5", width: 2.25 },
    ]),
    13,
    4,
    "pointer",
  ),
  grab: cursor(
    inked("0.5 1 46 46", { d: OPEN_HAND, fill: "#fff", width: 3.6 }, [
      { d: "M21.5 12.5V21M27 11.5V21M32.5 15.5V21", width: 2.9 },
    ]),
    18,
    20,
    "grab",
  ),
  grabbing: cursor(
    inked("3 4.5 42 42", { d: CLOSED_HAND, fill: "#fff", width: 3.3 }, [
      { d: "M19 17V20.5M25 17V20.5M31 17V20.5M13.5 22.5C16 24 19 24.5 22 24", width: 2.6 },
    ]),
    16,
    17,
    "grabbing",
  ),
  // The comment tool's cursor is the draft pin, so the bubble you place lands where its tail tip is.
  comment: cursor(
    inked("0 0 40 36", { d: PIN_PATH, fill: "#fff", width: 2.5, dash: "4 3" }),
    3,
    34,
    "crosshair",
  ),
};

/** `:root { --cursor-arrow: …; }` for every cursor, plus the rules that apply the default two. */
export const CURSOR_CSS =
  `:root{${Object.entries(CURSORS)
    .map(([name, value]) => `--cursor-${name}:${value}`)
    .join(";")}}` + `body{cursor:var(--cursor-arrow)}`;
