import type { View } from "./camera";
import type { Bounds } from "./renderer";

/** Side of one cell in the artboard index, in canvas pixels. */
const CELL = 2048;

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
 * Where each artboard sits on the canvas, in a grid of cells, so finding
 * the ones in an area reads only the cells it covers instead of every box.
 */
export class ArtboardIndex {
  private readonly boxes = new Map<string, Bounds>();
  private readonly cells = new Map<string, Set<string>>();

  /** Adds or moves an artboard. */
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

  /** Ids of the artboards whose box overlaps `area`. */
  query(area: Bounds): Set<string> {
    const found = new Set<string>();
    for (const key of cellsOf(area)) {
      for (const id of this.cells.get(key) ?? []) {
        if (!found.has(id) && overlaps(this.boxes.get(id)!, area)) found.add(id);
      }
    }
    return found;
  }
}

/** Keys of the cells a box covers. A huge area is capped so a far zoom-out stays cheap. */
function* cellsOf(box: Bounds): Generator<string> {
  const x0 = Math.floor(box.x / CELL);
  const y0 = Math.floor(box.y / CELL);
  const x1 = Math.floor((box.x + box.width) / CELL);
  const y1 = Math.floor((box.y + box.height) / CELL);
  for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) yield `${cx},${cy}`;
}
