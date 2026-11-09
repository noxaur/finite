import type { Measurement } from "./measure.ts";
import type { Rect } from "./model.ts";

/** The drawing's one literal for the purple. `colors.measure` in the web tokens must equal it. */
export const MEASURE_PURPLE = "#8b3ff0";
const MEASURE_ON = "#f8f9f9";

type Point = { x: number; y: number };
type Side = "top" | "right" | "bottom" | "left";

export type Figure =
  /** Everything about one element. */
  | { target: Measurement }
  /** Two elements in one frame: outlines, sizes and the distance between them. */
  | { target: Measurement; other: Measurement };

export type Distance = {
  relation: "apart" | "inside" | "overlap";
  /** Apart: one line per separated axis. Inside: four, inner edge to outer edge. Overlap: none. */
  lines: { side: Side; size: number; from: Point; to: Point }[];
};

const round = (n: number) => Math.round(n * 100) / 100;
const point = (x: number, y: number): Point => ({ x: round(x), y: round(y) });

export function distanceBetween(a: Rect, b: Rect): Distance {
  const box = (r: Rect) => ({
    top: r.y,
    right: r.x + r.width,
    bottom: r.y + r.height,
    left: r.x,
    cx: r.x + r.width / 2,
    cy: r.y + r.height / 2,
  });
  const p = box(a);
  const q = box(b);
  const line = (side: Side, from: Point, to: Point) => ({
    side,
    size: round(Math.abs(to.x - from.x) + Math.abs(to.y - from.y)),
    from,
    to,
  });

  const contains = (o: typeof p, i: typeof p) =>
    i.left >= o.left && i.right <= o.right && i.top >= o.top && i.bottom <= o.bottom;
  if (contains(p, q) || contains(q, p)) {
    const [inner, outer] = contains(q, p) ? [p, q] : [q, p];
    return {
      relation: "inside",
      lines: [
        line("top", point(inner.cx, inner.top), point(inner.cx, outer.top)),
        line("right", point(inner.right, inner.cy), point(outer.right, inner.cy)),
        line("bottom", point(inner.cx, inner.bottom), point(inner.cx, outer.bottom)),
        line("left", point(inner.left, inner.cy), point(outer.left, inner.cy)),
      ],
    };
  }

  const lines: Distance["lines"] = [];
  const midY = (Math.max(p.top, q.top) + Math.min(p.bottom, q.bottom)) / 2;
  const midX = (Math.max(p.left, q.left) + Math.min(p.right, q.right)) / 2;
  const overlapY = p.top < q.bottom && q.top < p.bottom;
  const overlapX = p.left < q.right && q.left < p.right;
  // Diagonal neighbours get an L: the x line leaves a's middle, the y line arrives at b's.
  const y = overlapY ? midY : p.cy;
  const x = overlapX ? midX : q.cx;
  if (p.right <= q.left) lines.push(line("right", point(p.right, y), point(q.left, y)));
  else if (q.right <= p.left) lines.push(line("left", point(p.left, y), point(q.right, y)));
  if (p.bottom <= q.top) lines.push(line("bottom", point(x, p.bottom), point(x, q.top)));
  else if (q.bottom <= p.top) lines.push(line("top", point(x, p.top), point(x, q.bottom)));
  return { relation: lines.length > 0 ? "apart" : "overlap", lines };
}

/**
 * The whole drawing as markup in frame CSS pixels, positioned from a zero-size root at the frame's
 * origin. `zoom` (screen pixels per CSS pixel) only decides which pills fit; screen-constant sizes
 * use the camera's `--inv-zoom`, so a pinch doesn't redraw between steps. `hidden` counts the pills
 * dropped here; their numbers are still in the Measurement.
 */
export function drawFigure(figure: Figure, zoom: number): { html: string; hidden: number } {
  const { marks, hidden } = placePills(annotate(figure), zoom);
  return { html: paint(marks), hidden };
}

/** The variables a host outside the web app declares on the figure's root. */
export function figureRootCss(zoom: number): string {
  return `--inv-zoom:${1 / zoom};--measure:${MEASURE_PURPLE};--measure-on:${MEASURE_ON};`;
}

type Pill = {
  at: Point;
  /** Screen pixels added to `at`. */
  screenOffset?: Point;
  text: string;
  /** Thickness of the band this labels, in frame pixels. */
  band?: number;
  /** The axis `placePills` may nudge along. */
  normal?: Point;
};

