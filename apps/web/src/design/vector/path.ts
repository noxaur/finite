import type { Rect } from "@finite/protocol";

export type Point = { x: number; y: number };

/** How an anchor's two handles move together: not at all, by angle, or by angle and length. */
export type HandleMode = "none" | "angle" | "mirror";

/** Handles are absolute, in the same coordinates as `p`. `null` means no handle. */
export type Anchor = { p: Point; in: Point | null; out: Point | null; mode: HandleMode };

export type SubPath = { anchors: Anchor[]; closed: boolean };

/** How close two points of a subpath count as one, as a fraction of its span. */
const SAME_POINT = 1e-6;
/** How far from opposite two handles can be and still count as mirrored: the sine of the angle. */
const COLLINEAR = 0.02;
const NUMBER = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/y;

const near = (a: Point, b: Point, within: number) =>
  Math.abs(a.x - b.x) <= within && Math.abs(a.y - b.y) <= within;

/** The wider of a subpath's two spans, control points included. */
function spanOf(s: SubPath): number {
  let left = Infinity;
  let right = -Infinity;
  let top = Infinity;
  let bottom = -Infinity;
  for (const a of s.anchors) {
    for (const p of [a.p, a.in, a.out]) {
      if (!p) continue;
      left = Math.min(left, p.x);
      right = Math.max(right, p.x);
      top = Math.min(top, p.y);
      bottom = Math.max(bottom, p.y);
    }
  }
  return left === Infinity ? 0 : Math.max(right - left, bottom - top);
}

/** The handle mode two handles show: collinear means mirrored, and equal length means by length too. */
export function deriveMode(a: Pick<Anchor, "p" | "in" | "out">): HandleMode {
  if (!a.in || !a.out) return "none";
  const ix = a.in.x - a.p.x;
  const iy = a.in.y - a.p.y;
  const ox = a.out.x - a.p.x;
  const oy = a.out.y - a.p.y;
  const li = Math.hypot(ix, iy);
  const lo = Math.hypot(ox, oy);
  if (li === 0 || lo === 0) return "none";
  const opposite = ix * ox + iy * oy < 0;
  if (!opposite || Math.abs(ix * oy - iy * ox) / (li * lo) > COLLINEAR) return "none";
  return Math.abs(li - lo) <= Math.max(0.02, Math.max(li, lo) * 0.01) ? "mirror" : "angle";
}

