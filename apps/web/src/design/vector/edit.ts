import { type Anchor, deriveMode, type HandleMode, type Point, type SubPath } from "./path";

/** An anchor by subpath and position. */
export type Ref = { sub: number; i: number };
/** The segment from anchor `i` to the next. */
export type Segment = Ref;
export type Hit =
  | { kind: "handle"; ref: Ref; which: "in" | "out" }
  | { kind: "anchor"; ref: Ref }
  | { kind: "segment"; seg: Segment; t: number; at: Point };

const clone = (paths: readonly SubPath[]): SubPath[] =>
  paths.map((s) => ({ closed: s.closed, anchors: s.anchors.map((a) => ({ ...a })) }));

const add = (a: Point, b: Point): Point => ({ x: a.x + b.x, y: a.y + b.y });
const sub = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y });
const lerp = (a: Point, b: Point, t: number): Point => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
});
const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const reflect = (h: Point, p: Point): Point => ({ x: 2 * p.x - h.x, y: 2 * p.y - h.y });

/** `to` on the nearest 45° ray from `from`. */
export function snapAngle(from: Point, to: Point): Point {
  const a = Math.round(Math.atan2(to.y - from.y, to.x - from.x) / (Math.PI / 4)) * (Math.PI / 4);
  const r = dist(from, to);
  return { x: from.x + Math.cos(a) * r, y: from.y + Math.sin(a) * r };
}

export const isEndpoint = (s: SubPath, i: number) =>
  !s.closed && (i === 0 || i === s.anchors.length - 1);

const segmentCount = (s: SubPath) => (s.closed ? s.anchors.length : s.anchors.length - 1);
const after = (s: SubPath, i: number) => s.anchors[(i + 1) % s.anchors.length]!;

const isStraight = (a: Anchor, b: Anchor) => !a.out && !b.in;

function pointOn(a: Anchor, b: Anchor, t: number): Point {
  if (isStraight(a, b)) return lerp(a.p, b.p, t);
  const c1 = a.out ?? a.p;
  const c2 = b.in ?? b.p;
  const m = 1 - t;
  return {
    x: m * m * m * a.p.x + 3 * m * m * t * c1.x + 3 * m * t * t * c2.x + t * t * t * b.p.x,
    y: m * m * m * a.p.y + 3 * m * m * t * c1.y + 3 * m * t * t * c2.y + t * t * t * b.p.y,
  };
}

/** The point on any segment nearest `p`. Samples, then narrows around the best sample. */
export function nearestSegment(
  paths: readonly SubPath[],
  p: Point,
): { seg: Segment; t: number; at: Point; distance: number } | null {
  let best: { seg: Segment; t: number; at: Point; distance: number } | null = null;
  paths.forEach((s, si) => {
    for (let i = 0; i < segmentCount(s); i++) {
      const a = s.anchors[i]!;
      const b = after(s, i);
      let t: number;
      if (isStraight(a, b)) {
        const d = sub(b.p, a.p);
        const len = d.x * d.x + d.y * d.y;
        t =
          len === 0
            ? 0
            : Math.max(0, Math.min(1, ((p.x - a.p.x) * d.x + (p.y - a.p.y) * d.y) / len));
      } else {
        const STEPS = 24;
        let found = 0;
        let min = Infinity;
        for (let n = 0; n <= STEPS; n++) {
          const dd = dist(pointOn(a, b, n / STEPS), p);
          if (dd < min) {
            min = dd;
            found = n / STEPS;
          }
        }
        let lo = Math.max(0, found - 1 / STEPS);
        let hi = Math.min(1, found + 1 / STEPS);
        for (let n = 0; n < 16; n++) {
          const m1 = lo + (hi - lo) / 3;
          const m2 = hi - (hi - lo) / 3;
          if (dist(pointOn(a, b, m1), p) < dist(pointOn(a, b, m2), p)) hi = m2;
          else lo = m1;
        }
        t = (lo + hi) / 2;
      }
      const at = pointOn(a, b, t);
      const distance = dist(at, p);
      if (!best || distance < best.distance) best = { seg: { sub: si, i }, t, at, distance };
    }
  });
  return best;
}

