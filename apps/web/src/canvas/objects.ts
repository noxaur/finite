import type { Rect, TextLabel } from "@finite/protocol";
import { labelAnchor } from "./labelAnchor";

/** The smallest a section or slice gets, in canvas units. */
export const MIN_OBJECT = 24;

/** Whether `inner` lies wholly inside `outer`. */
export function contains(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

/**
 * What moves with a section: the frames wholly inside it, their labels, and free labels whose
 * corner is inside it. Read when the drag starts, so a section stores no list that could go stale.
 */
export function membersOf(
  section: Rect,
  frames: ReadonlyArray<Rect & { id: string }>,
  texts: ReadonlyArray<Pick<TextLabel, "id" | "x" | "y" | "width">>,
): { frameIds: string[]; textIds: string[] } {
  const inside = new Set(frames.filter((f) => contains(section, f)).map((f) => f.id));
  const textIds = texts
    .filter((t) => {
      const owner = labelAnchor(t, frames);
      if (owner) return inside.has(owner.id);
      return (
        t.x >= section.x &&
        t.x < section.x + section.width &&
        t.y >= section.y &&
        t.y < section.y + section.height
      );
    })
    .map((t) => t.id);
  return { frameIds: [...inside], textIds };
}

/** "Section 2": the first of `base 1`, `base 2`, … that no name has. */
export function freeName(taken: Iterable<string>, base: string): string {
  const used = new Set(taken);
  for (let n = 1; ; n++) if (!used.has(`${base} ${n}`)) return `${base} ${n}`;
}

/** `box` kept inside `bounds` (both from 0,0), at least `MIN_OBJECT` where there's room. */
export function clampInside(box: Rect, bounds: { width: number; height: number }): Rect {
  const width = Math.min(Math.max(box.width, MIN_OBJECT), bounds.width);
  const height = Math.min(Math.max(box.height, MIN_OBJECT), bounds.height);
  return {
    x: Math.min(Math.max(box.x, 0), bounds.width - width),
    y: Math.min(Math.max(box.y, 0), bounds.height - height),
    width,
    height,
  };
}

/** The box of a drag from `a` to `b`, whichever corner it started at. */
export function boxBetween(a: { x: number; y: number }, b: { x: number; y: number }): Rect {
  return {
    x: Math.round(Math.min(a.x, b.x)),
    y: Math.round(Math.min(a.y, b.y)),
    width: Math.round(Math.abs(b.x - a.x)),
    height: Math.round(Math.abs(b.y - a.y)),
  };
}

/** `box` with whole-number edges. */
export function rounded(box: Rect): Rect {
  const x = Math.round(box.x);
  const y = Math.round(box.y);
  return {
    x,
    y,
    width: Math.max(1, Math.round(box.x + box.width) - x),
    height: Math.max(1, Math.round(box.y + box.height) - y),
  };
}

/** One measured distance: a line from `a` to `b` in canvas units, and the number it shows. */
export type Gap = { a: { x: number; y: number }; b: { x: number; y: number }; label: string };

const fmt = (n: number) => String(Math.round(n * 10) / 10);

/**
 * The distances between two boxes. Nested boxes give the four insets of the inner one. Boxes
 * apart on an axis give the gap along it, and on both axes both gaps. Boxes that overlap
 * without nesting give none.
 */
export function gaps(a: Rect, b: Rect): Gap[] {
  const out: Gap[] = [];
  const nested = contains(a, b) ? ([a, b] as const) : contains(b, a) ? ([b, a] as const) : null;
  if (nested) {
    const [o, i] = nested;
    const cx = i.x + i.width / 2;
    const cy = i.y + i.height / 2;
    const parts: Gap[] = [
      { a: { x: o.x, y: cy }, b: { x: i.x, y: cy }, label: fmt(i.x - o.x) },
      {
        a: { x: i.x + i.width, y: cy },
        b: { x: o.x + o.width, y: cy },
        label: fmt(o.x + o.width - (i.x + i.width)),
      },
      { a: { x: cx, y: o.y }, b: { x: cx, y: i.y }, label: fmt(i.y - o.y) },
      {
        a: { x: cx, y: i.y + i.height },
        b: { x: cx, y: o.y + o.height },
        label: fmt(o.y + o.height - (i.y + i.height)),
      },
    ];
    return parts.filter((g) => g.label !== "0");
  }
  const [left, right] = a.x <= b.x ? [a, b] : [b, a];
  const [upper, lower] = a.y <= b.y ? [a, b] : [b, a];
  const apartX = left.x + left.width <= right.x;
  const apartY = upper.y + upper.height <= lower.y;
  if (apartX) {
    const top = Math.max(a.y, b.y);
    const bottom = Math.min(a.y + a.height, b.y + b.height);
    const y = top < bottom ? (top + bottom) / 2 : (a.y + a.height / 2 + b.y + b.height / 2) / 2;
    out.push({
      a: { x: left.x + left.width, y },
      b: { x: right.x, y },
      label: fmt(right.x - (left.x + left.width)),
    });
  }
  if (apartY) {
    const from = Math.max(a.x, b.x);
    const to = Math.min(a.x + a.width, b.x + b.width);
    const x = from < to ? (from + to) / 2 : (a.x + a.width / 2 + b.x + b.width / 2) / 2;
    out.push({
      a: { x, y: upper.y + upper.height },
      b: { x, y: lower.y },
      label: fmt(lower.y - (upper.y + upper.height)),
    });
  }
  return out;
}

type At = { id: string; x: number; y: number };

/**
 * Where a section and its members land when dragged by `d`, in whole canvas units. The section
 * moves by the same rounded step as every member, so they never drift apart.
 */
export function movedWith(
  section: Rect,
  frames: ReadonlyArray<At>,
  texts: ReadonlyArray<At>,
  d: { x: number; y: number },
): { x: number; y: number; frames: At[]; texts: At[] } {
  const dx = Math.round(d.x);
  const dy = Math.round(d.y);
  const step = (a: At): At => ({ id: a.id, x: a.x + dx, y: a.y + dy });
  return { x: section.x + dx, y: section.y + dy, frames: frames.map(step), texts: texts.map(step) };
}