/** One `d` as subpaths of anchors. Arcs and quadratics become cubics. Throws on what isn't a path. */
export function parsePath(d: string): SubPath[] {
  const paths: SubPath[] = [];
  let i = 0;
  const skip = () => {
    while (i < d.length && /[\s,]/.test(d[i]!)) i++;
  };
  const more = () => {
    skip();
    return i < d.length && !/[a-zA-Z]/.test(d[i]!);
  };
  const number = () => {
    skip();
    NUMBER.lastIndex = i;
    const m = NUMBER.exec(d);
    if (!m) throw new Error(`Not a number at ${i}`);
    i += m[0].length;
    return Number(m[0]);
  };
  const flag = () => {
    skip();
    const c = d[i++];
    if (c !== "0" && c !== "1") throw new Error(`Not a flag at ${i - 1}`);
    return c === "1";
  };

  let cur: Point = { x: 0, y: 0 };
  let start = cur;
  let sub: SubPath | null = null;
  let lastCubic: Point | null = null;
  let lastQuad: Point | null = null;

  const open = () => {
    if (sub) return sub;
    sub = { anchors: [{ p: cur, in: null, out: null, mode: "none" }], closed: false };
    start = cur;
    paths.push(sub);
    return sub;
  };
  const line = (to: Point) => {
    open().anchors.push({ p: to, in: null, out: null, mode: "none" });
    cur = to;
  };
  const cubic = (c1: Point, c2: Point, to: Point) => {
    const anchors = open().anchors;
    anchors[anchors.length - 1]!.out = c1;
    anchors.push({ p: to, in: c2, out: null, mode: "none" });
    cur = to;
  };

  skip();
  while (i < d.length) {
    const command = d[i++]!;
    if (!/[MmLlHhVvCcSsQqTtAaZz]/.test(command)) throw new Error(`Unknown command ${command}`);
    const rel = command === command.toLowerCase();
    const point = (): Point => {
      const x = number();
      const y = number();
      return rel ? { x: cur.x + x, y: cur.y + y } : { x, y };
    };
    const type = command.toUpperCase();
    if (type === "Z") {
      if (sub) (sub as SubPath).closed = true;
      sub = null;
      cur = start;
      lastCubic = lastQuad = null;
      skip();
      continue;
    }
    let first = true;
    do {
      if (type === "M") {
        const to = point();
        if (first) {
          sub = null;
          cur = to;
          open();
        } else line(to);
      } else if (type === "L") line(point());
      else if (type === "H") {
        const x = number();
        line({ x: rel ? cur.x + x : x, y: cur.y });
      } else if (type === "V") {
        const y = number();
        line({ x: cur.x, y: rel ? cur.y + y : y });
      } else if (type === "C") {
        const c1 = point();
        const c2 = point();
        const to = point();
        cubic(c1, c2, to);
        lastCubic = c2;
      } else if (type === "S") {
        const c1: Point = lastCubic
          ? { x: 2 * cur.x - lastCubic.x, y: 2 * cur.y - lastCubic.y }
          : cur;
        const c2 = point();
        const to = point();
        cubic(c1, c2, to);
        lastCubic = c2;
      } else if (type === "Q" || type === "T") {
        const from = cur;
        const q: Point =
          type === "Q"
            ? point()
            : lastQuad
              ? { x: 2 * from.x - lastQuad.x, y: 2 * from.y - lastQuad.y }
              : from;
        const to = point();
        cubic(
          { x: from.x + (2 / 3) * (q.x - from.x), y: from.y + (2 / 3) * (q.y - from.y) },
          { x: to.x + (2 / 3) * (q.x - to.x), y: to.y + (2 / 3) * (q.y - to.y) },
          to,
        );
        lastQuad = q;
      } else {
        const rx = number();
        const ry = number();
        const rotation = number();
        const large = flag();
        const sweep = flag();
        const to = point();
        const from = cur;
        // The spec omits an arc only when its endpoints are identical.
        if (from.x !== to.x || from.y !== to.y) {
          for (const seg of arcToCubics(from, rx, ry, rotation, large, sweep, to)) {
            cubic(seg.c1, seg.c2, seg.to);
          }
        }
      }
      if (type !== "C" && type !== "S") lastCubic = null;
      if (type !== "Q" && type !== "T") lastQuad = null;
      first = false;
    } while (more());
    skip();
  }

  const kept: SubPath[] = [];
  for (const s of paths) {
    const within = spanOf(s) * SAME_POINT;
    const { anchors } = s;
    if (s.closed && anchors.length > 1 && near(anchors.at(-1)!.p, anchors[0]!.p, within)) {
      anchors[0]!.in = anchors.pop()!.in;
    }
    for (const a of anchors) {
      a.in = a.in && near(a.in, a.p, within) ? null : a.in;
      a.out = a.out && near(a.out, a.p, within) ? null : a.out;
      a.mode = deriveMode(a);
    }
    // One anchor is still a shape when it holds a curve from itself back to itself.
    if (anchors.length > 1 || anchors[0]?.in || anchors[0]?.out) kept.push(s);
  }
  return kept;
}

/** The SVG spec's conversion from endpoint to center parameterization, then cubics of up to 90°. */
function arcToCubics(
  from: Point,
  rx0: number,
  ry0: number,
  rotation: number,
  large: boolean,
  sweep: boolean,
  to: Point,
): Array<{ c1: Point; c2: Point; to: Point }> {
  let rx = Math.abs(rx0);
  let ry = Math.abs(ry0);
  if (rx === 0 || ry === 0)
    return [
      {
        c1: { x: from.x + (to.x - from.x) / 3, y: from.y + (to.y - from.y) / 3 },
        c2: { x: from.x + (2 * (to.x - from.x)) / 3, y: from.y + (2 * (to.y - from.y)) / 3 },
        to,
      },
    ];
  const phi = (rotation * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const dx = (from.x - to.x) / 2;
  const dy = (from.y - to.y) / 2;
  const x1 = cos * dx + sin * dy;
  const y1 = -sin * dx + cos * dy;
  const lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
  if (lambda > 1) {
    rx *= Math.sqrt(lambda);
    ry *= Math.sqrt(lambda);
  }
  const num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
  const den = rx * rx * y1 * y1 + ry * ry * x1 * x1;
  const k = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, num / den));
  const cx1 = (k * rx * y1) / ry;
  const cy1 = (-k * ry * x1) / rx;
  const cx = cos * cx1 - sin * cy1 + (from.x + to.x) / 2;
  const cy = sin * cx1 + cos * cy1 + (from.y + to.y) / 2;
  const angle = (ux: number, uy: number, vx: number, vy: number) =>
    Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const start = angle(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry);
  let delta = angle((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry);
  if (!sweep && delta > 0) delta -= 2 * Math.PI;
  else if (sweep && delta < 0) delta += 2 * Math.PI;
  const steps = Math.max(1, Math.ceil(Math.abs(delta) / (Math.PI / 2) - 1e-9));
  const step = delta / steps;
  const tan = (4 / 3) * Math.tan(step / 4);
  const at = (a: number, ox: number, oy: number): Point => {
    const x = rx * (Math.cos(a) + ox);
    const y = ry * (Math.sin(a) + oy);
    return { x: cx + cos * x - sin * y, y: cy + sin * x + cos * y };
  };
  const out: Array<{ c1: Point; c2: Point; to: Point }> = [];
  for (let n = 0; n < steps; n++) {
    const a = start + n * step;
    const b = a + step;
    out.push({
      c1: at(a, -tan * Math.sin(a), tan * Math.cos(a)),
      c2: at(b, tan * Math.sin(b), -tan * Math.cos(b)),
      to: n === steps - 1 ? to : at(b, 0, 0),
    });
  }
  return out;
}