type Mark =
  | { kind: "band"; rect: Rect; tone: "padding" | "margin"; side: Side }
  | { kind: "gap"; rect: Rect; axis: "x" | "y" }
  | { kind: "outline"; rect: Rect; tone: "target" | "child" | "other"; radius?: Corners }
  | { kind: "line"; from: Point; to: Point }
  | ({ kind: "pill" } & Pill);

type Corners = Measurement["radius"];

const NORMAL_X: Point = { x: 1, y: 0 };
const NORMAL_Y: Point = { x: 0, y: 1 };
const SIZE_PILL_DROP = 14;
const RADIUS_PILL_LIFT = 12;

const num = (n: number) => String(round(n));
const pillWidth = (text: string) => text.length * PILL.charWidth + PILL.padding;
const centre = (r: Rect): Point => point(r.x + r.width / 2, r.y + r.height / 2);
const sizeText = (r: Rect) => `${num(r.width)} × ${num(r.height)}`;

function sizePill(box: Rect): Mark {
  return {
    kind: "pill",
    at: point(box.x + box.width / 2, box.y + box.height),
    screenOffset: { x: 0, y: SIZE_PILL_DROP },
    text: sizeText(box),
  };
}

/** The sides that get a pill: all equal is one, opposite equal is two, otherwise four. */
function pillSides(e: Measurement["padding"]): Side[] {
  const sides: Side[] =
    e.top === e.right && e.top === e.bottom && e.top === e.left
      ? ["top"]
      : e.top === e.bottom && e.left === e.right
        ? ["top", "left"]
        : ["top", "right", "bottom", "left"];
  return sides.filter((side) => e[side] > 0);
}

function bandMarks(
  rects: Record<Side, Rect>,
  edges: Measurement["padding"],
  tone: "padding" | "margin",
): Mark[] {
  const sides = ["top", "right", "bottom", "left"] as const;
  const bands: Mark[] = sides
    .filter((side) => edges[side] > 0)
    .map((side) => ({ kind: "band", rect: rects[side], tone, side }));
  const pills: Mark[] = pillSides(edges).map((side) => ({
    kind: "pill",
    at: centre(rects[side]),
    text: num(edges[side]),
    band: edges[side],
    normal: side === "top" || side === "bottom" ? NORMAL_Y : NORMAL_X,
  }));
  return [...bands, ...pills];
}

/**
 * What appears, for both the person and the PNG. Pills come out in priority order, so a new
 * annotation's rank is where it's written here. `paint` draws them over everything else.
 */
