import type { MeasuredGap, Measurement } from "./measure.ts";
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
  | { target: Measurement; other: Measurement }
  /** Everything under a rectangle of a frame, cut at the rectangle's edges. */
  | { area: Rect; elements: Measurement[] };

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
  /** Cuts every other non-pill mark at this rectangle. */
  | { kind: "clip"; rect: Rect }
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

/** The sides that get a pill among those `shown`: all equal is one, opposite equal is two, otherwise four. */
function pillSides(e: Measurement["padding"], shown: (side: Side) => boolean): Side[] {
  const first = (...group: Side[]) => group.filter(shown).slice(0, 1);
  const sides: Side[] =
    e.top === e.right && e.top === e.bottom && e.top === e.left
      ? first("top", "right", "bottom", "left")
      : e.top === e.bottom && e.left === e.right
        ? [...first("top", "bottom"), ...first("left", "right")]
        : (["top", "right", "bottom", "left"] as const).filter(shown);
  return sides.filter((side) => e[side] > 0);
}

/** The part of `r` inside `clip`, or `null` when they share no area. */
export function visiblePart(r: Rect, clip: Rect): Rect | null {
  const x = Math.max(r.x, clip.x);
  const y = Math.max(r.y, clip.y);
  const right = Math.min(r.x + r.width, clip.x + clip.width);
  const bottom = Math.min(r.y + r.height, clip.y + clip.height);
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
}

const within = (r: Rect, clip: Rect) =>
  r.x >= clip.x &&
  r.y >= clip.y &&
  r.x + r.width <= clip.x + clip.width &&
  r.y + r.height <= clip.y + clip.height;

function bandMarks(
  rects: Record<Side, Rect>,
  edges: Measurement["padding"],
  tone: "padding" | "margin",
  clip: Rect | undefined,
): Mark[] {
  const visible = (side: Side) => (clip ? visiblePart(rects[side], clip) : rects[side]);
  const sides = ["top", "right", "bottom", "left"] as const;
  const bands: Mark[] = sides
    .filter((side) => edges[side] > 0 && visible(side))
    .map((side) => ({ kind: "band", rect: rects[side], tone, side }));
  const pills: Mark[] = pillSides(edges, (side) => visible(side) !== null).map((side) => ({
    kind: "pill",
    at: centre(visible(side)!),
    text: num(edges[side]),
    band: edges[side],
    normal: side === "top" || side === "bottom" ? NORMAL_Y : NORMAL_X,
  }));
  return [...bands, ...pills];
}

/** The four padding bands, inside the border. */
function paddingRects({ box, border: b, padding: p }: Measurement): Record<Side, Rect> {
  const inner: Rect = {
    x: box.x + b.left,
    y: box.y + b.top,
    width: box.width - b.left - b.right,
    height: box.height - b.top - b.bottom,
  };
  return {
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
  };
}

function marginRects({ box, margin: m }: Measurement): Record<Side, Rect> {
  const left = Math.max(m.left, 0);
  const right = Math.max(m.right, 0);
  return {
    top: { x: box.x - left, y: box.y - m.top, width: box.width + left + right, height: m.top },
    right: { x: box.x + box.width, y: box.y, width: m.right, height: box.height },
    bottom: {
      x: box.x - left,
      y: box.y + box.height,
      width: box.width + left + right,
      height: m.bottom,
    },
    left: { x: box.x - m.left, y: box.y, width: m.left, height: box.height },
  };
}

/** One axis-aligned element's marks by kind. With `clip`, only what shows inside it. */
function elementMarks(target: Measurement, clip?: Rect) {
  const radius: Mark[] = [];
  const { box } = target;
  const { topLeft, topRight, bottomRight, bottomLeft } = target.radius;
  if (Math.max(topLeft, topRight, bottomRight, bottomLeft) > 0) {
    const uniform = topLeft === topRight && topLeft === bottomRight && topLeft === bottomLeft;
    const text = uniform
      ? `r ${num(topLeft)}`
      : `r ${num(topLeft)} ${num(topRight)} ${num(bottomRight)} ${num(bottomLeft)}`;
    radius.push({
      kind: "pill",
      at: point(box.x, box.y),
      screenOffset: { x: pillWidth(text) / 2, y: -RADIUS_PILL_LIFT },
      text,
    });
  }

  const gaps: Mark[] = [];
  for (const gap of target.gaps) {
    if (gap.size < 1) continue;
    const visible = clip ? visiblePart(gap.rect, clip) : gap.rect;
    if (!visible) continue;
    gaps.push(
      { kind: "gap", rect: gap.rect, axis: gap.axis },
      {
        kind: "pill",
        at: centre(visible),
        text: num(gap.size),
        band: gap.size,
        normal: gap.axis === "x" ? NORMAL_X : NORMAL_Y,
      },
    );
  }

  return {
    radius,
    gaps,
    padding: bandMarks(paddingRects(target), target.padding, "padding", clip),
    margin: bandMarks(marginRects(target), target.margin, "margin", clip),
  };
}