/** The anchors whose handles show: the picked ones and their neighbours. */
export function visibleHandles(paths: readonly SubPath[], picked: readonly Ref[]): Ref[] {
  const seen = new Set<string>();
  const out: Ref[] = [];
  const visit = (ref: Ref) => {
    const key = `${ref.sub}:${ref.i}`;
    if (seen.has(key) || !paths[ref.sub]?.anchors[ref.i]) return;
    seen.add(key);
    out.push(ref);
  };
  for (const ref of picked) {
    const s = paths[ref.sub];
    if (!s) continue;
    visit(ref);
    const n = s.anchors.length;
    if (ref.i > 0 || s.closed) visit({ sub: ref.sub, i: (ref.i - 1 + n) % n });
    if (ref.i < n - 1 || s.closed) visit({ sub: ref.sub, i: (ref.i + 1) % n });
  }
  return out;
}

/** What's under `p`, in the same coordinates as `paths`: a handle, then an anchor, then a segment. */
export function hitTest(
  paths: readonly SubPath[],
  picked: readonly Ref[],
  p: Point,
  within: number,
): Hit | null {
  for (const ref of visibleHandles(paths, picked)) {
    const a = paths[ref.sub]!.anchors[ref.i]!;
    if (a.out && dist(a.out, p) <= within) return { kind: "handle", ref, which: "out" };
    if (a.in && dist(a.in, p) <= within) return { kind: "handle", ref, which: "in" };
  }
  for (const [si, s] of paths.entries()) {
    for (const [i, a] of s.anchors.entries()) {
      if (dist(a.p, p) <= within) return { kind: "anchor", ref: { sub: si, i } };
    }
  }
  const near = nearestSegment(paths, p);
  return near && near.distance <= within
    ? { kind: "segment", seg: near.seg, t: near.t, at: near.at }
    : null;
}

export function moveAnchors(paths: readonly SubPath[], refs: readonly Ref[], d: Point): SubPath[] {
  const next = clone(paths);
  for (const { sub: si, i } of refs) {
    const a = next[si]?.anchors[i];
    if (!a) continue;
    a.p = add(a.p, d);
    a.in = a.in && add(a.in, d);
    a.out = a.out && add(a.out, d);
  }
  return next;
}

/** Sets one handle and keeps the other in step with the anchor's mode. */
function setHandle(a: Anchor, which: "in" | "out", to: Point, mode: HandleMode) {
  a[which] = to;
  const other = which === "in" ? "out" : "in";
  const across = a[other];
  if (!across || mode === "none") return;
  if (mode === "mirror") {
    a[other] = reflect(to, a.p);
    return;
  }
  const len = dist(across, a.p);
  const d = sub(a.p, to);
  const l = Math.hypot(d.x, d.y);
  if (l > 0) a[other] = add(a.p, { x: (d.x / l) * len, y: (d.y / l) * len });
}

/** Moves a handle to `to`, the other following the anchor's mode; `free` holds the other still. */
export function moveHandle(
  paths: readonly SubPath[],
  ref: Ref,
  which: "in" | "out",
  to: Point,
  free: boolean,
): SubPath[] {
  const next = clone(paths);
  const a = next[ref.sub]!.anchors[ref.i]!;
  setHandle(a, which, to, free ? "none" : a.mode);
  if (free) a.mode = "none";
  return next;
}