export function annotate(figure: Figure): Mark[] {
  const { target } = figure;
  const { box } = target;
  if ("other" in figure) {
    const { other } = figure;
    const marks: Mark[] = [
      { kind: "outline", rect: box, tone: "target", radius: target.radius },
      { kind: "outline", rect: other.box, tone: "other", radius: other.radius },
    ];
    for (const { from, to, size, side } of distanceBetween(box, other.box).lines) {
      if (size <= 0) continue;
      marks.push(
        { kind: "line", from, to },
        {
          kind: "pill",
          at: point((from.x + to.x) / 2, (from.y + to.y) / 2),
          text: num(size),
          normal: side === "top" || side === "bottom" ? NORMAL_X : NORMAL_Y,
        },
      );
    }
    // After the distances: when the two are close, the distance is the number to keep.
    marks.push(sizePill(box), sizePill(other.box));
    return marks;
  }

  const outline: Mark = { kind: "outline", rect: box, tone: "target", radius: target.radius };
  if (!target.axisAligned) return [outline, sizePill(box)];

  const marks: Mark[] = [sizePill(box)];

  const { topLeft, topRight, bottomRight, bottomLeft } = target.radius;
  if (Math.max(topLeft, topRight, bottomRight, bottomLeft) > 0) {
    const uniform = topLeft === topRight && topLeft === bottomRight && topLeft === bottomLeft;
    const text = uniform
      ? `r ${num(topLeft)}`
      : `r ${num(topLeft)} ${num(topRight)} ${num(bottomRight)} ${num(bottomLeft)}`;
    marks.push({
      kind: "pill",
      at: point(box.x, box.y),
      screenOffset: { x: pillWidth(text) / 2, y: -RADIUS_PILL_LIFT },
      text,
    });
  }

  for (const gap of target.gaps) {
    if (gap.size < 1) continue;
    marks.push(
      { kind: "gap", rect: gap.rect, axis: gap.axis },
      {
        kind: "pill",
        at: centre(gap.rect),
        text: num(gap.size),
        band: gap.size,
        normal: gap.axis === "x" ? NORMAL_X : NORMAL_Y,
      },
    );
  }

  const { padding: p, border: b, margin: m } = target;
  const inner: Rect = {
    x: box.x + b.left,
    y: box.y + b.top,
    width: box.width - b.left - b.right,
    height: box.height - b.top - b.bottom,
  };
  marks.push(
    ...bandMarks(
      {
        top: { x: inner.x, y: inner.y, width: inner.width, height: p.top },
        right: {
          x: inner.x + inner.width - p.right,
          y: inner.y + p.top,
          width: p.right,
          height: inner.height - p.top - p.bottom,
        },
        bottom: {
          x: inner.x,
          y: inner.y + inner.height - p.bottom,
          width: inner.width,
          height: p.bottom,
        },
        left: {
          x: inner.x,
          y: inner.y + p.top,
          width: p.left,
          height: inner.height - p.top - p.bottom,
        },
      },
      p,
      "padding",
    ),
  );

  const left = Math.max(m.left, 0);
  const right = Math.max(m.right, 0);
  marks.push(
    ...bandMarks(
      {
        top: { x: box.x - left, y: box.y - m.top, width: box.width + left + right, height: m.top },
        right: { x: box.x + box.width, y: box.y, width: m.right, height: box.height },
        bottom: {
          x: box.x - left,
          y: box.y + box.height,
          width: box.width + left + right,
          height: m.bottom,
        },
        left: { x: box.x - m.left, y: box.y, width: m.left, height: box.height },
      },
      m,
      "margin",
    ),
  );

  for (const child of target.children) {
    marks.push(
      { kind: "outline", rect: child.rect, tone: "child" },
      { kind: "pill", at: centre(child.rect), text: sizeText(child.rect) },
    );
  }
  marks.push(outline);
  return marks;
}

const PILL = { height: 16, charWidth: 6.6, padding: 10, clearance: 2 } as const;
/** Below this many screen pixels a band can't carry its label. */
const MIN_BAND = 3;

type Footprint = { x: number; y: number; halfW: number; halfH: number };

const hits = (a: Footprint, b: Footprint) =>
  Math.abs(a.x - b.x) < a.halfW + b.halfW && Math.abs(a.y - b.y) < a.halfH + b.halfH;

/**
 * Greedy label placement. Each pill, in priority order, is kept only if it hits no pill already
 * kept, at its centre or nudged along its band's normal, so tiny bands and low zoom shed the least
 * important numbers first.
 */
export function placePills(
  marks: readonly Mark[],
  zoom: number,
): { marks: Mark[]; hidden: number } {
  const kept: Footprint[] = [];
  const placed: Mark[] = [];
  let hidden = 0;
  for (const mark of marks) {
    if (mark.kind !== "pill") {
      placed.push(mark);
      continue;
    }
    if (mark.band !== undefined && mark.band * zoom < MIN_BAND) {
      hidden++;
      continue;
    }
    const width = pillWidth(mark.text);
    const footprint = (offset: Point): Footprint => ({
      x: mark.at.x + offset.x / zoom,
      y: mark.at.y + offset.y / zoom,
      halfW: (width + PILL.clearance) / 2 / zoom,
      halfH: (PILL.height + PILL.clearance) / 2 / zoom,
    });
    const base = mark.screenOffset ?? { x: 0, y: 0 };
    const offsets = [base];
    if (mark.normal) {
      const step = mark.normal.x * width + mark.normal.y * PILL.height + PILL.clearance;
      for (const sign of [1, -1]) {
        offsets.push({
          x: base.x + sign * mark.normal.x * step,
          y: base.y + sign * mark.normal.y * step,
        });
      }
    }
    const free = offsets.find((offset) => {
      const box = footprint(offset);
      return !kept.some((other) => hits(box, other));
    });
    if (!free) {
      hidden++;
      continue;
    }
    kept.push(footprint(free));
    placed.push({ ...mark, screenOffset: free });
  }
  return { marks: placed, hidden };
}

