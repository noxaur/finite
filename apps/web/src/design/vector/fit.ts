import { type Anchor, deriveMode, type Point, type SubPath } from "./path";

type Cubic = [Point, Point, Point, Point];

const sub = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a: Point, b: Point): Point => ({ x: a.x + b.x, y: a.y + b.y });
const scale = (a: Point, k: number): Point => ({ x: a.x * k, y: a.y * k });
const dot = (a: Point, b: Point) => a.x * b.x + a.y * b.y;
const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const unit = (a: Point): Point => {
  const l = Math.hypot(a.x, a.y);
  return l === 0 ? { x: 0, y: 0 } : { x: a.x / l, y: a.y / l };
};

function bezier(c: Cubic, t: number): Point {
  const m = 1 - t;
  const [a, b, d, e] = c;
  return {
    x: m * m * m * a.x + 3 * m * m * t * b.x + 3 * m * t * t * d.x + t * t * t * e.x,
    y: m * m * m * a.y + 3 * m * m * t * b.y + 3 * m * t * t * d.y + t * t * t * e.y,
  };
}

function parameterize(points: readonly Point[]): number[] {
  const u = [0];
  for (let i = 1; i < points.length; i++) u.push(u[i - 1]! + dist(points[i]!, points[i - 1]!));
  const total = u[u.length - 1]! || 1;
  return u.map((v) => v / total);
}

/** The best cubic for `points` with the given end tangents, by least squares. */
function generate(points: readonly Point[], u: readonly number[], t1: Point, t2: Point): Cubic {
  const first = points[0]!;
  const last = points[points.length - 1]!;
  let c00 = 0;
  let c01 = 0;
  let c11 = 0;
  let x0 = 0;
  let x1 = 0;
  for (const [i, t] of u.entries()) {
    const m = 1 - t;
    const b0 = m * m * m;
    const b1 = 3 * t * m * m;
    const b2 = 3 * t * t * m;
    const b3 = t * t * t;
    const a1 = scale(t1, b1);
    const a2 = scale(t2, b2);
    c00 += dot(a1, a1);
    c01 += dot(a1, a2);
    c11 += dot(a2, a2);
    const tmp = sub(points[i]!, add(scale(first, b0 + b1), scale(last, b2 + b3)));
    x0 += dot(a1, tmp);
    x1 += dot(a2, tmp);
  }
  const det = c00 * c11 - c01 * c01;
  const span = dist(first, last);
  const fallback = span / 3;
  let alpha1 = Math.abs(det) > 1e-9 ? (x0 * c11 - x1 * c01) / det : fallback;
  let alpha2 = Math.abs(det) > 1e-9 ? (c00 * x1 - c01 * x0) / det : fallback;
  if (alpha1 < 1e-6 * span || alpha2 < 1e-6 * span) {
    alpha1 = fallback;
    alpha2 = fallback;
  }
  return [first, add(first, scale(t1, alpha1)), add(last, scale(t2, alpha2)), last];
}

function reparameterize(c: Cubic, points: readonly Point[], u: readonly number[]): number[] {
  return u.map((t, i) => {
    const m = 1 - t;
    const p = points[i]!;
    const q = sub(bezier(c, t), p);
    const d1 = add(
      add(scale(sub(c[1], c[0]), 3 * m * m), scale(sub(c[2], c[1]), 6 * m * t)),
      scale(sub(c[3], c[2]), 3 * t * t),
    );
    const d2 = add(
      scale(add(sub(c[2], scale(c[1], 2)), c[0]), 6 * m),
      scale(add(sub(c[3], scale(c[2], 2)), c[1]), 6 * t),
    );
    const den = dot(d1, d1) + dot(q, d2);
    const next = den === 0 ? t : t - dot(q, d1) / den;
    return Math.max(0, Math.min(1, next));
  });
}

function fit(points: readonly Point[], t1: Point, t2: Point, tolerance: number): Cubic[] {
  if (points.length === 2) {
    const d = dist(points[0]!, points[1]!) / 3;
    return [[points[0]!, add(points[0]!, scale(t1, d)), add(points[1]!, scale(t2, d)), points[1]!]];
  }
  let u = parameterize(points);
  let c = generate(points, u, t1, t2);
  let split = 0;
  for (let round = 0; round < 8; round++) {
    let worst = 0;
    split = Math.floor(points.length / 2);
    for (let i = 1; i < points.length - 1; i++) {
      const d = dist(bezier(c, u[i]!), points[i]!);
      if (d > worst) {
        worst = d;
        split = i;
      }
    }
    if (worst <= tolerance) return [c];
    if (worst > tolerance * tolerance * 16) break;
    u = reparameterize(c, points, u);
    c = generate(points, u, t1, t2);
  }
  const center = unit(sub(points[split - 1]!, points[split + 1]!));
  return [
    ...fit(points.slice(0, split + 1), t1, center, tolerance),
    ...fit(points.slice(split), scale(center, -1), t2, tolerance),
  ];
}

/** A hand-drawn stroke as a few cubics, within `tolerance` of it (Schneider's curve fitting). */
export function fitStroke(raw: readonly Point[], tolerance: number): SubPath {
  const points = raw.filter((p, i) => i === 0 || dist(p, raw[i - 1]!) > 0.01);
  const anchor = (p: Point): Anchor => ({ p, in: null, out: null, mode: "none" });
  if (points.length < 2) return { closed: false, anchors: points.map(anchor) };
  const n = points.length;
  const curves = fit(
    points,
    unit(sub(points[1]!, points[0]!)),
    unit(sub(points[n - 2]!, points[n - 1]!)),
    tolerance,
  );
  const anchors: Anchor[] = [{ ...anchor(curves[0]![0]), out: curves[0]![1] }];
  for (const [i, c] of curves.entries()) {
    const a: Anchor = { p: c[3], in: c[2], out: curves[i + 1]?.[1] ?? null, mode: "none" };
    a.mode = deriveMode(a);
    anchors.push(a);
  }
  return { closed: false, anchors };
}