/** Bends a segment so the point at `t` passes through `to`, with Inkscape's sculpt weights. */
export function bendSegment(
  paths: readonly SubPath[],
  seg: Segment,
  t0: number,
  to: Point,
): SubPath[] {
  const next = clone(paths);
  const s = next[seg.sub]!;
  const a = s.anchors[seg.i]!;
  const b = after(s, seg.i);
  const c1 = a.out ?? lerp(a.p, b.p, 1 / 3);
  const c2 = b.in ?? lerp(a.p, b.p, 2 / 3);
  const t = Math.min(0.95, Math.max(0.05, t0));
  const m = 1 - t;
  const on = {
    x: m * m * m * a.p.x + 3 * m * m * t * c1.x + 3 * m * t * t * c2.x + t * t * t * b.p.x,
    y: m * m * m * a.p.y + 3 * m * m * t * c1.y + 3 * m * t * t * c2.y + t * t * t * b.p.y,
  };
  const delta = sub(to, on);
  const w =
    t <= 1 / 6
      ? 0
      : t <= 0.5
        ? ((6 * t - 1) / 2) ** 3 / 2
        : t <= 5 / 6
          ? (1 - ((6 * (1 - t) - 1) / 2) ** 3) / 2 + 0.5
          : 1;
  const k0 = (1 - w) / (3 * t * m * m);
  const k1 = w / (3 * t * t * m);
  setHandle(a, "out", add(c1, { x: delta.x * k0, y: delta.y * k0 }), a.mode);
  setHandle(b, "in", add(c2, { x: delta.x * k1, y: delta.y * k1 }), b.mode);
  return next;
}

/** Pulls mirrored handles out of an anchor, `out` toward `to`. */
export function pullHandles(paths: readonly SubPath[], ref: Ref, to: Point): SubPath[] {
  const next = clone(paths);
  const a = next[ref.sub]!.anchors[ref.i]!;
  a.out = to;
  a.in = reflect(to, a.p);
  a.mode = "mirror";
  return next;
}

/** Drops an anchor's handles, making it a corner. */
export function toCorner(paths: readonly SubPath[], ref: Ref): SubPath[] {
  const next = clone(paths);
  const a = next[ref.sub]!.anchors[ref.i]!;
  a.in = null;
  a.out = null;
  a.mode = "none";
  return next;
}

/** Sets an anchor's handle mode. Mirrored modes need handles, so a corner gets a tangent first. */
export function setMode(paths: readonly SubPath[], ref: Ref, mode: HandleMode): SubPath[] {
  const next = clone(paths);
  const s = next[ref.sub]!;
  const a = s.anchors[ref.i]!;
  a.mode = mode;
  if (mode === "none") return next;
  const n = s.anchors.length;
  const prev = ref.i > 0 || s.closed ? s.anchors[(ref.i - 1 + n) % n]! : null;
  const nxt = ref.i < n - 1 || s.closed ? s.anchors[(ref.i + 1) % n]! : null;
  if (!a.in && !a.out) {
    const from = prev?.p ?? a.p;
    const to = nxt?.p ?? a.p;
    const d = sub(to, from);
    const l = Math.hypot(d.x, d.y) || 1;
    const u = { x: d.x / l, y: d.y / l };
    if (nxt) a.out = add(a.p, { x: (u.x * dist(nxt.p, a.p)) / 3, y: (u.y * dist(nxt.p, a.p)) / 3 });
    if (prev)
      a.in = sub(a.p, { x: (u.x * dist(prev.p, a.p)) / 3, y: (u.y * dist(prev.p, a.p)) / 3 });
  }
  if (a.out) setHandle(a, "out", a.out, mode);
  else if (a.in) setHandle(a, "in", a.in, mode);
  if (a.out && !a.in && prev) a.in = reflect(a.out, a.p);
  if (a.in && !a.out && nxt) a.out = reflect(a.in, a.p);
  a.mode = mode;
  return next;
}

/** Splits a segment at `t` with a new anchor; the curve doesn't change. */
export function insertPoint(
  paths: readonly SubPath[],
  seg: Segment,
  t: number,
): { paths: SubPath[]; ref: Ref } {
  const next = clone(paths);
  const s = next[seg.sub]!;
  const a = s.anchors[seg.i]!;
  const b = after(s, seg.i);
  const ref = { sub: seg.sub, i: seg.i + 1 };
  if (isStraight(a, b)) {
    s.anchors.splice(seg.i + 1, 0, {
      p: lerp(a.p, b.p, t),
      in: null,
      out: null,
      mode: "none",
    });
    return { paths: next, ref };
  }
  const c1 = a.out ?? a.p;
  const c2 = b.in ?? b.p;
  const ab = lerp(a.p, c1, t);
  const bc = lerp(c1, c2, t);
  const cd = lerp(c2, b.p, t);
  const abc = lerp(ab, bc, t);
  const bcd = lerp(bc, cd, t);
  const p = lerp(abc, bcd, t);
  a.out = ab;
  b.in = cd;
  const anchor: Anchor = { p, in: abc, out: bcd, mode: "none" };
  anchor.mode = deriveMode(anchor);
  s.anchors.splice(seg.i + 1, 0, anchor);
  return { paths: next, ref };
}

