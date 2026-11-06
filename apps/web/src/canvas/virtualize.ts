import { overlaps } from "../design/culling";
import type { Bounds } from "../design/types";

/** At most this many frames keep a live iframe. */
export const MOUNT_CAP = 12;

type Box = Bounds & { readonly id: string };

const center = (b: Bounds) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });

/**
 * Which frames get a live iframe, most wanted first: the `pinned` ones (selected, or being
 * clicked through), then those in `area` (the viewport plus a margin) nearest its center first,
 * then the ones mounted before (`recent`, most recent first) so a short pan back doesn't reload
 * them. Never more than `cap`. Frames that don't make it show a name card.
 */
export function framesToMount(
  frames: readonly Box[],
  area: Bounds,
  recent: readonly string[],
  pinned: ReadonlySet<string> = new Set(),
  cap = MOUNT_CAP,
): string[] {
  const out: string[] = [];
  const add = (id: string) => {
    if (out.length < cap && !out.includes(id)) out.push(id);
  };
  const ids = new Set(frames.map((f) => f.id));
  for (const id of pinned) if (ids.has(id)) add(id);
  const c = center(area);
  const dist = (b: Bounds) => {
    const p = center(b);
    return (p.x - c.x) ** 2 + (p.y - c.y) ** 2;
  };
  frames
    .filter((f) => overlaps(f, area))
    .sort((a, b) => dist(a) - dist(b))
    .forEach((f) => add(f.id));
  for (const id of recent) if (ids.has(id)) add(id);
  return out;
}