type Print = (p: Point) => string;

/** Prints points to two decimals, or more on a subpath too small for two to hold its shape. */
function printerFor(span: number): Print {
  const places = span > 0 ? Math.max(2, Math.ceil(-Math.log10(span)) + 2) : 2;
  const factor = 10 ** Math.min(places, 12);
  const num = (v: number) => {
    const r = Math.round(v * factor) / factor;
    return Object.is(r, -0) ? "0" : String(r);
  };
  return (p) => `${num(p.x)} ${num(p.y)}`;
}

function segment(a: Anchor, b: Anchor, pair: Print): string {
  if (!a.out && !b.in) return `L${pair(b.p)}`;
  return `C${pair(a.out ?? a.p)} ${pair(b.in ?? b.p)} ${pair(b.p)}`;
}

/** Absolute M, L, C and Z. Each subpath picks its own decimals, so an edit can't round another. */
export function printPath(paths: readonly SubPath[]): string {
  return paths
    .map((s) => {
      const [head, ...rest] = s.anchors;
      if (!head) return "";
      const pair = printerFor(spanOf(s));
      let out = `M${pair(head.p)}`;
      let prev = head;
      for (const a of rest) {
        out += segment(prev, a, pair);
        prev = a;
      }
      if (!s.closed) return out;
      if (prev.out || head.in) out += segment(prev, head, pair);
      return `${out}Z`;
    })
    .join("");
}

/** The same paths with every point through `f`. */
export function mapPaths(paths: readonly SubPath[], f: (p: Point) => Point): SubPath[] {
  return paths.map((s) => ({
    closed: s.closed,
    anchors: s.anchors.map((a) => ({
      p: f(a.p),
      in: a.in && f(a.in),
      out: a.out && f(a.out),
      mode: a.mode,
    })),
  }));
}

/** The cubic's real extent along one axis: its ends and where its derivative crosses zero. */
function extent(p0: number, p1: number, p2: number, p3: number): [number, number] {
  let lo = Math.min(p0, p3);
  let hi = Math.max(p0, p3);
  const a = -p0 + 3 * p1 - 3 * p2 + p3;
  const b = 2 * (p0 - 2 * p1 + p2);
  const c = p1 - p0;
  const roots: number[] = [];
  if (Math.abs(a) < 1e-9) {
    if (Math.abs(b) > 1e-9) roots.push(-c / b);
  } else {
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const s = Math.sqrt(disc);
      roots.push((-b + s) / (2 * a), (-b - s) / (2 * a));
    }
  }
  for (const t of roots) {
    if (t <= 0 || t >= 1) continue;
    const m = 1 - t;
    const v = m * m * m * p0 + 3 * m * m * t * p1 + 3 * m * t * t * p2 + t * t * t * p3;
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  return [lo, hi];
}

/** The tight box around what the paths draw. */
export function boundsOf(paths: readonly SubPath[]): Rect | null {
  let left = Infinity;
  let right = -Infinity;
  let top = Infinity;
  let bottom = -Infinity;
  const add = (a: Anchor, b: Anchor) => {
    const c1 = a.out ?? a.p;
    const c2 = b.in ?? b.p;
    const [x0, x1] = extent(a.p.x, c1.x, c2.x, b.p.x);
    const [y0, y1] = extent(a.p.y, c1.y, c2.y, b.p.y);
    left = Math.min(left, x0);
    right = Math.max(right, x1);
    top = Math.min(top, y0);
    bottom = Math.max(bottom, y1);
  };
  for (const s of paths) {
    s.anchors.forEach((a, i) => {
      const b = s.anchors[i + 1] ?? (s.closed ? s.anchors[0] : undefined);
      if (b) add(a, b);
    });
  }
  return left === Infinity ? null : { x: left, y: top, width: right - left, height: bottom - top };
}

/** Paths in canvas units as a `d` measured from the whole-pixel box that holds them, at least 1×1. */
export function reframe(paths: readonly SubPath[]): { box: Rect; d: string; viewBox: string } {
  const b = boundsOf(paths) ?? { x: 0, y: 0, width: 0, height: 0 };
  const x = Math.floor(b.x);
  const y = Math.floor(b.y);
  const width = Math.max(1, Math.ceil(b.x + b.width) - x);
  const height = Math.max(1, Math.ceil(b.y + b.height) - y);
  const moved = mapPaths(paths, (p) => ({ x: p.x - x, y: p.y - y }));
  return { box: { x, y, width, height }, d: printPath(moved), viewBox: `0 0 ${width} ${height}` };
}