/** Removes anchors. A path left with one anchor goes; its neighbours keep their curve handles. */
export function deleteAnchors(paths: readonly SubPath[], refs: readonly Ref[]): SubPath[] {
  const next = clone(paths);
  const gone = new Set(refs.map((r) => `${r.sub}:${r.i}`));
  return next.flatMap((s, si): SubPath[] => {
    const before = s.anchors.length;
    s.anchors = s.anchors.filter((_, i) => !gone.has(`${si}:${i}`));
    if (s.anchors.length === before) return [s];
    if (s.anchors.length < 2) return [];
    if (s.closed && s.anchors.length === 2 && !s.anchors.some((a) => a.in || a.out)) {
      s.closed = false;
    }
    if (!s.closed) {
      s.anchors[0]!.in = null;
      s.anchors[s.anchors.length - 1]!.out = null;
      for (const a of [s.anchors[0]!, s.anchors[s.anchors.length - 1]!]) a.mode = "none";
    }
    return [s];
  });
}

function reversed(s: SubPath): SubPath {
  return {
    closed: s.closed,
    anchors: [...s.anchors].reverse().map((a) => ({ p: a.p, in: a.out, out: a.in, mode: a.mode })),
  };
}

/** Closes an open path. When its ends meet, they become one anchor. */
export function closeSub(paths: readonly SubPath[], si: number): SubPath[] {
  const next = clone(paths);
  const s = next[si];
  if (!s || s.closed || s.anchors.length < 2) return next;
  const first = s.anchors[0]!;
  const last = s.anchors[s.anchors.length - 1]!;
  if (s.anchors.length > 2 && Math.hypot(first.p.x - last.p.x, first.p.y - last.p.y) < 0.01) {
    first.in = last.in;
    first.mode = deriveMode(first);
    s.anchors.pop();
  }
  s.closed = true;
  return next;
}

/**
 * Joins two ends of open paths: one path's ends close it, two paths become one, end to start,
 * reversed where needed. Ends that meet become one anchor, otherwise a straight segment joins them.
 */
export function joinEnds(paths: readonly SubPath[], a: Ref, b: Ref): SubPath[] | null {
  const pa = paths[a.sub];
  const pb = paths[b.sub];
  if (!pa || !pb || pa.closed || pb.closed) return null;
  if (!isEndpoint(pa, a.i) || !isEndpoint(pb, b.i)) return null;
  if (a.sub === b.sub) return a.i === b.i ? null : closeSub(paths, a.sub);
  const head = a.i === 0 ? reversed(pa) : pa;
  const tail = b.i === pb.anchors.length - 1 ? reversed(pb) : pb;
  const anchors = head.anchors.map((x) => ({ ...x }));
  const last = anchors[anchors.length - 1]!;
  const rest = tail.anchors.map((x) => ({ ...x }));
  const first = rest[0]!;
  if (Math.hypot(last.p.x - first.p.x, last.p.y - first.p.y) < 0.01) {
    last.out = first.out;
    last.mode = deriveMode(last);
    rest.shift();
  }
  const joined: SubPath = { closed: false, anchors: [...anchors, ...rest] };
  const out = clone(paths);
  const low = Math.min(a.sub, b.sub);
  const high = Math.max(a.sub, b.sub);
  out.splice(high, 1);
  out.splice(low, 1, joined);
  return out;
}

/** The join the picked anchors allow: their one path's close, or two ends joined. */
export function joinPicked(paths: readonly SubPath[], picked: readonly Ref[]): SubPath[] | null {
  if (picked.length === 1) {
    const [only] = picked;
    const s = paths[only!.sub];
    return s && !s.closed ? closeSub(paths, only!.sub) : null;
  }
  return picked.length === 2 ? joinEnds(paths, picked[0]!, picked[1]!) : null;
}