/** Pills out in the order the area's rules rank them; every shape sits under one clip. */
function annotateArea({ area, elements }: Extract<Figure, { area: Rect }>): Mark[] {
  const parts = elements.flatMap((el) => {
    if (!visiblePart(el.box, area)) return [];
    const inside = within(el.box, area);
    const marks = el.axisAligned ? elementMarks(el, area) : null;
    return [
      {
        gaps: marks?.gaps ?? [],
        padding: marks?.padding ?? [],
        margin: marks?.margin ?? [],
        outline: { kind: "outline", rect: el.box, tone: "child", radius: el.radius } as Mark,
        size: inside ? [sizePill(el.box)] : [],
        radius: inside ? (marks?.radius ?? []) : [],
      },
    ];
  });
  return [
    { kind: "clip", rect: area },
    sizePill(area),
    ...parts.flatMap((p) => p.gaps),
    ...parts.flatMap((p) => p.padding),
    ...parts.flatMap((p) => p.margin),
    ...parts.map((p) => p.outline),
    ...parts.flatMap((p) => p.size),
    ...parts.flatMap((p) => p.radius),
  ];
}

/** What an area shows of its elements' spacing: the gaps, and padding values with how many bands have each. */
export function areaSpacing({ area, elements }: Extract<Figure, { area: Rect }>): {
  gaps: MeasuredGap[];
  padding: { size: number; count: number }[];
} {
  const aligned = elements.filter((el) => el.axisAligned && visiblePart(el.box, area));
  const counts = new Map<number, number>();
  for (const el of aligned) {
    const rects = paddingRects(el);
    for (const side of ["top", "right", "bottom", "left"] as const) {
      const size = el.padding[side];
      if (size > 0 && visiblePart(rects[side], area)) counts.set(size, (counts.get(size) ?? 0) + 1);
    }
  }
  return {
    gaps: aligned.flatMap((el) => el.gaps.filter((gap) => visiblePart(gap.rect, area))),
    padding: [...counts].map(([size, count]) => ({ size, count })),
  };
}

/**
 * What appears, for both the person and the PNG. Pills come out in priority order, so a new
 * annotation's rank is where it's written here. `paint` draws them over everything else.
 */
export function annotate(figure: Figure): Mark[] {
  if ("area" in figure) return annotateArea(figure);
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

  const { radius, gaps, padding, margin } = elementMarks(target);
  const marks: Mark[] = [sizePill(box), ...radius, ...gaps, ...padding, ...margin];

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

function paintMark(mark: Exclude<Mark, { kind: "pill" } | { kind: "clip" }>): string {
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

/** The area's outline and its clip: an inner root at the frame's origin keeps marks in frame pixels. */
function paintClip(area: Rect, shapes: string): string {
  return (
    `<div style="${boxCss(area)}overflow:hidden;outline:${screen(1)} solid var(--measure);">` +
    `<div style="position:absolute;left:${-area.x}px;top:${-area.y}px;width:0;height:0;">${shapes}</div></div>`
  );
}

/** Marks to markup: axis-aligned divs in the order given, with every pill on top. */
export function paint(marks: readonly Mark[]): string {
  let shapes = "";
  let pills = "";
  let clip: Rect | null = null;
  for (const mark of marks) {
    if (mark.kind === "pill") pills += paintPill(mark);
    else if (mark.kind === "clip") clip = mark.rect;
    else shapes += paintMark(mark);
  }
  return (clip ? paintClip(clip, shapes) : shapes) + pills;
}
