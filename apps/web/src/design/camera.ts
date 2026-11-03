import type { Bounds } from "./renderer";

/** The parts of a wheel event the camera reads. Sandboxed artboards forward these. */
export type WheelInput = Pick<
  WheelEvent,
  "deltaX" | "deltaY" | "deltaMode" | "ctrlKey" | "metaKey" | "shiftKey" | "clientX" | "clientY"
>;

export interface View {
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
}

const MIN_ZOOM = 0.02;
const MAX_ZOOM = 8;

/** How long after the view last moved the world stops being its own compositor layer. */
const SETTLE_MS = 200;

const clampZoom = (zoom: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));

/** Smallest box containing every bound, or `null` when there are none. */
export function union(bounds: Iterable<Bounds>): Bounds | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const b of bounds) {
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.width);
    maxY = Math.max(maxY, b.y + b.height);
  }
  return minX === Infinity ? null : { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * The artboard that covers the most of `visible`, or `null` when none is in
 * it. Ties go to the first.
 */
export function mostVisible(bounds: ReadonlyMap<string, Bounds>, visible: Bounds): string | null {
  let best: string | null = null;
  let bestArea = 0;
  for (const [id, b] of bounds) {
    const width = Math.min(b.x + b.width, visible.x + visible.width) - Math.max(b.x, visible.x);
    const height = Math.min(b.y + b.height, visible.y + visible.height) - Math.max(b.y, visible.y);
    const area = width > 0 && height > 0 ? width * height : 0;
    if (area > bestArea) {
      best = id;
      bestArea = area;
    }
  }
  return best;
}

/** The view that centers `bounds` in a `width` × `height` viewport with `padding` around it. */
export function fit(
  bounds: Bounds,
  width: number,
  height: number,
  padding = 64,
  maxZoom = 1,
): View {
  const zoom = clampZoom(
    Math.min(
      (width - padding * 2) / Math.max(bounds.width, 1),
      (height - padding * 2) / Math.max(bounds.height, 1),
      maxZoom,
    ),
  );
  return {
    zoom,
    x: (width - bounds.width * zoom) / 2 - bounds.x * zoom,
    y: (height - bounds.height * zoom) / 2 - bounds.y * zoom,
  };
}

/**
 * Pans and zooms a canvas. `world` holds the content in canvas coordinates
 * and gets a CSS transform. The wheel pans (pinch or Ctrl/⌘ + wheel zooms
 * around the pointer), and dragging pans: with the left button unless
 * `dragToPan` is off, and always with the middle button.
 */
export class Camera {
  view: View = { x: 0, y: 0, zoom: 1 };
  /** When false, only the middle button drags the canvas, so the left button can place comments. */
  dragToPan = true;
  private readonly listeners = new Set<(view: View) => void>();
  private readonly abort = new AbortController();
  private settle: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly viewport: HTMLElement,
    private readonly world: HTMLElement,
  ) {
    const signal = this.abort.signal;
    viewport.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        this.wheel(e);
      },
      { passive: false, signal },
    );
    viewport.addEventListener("pointerdown", (e) => this.onPointerDown(e), { signal });
    // Safari's trackpad pinch arrives as gesture events rather than ctrl + wheel.
    viewport.addEventListener("gesturestart", (e) => e.preventDefault(), { signal });
    this.apply();
  }

  dispose() {
    this.abort.abort();
    this.listeners.clear();
    clearTimeout(this.settle);
  }

  subscribe(listener: (view: View) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  set(view: View) {
    this.view = { ...view, zoom: clampZoom(view.zoom) };
    this.apply();
  }

  /** Zooms by `factor`, keeping the viewport point (`cx`, `cy`) fixed. Defaults to the center. */
  zoomBy(factor: number, cx = this.viewport.clientWidth / 2, cy = this.viewport.clientHeight / 2) {
    const { x, y, zoom } = this.view;
    const next = clampZoom(zoom * factor);
    const ratio = next / zoom;
    this.set({ zoom: next, x: cx - (cx - x) * ratio, y: cy - (cy - y) * ratio });
  }

  /** The canvas point under a page point. */
  toWorld(clientX: number, clientY: number): { x: number; y: number } {
    const rect = this.viewport.getBoundingClientRect();
    const { x, y, zoom } = this.view;
    return { x: (clientX - rect.left - x) / zoom, y: (clientY - rect.top - y) / zoom };
  }

  /** The part of the canvas the viewport shows, in canvas coordinates. */
  visibleBounds(): Bounds {
    const { x, y, zoom } = this.view;
    return {
      x: -x / zoom,
      y: -y / zoom,
      width: this.viewport.clientWidth / zoom,
      height: this.viewport.clientHeight / zoom,
    };
  }

  /** Pans so the canvas point (`x`, `y`) sits in the middle of the viewport, at the same zoom. */
  centerOn(x: number, y: number) {
    const { zoom } = this.view;
    this.set({
      zoom,
      x: this.viewport.clientWidth / 2 - x * zoom,
      y: this.viewport.clientHeight / 2 - y * zoom,
    });
  }

  fitTo(bounds: Bounds | null) {
    if (!bounds) return;
    this.set(fit(bounds, this.viewport.clientWidth, this.viewport.clientHeight));
  }

  private apply() {
    const { x, y, zoom } = this.view;
    this.world.style.transform = `translate(${x}px, ${y}px) scale(${zoom})`;
    this.world.style.setProperty("--inv-zoom", String(1 / zoom));
    // While the view moves, the world is a compositor layer, so each frame
    // moves the pixels it already drew instead of redrawing every artboard
    // (heavy SVG filters made that lag). Once it settles, the layer goes and
    // the browser redraws it sharp at the new zoom.
    this.world.style.willChange = "transform";
    clearTimeout(this.settle);
    this.settle = setTimeout(() => (this.world.style.willChange = ""), SETTLE_MS);
    for (const listener of this.listeners) listener(this.view);
  }

  /** Pans, or zooms around the pointer when Ctrl/⌘ is held (which is also how trackpads report pinches). */
  wheel(e: WheelInput) {
    const rect = this.viewport.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey) {
      // Trackpad pinches report small deltas; mouse wheels report large ones.
      const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      this.zoomBy(Math.exp(-delta * 0.01), e.clientX - rect.left, e.clientY - rect.top);
      return;
    }
    const scale = e.deltaMode === 1 ? 16 : 1;
    const dx = e.shiftKey && e.deltaX === 0 ? e.deltaY : e.deltaX;
    const dy = e.shiftKey && e.deltaX === 0 ? 0 : e.deltaY;
    this.set({ ...this.view, x: this.view.x - dx * scale, y: this.view.y - dy * scale });
  }

  private onPointerDown(e: PointerEvent) {
    if (e.button !== 1 && (e.button !== 0 || !this.dragToPan)) return;
    // Controls on the canvas, like comment pins, opt out with `data-camera-ignore`.
    if (e.target instanceof Element && e.target.closest("[data-camera-ignore]")) return;
    e.preventDefault();
    const start = { px: e.clientX, py: e.clientY, x: this.view.x, y: this.view.y };
    this.viewport.setPointerCapture(e.pointerId);
    this.viewport.style.cursor = "var(--cursor-grabbing, grabbing)";
    const move = (ev: PointerEvent) =>
      this.set({
        ...this.view,
        x: start.x + ev.clientX - start.px,
        y: start.y + ev.clientY - start.py,
      });
    const up = () => {
      this.viewport.removeEventListener("pointermove", move);
      this.viewport.removeEventListener("pointerup", up);
      this.viewport.removeEventListener("pointercancel", up);
      this.viewport.style.cursor = "";
    };
    this.viewport.addEventListener("pointermove", move);
    this.viewport.addEventListener("pointerup", up);
    this.viewport.addEventListener("pointercancel", up);
  }
}