const screen = (px: number) => `calc(${px}px * var(--inv-zoom, 1))`;
const mix = (percent: number) => `color-mix(in srgb, var(--measure) ${percent}%, transparent)`;
const boxCss = (r: Rect) =>
  `position:absolute;box-sizing:border-box;left:${r.x}px;top:${r.y}px;width:${r.width}px;height:${r.height}px;`;
const hatch =
  `repeating-linear-gradient(135deg, var(--measure) 0 ${screen(1.5)}, ` +
  `transparent 0 ${screen(6)})`;

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function paintMark(mark: Exclude<Mark, { kind: "pill" }>): string {
  switch (mark.kind) {
    case "band": {
      const edge =
        mark.tone === "margin" ? `border-${mark.side}:${screen(1)} dashed var(--measure);` : "";
      const wash = mix(mark.tone === "margin" ? 10 : 18);
      return `<div style="${boxCss(mark.rect)}background:${wash};${edge}"></div>`;
    }
    case "gap": {
      const tick =
        mark.axis === "x"
          ? `left:0;right:0;top:50%;height:${screen(1)};transform:translateY(-50%);`
          : `top:0;bottom:0;left:50%;width:${screen(1)};transform:translateX(-50%);`;
      return (
        `<div style="${boxCss(mark.rect)}background:${hatch},${mix(12)};">` +
        `<div style="position:absolute;${tick}background:var(--measure);"></div></div>`
      );
    }
    case "outline": {
      const r = mark.radius;
      const corners = r
        ? `border-radius:${r.topLeft}px ${r.topRight}px ${r.bottomRight}px ${r.bottomLeft}px;`
        : "";
      const opacity = mark.tone === "child" ? "opacity:0.6;" : "";
      return `<div style="${boxCss(mark.rect)}outline:${screen(1)} solid var(--measure);${corners}${opacity}"></div>`;
    }
    case "line": {
      const across = mark.from.y === mark.to.y;
      const x = Math.min(mark.from.x, mark.to.x);
      const y = Math.min(mark.from.y, mark.to.y);
      const length = Math.abs(mark.to.x - mark.from.x) + Math.abs(mark.to.y - mark.from.y);
      const rule = across
        ? `left:${x}px;top:${y}px;width:${length}px;height:${screen(1)};transform:translateY(-50%);`
        : `left:${x}px;top:${y}px;height:${length}px;width:${screen(1)};transform:translateX(-50%);`;
      const capShape = across
        ? `top:50%;width:${screen(1)};height:${screen(7)};transform:translateY(-50%);`
        : `left:50%;height:${screen(1)};width:${screen(7)};transform:translateX(-50%);`;
      const cap = (end: string) =>
        `<div style="position:absolute;${end}${capShape}background:var(--measure);"></div>`;
      return (
        `<div style="position:absolute;${rule}background:var(--measure);">` +
        cap(across ? "left:0;" : "top:0;") +
        cap(across ? "right:0;" : "bottom:0;") +
        `</div>`
      );
    }
  }
}

function paintPill(pill: Pill): string {
  const offset = pill.screenOffset ?? { x: 0, y: 0 };
  return (
    `<div style="position:absolute;left:${pill.at.x}px;top:${pill.at.y}px;` +
    `transform-origin:0 0;transform:scale(var(--inv-zoom, 1)) ` +
    `translate(calc(-50% + ${offset.x}px), calc(-50% + ${offset.y}px));` +
    `height:${PILL.height}px;padding:0 ${PILL.padding / 2}px;border-radius:3px;white-space:nowrap;` +
    `background:var(--measure);color:var(--measure-on);box-shadow:0 0 0 1px var(--measure-on);` +
    `font:500 11px/${PILL.height}px ui-monospace, SFMono-Regular, Menlo, monospace;` +
    `font-variant-numeric:tabular-nums;">${escapeHtml(pill.text)}</div>`
  );
}

/** Marks to markup: axis-aligned divs in the order given, with every pill on top. */
export function paint(marks: readonly Mark[]): string {
  let shapes = "";
  let pills = "";
  for (const mark of marks) {
    if (mark.kind === "pill") pills += paintPill(mark);
    else shapes += paintMark(mark);
  }
  return shapes + pills;
}
