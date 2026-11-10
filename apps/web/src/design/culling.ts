import type { View } from "./camera";
import type { Bounds } from "./types";

/** Side of one cell in the frame index, in canvas pixels. */
const CELL = 2048;

/** A query covering more cells than this scans every box instead of walking the cells. */
const MAX_CELLS = 256;

/** Whether two boxes share any area. Boxes that only touch don't. */
export function overlaps(a: Bounds, b: Bounds): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/**
 * The canvas area a `width` × `height` viewport shows under `view`, grown by
 * `margin` viewports on each side so a short pan doesn't reveal blank space.
 */
export function visibleBounds(view: View, width: number, height: number, margin = 0.5): Bounds {
  const w = width / view.zoom;
  const h = height / view.zoom;
  return {
    x: -view.x / view.zoom - w * margin,
    y: -view.y / view.zoom - h * margin,
    width: w * (1 + 2 * margin),
    height: h * (1 + 2 * margin),
  };
}

/**
 * Where each frame sits on the canvas, in a grid of cells, so finding
 * the ones in an area reads only the cells it covers instead of every box.
 */
export class FrameIndex {
  private readonly boxes = new Map<string, Bounds>();
  private readonly cells = new Map<string, Set<string>>();

  /** Adds or moves a frame. */
  set(id: string, box: Bounds) {
    this.delete(id);
    this.boxes.set(id, box);
    for (const key of cellsOf(box)) {
      let cell = this.cells.get(key);
      if (!cell) this.cells.set(key, (cell = new Set()));
      cell.add(id);
    }
  }

  get(id: string): Bounds | undefined {
    return this.boxes.get(id);
  }

  delete(id: string) {
    const box = this.boxes.get(id);
    if (!box) return;
    this.boxes.delete(id);
    for (const key of cellsOf(box)) {
      const cell = this.cells.get(key);
      cell?.delete(id);
      if (cell?.size === 0) this.cells.delete(key);
    }
  }

  clear() {
    this.boxes.clear();
    this.cells.clear();
  }

  /** Ids of the frames whose box overlaps `area`. */
  query(area: Bounds): Set<string> {
    const found = new Set<string>();
    if (cellCount(area) > MAX_CELLS) {
      // Zoomed far out: the area spans so many cells that listing them
      // costs more than checking each box.
      for (const [id, box] of this.boxes) if (overlaps(box, area)) found.add(id);
      return found;
    }
    for (const key of cellsOf(area)) {
      for (const id of this.cells.get(key) ?? []) {
        if (!found.has(id) && overlaps(this.boxes.get(id)!, area)) found.add(id);
      }
    }
    return found;
  }
}

/** How many cells a box covers. */
function cellCount(box: Bounds): number {
  const [x0, y0, x1, y1] = cellRange(box);
  return (x1 - x0 + 1) * (y1 - y0 + 1);
}

function cellRange(box: Bounds): [number, number, number, number] {
  return [
    Math.floor(box.x / CELL),
    Math.floor(box.y / CELL),
    Math.floor((box.x + box.width) / CELL),
    Math.floor((box.y + box.height) / CELL),
  ];
}

/** Keys of the cells a box covers. */
function* cellsOf(box: Bounds): Generator<string> {
  const [x0, y0, x1, y1] = cellRange(box);
  for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) yield `${cx},${cy}`;
}

/** Where a hidden frame would be on the page, given a canvas-to-page mapping. */
export function pageBox(
  box: Bounds,
  toPage: (x: number, y: number) => { x: number; y: number },
): Bounds {
  const a = toPage(box.x, box.y);
  const b = toPage(box.x + box.width, box.y + box.height);
  return { x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y };
}

/** What the culler asks of whoever draws the frames. */
export interface CullHost {
  /** The laid-out size of a shown frame, or `null` when it has no layout yet. */
  measure(id: string): { width: number; height: number } | null;
  /** Hides or shows a frame. */
  setCulled(id: string, culled: boolean): void;
}

interface Entry {
  x: number;
  y: number;
  /** The size when last measured while shown. */
  size?: { width: number; height: number };
  /** The size may have changed since it was measured. */
  dirty: boolean;
  culled: boolean;
}

/**
 * Decides which frames to hide. It knows each frame's position and
 * its last measured size, keeps them in an `FrameIndex`, and on each
 * pass hides the ones outside the area in view. Passes are batched to one
 * per frame (`schedule`).
 *
 * A frame is measured while shown and keeps that size while hidden,
 * so its box is still known. One that has never been measured stays shown
 * until a pass measures it, and one whose size may have changed (`touch`)
 * is measured again before a pass reads it.
 */
export class Culler {
  private readonly boards = new Map<string, Entry>();
  private readonly index = new FrameIndex();
  private area: Bounds | null = null;
  private pending = false;
  private disposed = false;

  constructor(
    private readonly host: CullHost,
    private readonly schedule: (run: () => void) => void,
  ) {}

  dispose() {
    this.disposed = true;
  }

  /** Starts tracking a frame. It stays shown until measured. */
  add(id: string, x: number, y: number) {
    this.boards.set(id, { x, y, dirty: true, culled: false });
    this.request();
  }

  remove(id: string) {
    this.boards.delete(id);
    this.index.delete(id);
  }

  clear() {
    this.boards.clear();
    this.index.clear();
  }

  /** A frame moved on the canvas. */
  move(id: string, x: number, y: number) {
    const entry = this.boards.get(id);
    if (!entry) return;
    entry.x = x;
    entry.y = y;
    this.reindex(id, entry);
    this.request();
  }

  /** A frame's size may have changed, by an edit or by content loading. */
  touch(id: string) {
    const entry = this.boards.get(id);
    if (!entry) return;
    entry.dirty = true;
    this.request();
  }

  /** Sets the canvas area to keep shown, or `null` to show everything. */
  setArea(area: Bounds | null) {
    this.area = area;
    this.request(true);
  }

  isCulled(id: string): boolean {
    return this.boards.get(id)?.culled ?? false;
  }

  /** The frame's last measured size, or `undefined` before it has one. */
  size(id: string): { width: number; height: number } | undefined {
    return this.boards.get(id)?.size;
  }

  /** The frame's box on the canvas from its last measured size. */
  box(id: string): Bounds | undefined {
    return this.index.get(id);
  }

  /** Asks for a pass at the next frame. Without an area there's nothing to cull, unless it was just cleared. */
  private request(cleared = false) {
    if (this.pending || this.disposed || (!this.area && !cleared)) return;
    this.pending = true;
    this.schedule(() => {
      this.pending = false;
      if (!this.disposed) this.flush();
    });
  }

  /** Measures what needs it, then hides and shows frames to match the area. */
  flush() {
    const area = this.area;
    if (!area) {
      for (const [id, entry] of this.boards) if (entry.culled) this.setCulled(id, entry, false);
      return;
    }
    // Measure every frame before touching any, so layout is flushed once.
    for (const [id, entry] of this.boards) {
      if (!entry.culled && entry.dirty) this.measure(id, entry);
    }
    const inside = this.index.query(area);
    for (const [id, entry] of this.boards) {
      const show = inside.has(id) || !entry.size;
      if (show === entry.culled) this.setCulled(id, entry, !show);
    }
  }

  private measure(id: string, entry: Entry) {
    const size = this.host.measure(id);
    if (!size) return;
    entry.size = size;
    entry.dirty = false;
    this.reindex(id, entry);
  }

  private reindex(id: string, entry: Entry) {
    if (entry.size) this.index.set(id, { x: entry.x, y: entry.y, ...entry.size });
  }

  private setCulled(id: string, entry: Entry, culled: boolean) {
    entry.culled = culled;
    this.host.setCulled(id, culled);
    if (!culled) {
      // Edits made while it was hidden may have changed its size.
      entry.dirty = true;
      this.request();
    }
  }
}
