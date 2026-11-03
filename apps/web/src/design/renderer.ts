import * as stylex from "@stylexjs/stylex";
import { colors } from "@/styles/tokens.stylex";
import { Culler, pageBox } from "./culling";
import { artboardDocument, BASE_LAYER, pixelSize } from "./html";
import {
  BITMAP_BUDGET,
  bitmapScale,
  evictionPlan,
  rasterize,
  rebuildDelay,
  wantsBitmaps,
  type Rasterizer,
} from "./lod";
import type { Applied, Replica } from "./replica";
import type { Node } from "./schema";
import { designModel } from "./wasm";

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * Stops the app's inherited styles (color, font) from leaking into artboards.
 * The cursor still inherits, so the canvas's tool cursor shows over artboards.
 */
const HOST_CSS = ":host { all: initial; display: block; cursor: inherit; }";
/** In comment mode, the comment cursor wins over the design's own cursors. */
const COMMENTING_CSS = "* { cursor: inherit !important; }";

/**
 * Tags never created in the app's own document. Scripts only run inside a
 * sandboxed iframe, and the server strips the rest too.
 */
const BLOCKED_TAGS = new Set([
  "script",
  "link",
  "meta",
  "base",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "template",
]);

/** A bitmap is drawn again only once the zoom needs it at this many times its scale; until then CSS scales it. */
const BLUR_FACTOR = 2;

/** How long a sandboxed artboard waits for edits to settle before reloading. */
const RELOAD_DELAY_MS = 150;
const MAX_SIDE = 16_000;

const isScript = (node: Node) => node.type === "element" && node.tag?.toLowerCase() === "script";

interface Frame {
  readonly root: HTMLElement;
  readonly label: HTMLElement;
  readonly badge: HTMLElement;
  readonly content: HTMLElement;
  /** Set for artboards rendered as live DOM in a shadow root. */
  readonly shadow: ShadowRoot | null;
  /** Holds `COMMENTING_CSS` while in comment mode. */
  readonly commentStyle: HTMLStyleElement | null;
  /** Holds the design's shared CSS, before the artboard's own styles. */
  readonly sharedStyle: HTMLStyleElement | null;
  /** Set for artboards with scripts, rendered in a sandboxed iframe. */
  readonly iframe: HTMLIFrameElement | null;
  reload?: ReturnType<typeof setTimeout>;
  /** The artboard drawn as a bitmap, once built. It's stale after an edit until rebuilt. */
  bitmap?: HTMLCanvasElement;
  /**
   * Drawn as `bitmap` instead of live DOM, which is hidden, and hidden DOM
   * runs no CSS animations. A sandboxed artboard is never a bitmap: its
   * scripts' output isn't in the replica's HTML.
   */
  shown: boolean;
  /** The `version` the bitmap shows. It's stale once an edit moves `version` past it. */
  bitmapVersion?: number;
  /** The scale the bitmap was drawn at. It's drawn again, sharper, when the zoom outgrows it. */
  bitmapScale?: number;
  /** The size the bitmap was drawn at, which the artboard keeps while it's shown. */
  bitmapSize?: { readonly width: number; readonly height: number };
  /** Counts edits, so a bitmap built before the latest one isn't used. */
  version: number;
  /** The version the browser couldn't draw, so it isn't retried until an edit changes it. */
  failed?: number;
  /** When the bitmap was last built, in ms since the epoch. */
  built: number;
  /** Rebuilds the bitmap once edits pause. */
  rebuild?: ReturnType<typeof setTimeout>;
  /** The iframe's latest answer to "what's under this point?", in its own coordinates. */
  hit?: { readonly x: number; readonly y: number; readonly id: string | null };
  /** The point last asked about, so the same question isn't sent twice. */
  asked?: { readonly x: number; readonly y: number };
  /** Where the iframe last said its nodes are, in its own coordinates. */
  readonly rects: Map<string, { readonly rect: Bounds; readonly at: number }>;
  readonly pendingRects: Set<string>;
}

/** How long a sandboxed node's reported position is trusted before it's asked again. */
const RECT_TTL_MS = 250;

export interface Bounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** A wheel event forwarded out of a sandboxed artboard, in page coordinates. */
export interface ForwardedWheel {
  readonly deltaX: number;
  readonly deltaY: number;
  readonly deltaMode: number;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly clientX: number;
  readonly clientY: number;
}

/** The artboard, and the deepest element in it, under a point. */
export interface Hit {
  readonly artboardId: string;
  /** For a sandboxed artboard, the artboard itself until its iframe answers. */
  readonly nodeId: string;
}

export interface RendererOptions {
  /** Run artboards that contain scripts. Off for thumbnails, which stay static. */
  readonly live?: boolean;
  /** Receives wheel events from sandboxed artboards, so the canvas can pan over them. */
  readonly onWheel?: (event: ForwardedWheel) => void;
  /**
   * Called when a sandboxed artboard answers a `hitTest` or `nodeRect`
   * question, which arrives a moment later. Call them again to read the answer.
   */
  readonly onLayout?: () => void;
  /** Maps a canvas point to a page point, for placing nodes in hidden artboards. */
  readonly toPage?: (x: number, y: number) => { x: number; y: number };
  /** Draws an artboard into a canvas. Tests replace it, since they have no layout engine. */
  readonly rasterize?: Rasterizer;
  /** The most pixels all bitmaps may hold together (`BITMAP_BUDGET`). */
  readonly bitmapBudget?: number;
  /** Called when a sandboxed artboard reports a new size, which an auto-height one does after its scripts run. */
  readonly onResize?: () => void;
}

/**
 * Draws a design into `world` and keeps it current as ops arrive.
 *
 * Most artboards render as real DOM inside a shadow root, isolated from the
 * app's CSS, and each op patches only the elements it touched. `<style>`
 * blocks inside work and stay scoped to their artboard.
 *
 * An artboard that contains a `<script>` renders in a sandboxed iframe
 * instead (`sandbox="allow-scripts"`, so it has an opaque origin and can't
 * reach the app), with a content policy that blocks network requests. It
 * reloads after each burst of edits. Both modes match the server's screenshots.
 */
export class Renderer {
  private readonly elements = new Map<string, Element | Text>();
  private readonly ids = new WeakMap<Element, string>();
  private readonly frames = new Map<string, Frame>();
  private readonly scripts = new Set<string>();
  /** Every instance in the design, so a change can find the ones to draw again. */
  private readonly instances = new Set<string>();
  /** Whether each instance shows a `<script>` from its component, once asked. */
  private readonly instanceScripts = new Map<string, boolean>();
  /** The virtual ids drawn inside each instance, to forget when it's drawn again. */
  private readonly virtuals = new Map<string, string[]>();
  private working: ReadonlyMap<string, string> = new Map();
  private commenting = false;
  /** The page shown, or `null` for the first page. Only its artboards are mounted. */
  private page: string | null = null;
  /** Hides artboards outside the view. A hidden sandboxed one has its iframe unloaded. */
  private readonly culler = new Culler(
    {
      measure: (id) => {
        const root = this.frames.get(id)?.root;
        const width = root?.offsetWidth ?? 0;
        const height = root?.offsetHeight ?? 0;
        // Zero both ways means it isn't laid out; try again later.
        return width === 0 && height === 0 ? null : { width, height };
      },
      setCulled: (id, culled) => {
        const frame = this.frames.get(id);
        if (frame) this.setCulled(id, frame, culled);
      },
    },
    (run) => requestAnimationFrame(run),
  );
  /** Zoomed far out, the artboards in view are drawn as bitmaps. */
  private bitmaps = false;
  /** Artboards waiting for a bitmap, built one per frame so zooming out doesn't stall. */
  private readonly queue = new Set<string>();
  private pumping = false;
  /** The middle of the area in view, which the bitmaps farthest from are dropped first. */
  private center: { readonly x: number; readonly y: number } | null = null;
  /** The canvas zoom, which sets how sharp bitmaps are drawn. */
  private zoom = 1;
  /** Pixels held by all bitmaps together. */
  private pixels = 0;
  /** Tells when an artboard's size changes, by content loading or an edit. */
  private readonly resizes =
    typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver((entries) => {
          for (const entry of entries) {
            const id = (entry.target as HTMLElement).dataset.artboard;
            // A hidden artboard reports no size; it's measured when it's shown.
            if (id && (entry.contentRect.width > 0 || entry.contentRect.height > 0)) {
              this.culler.touch(id);
            }
          }
        });
  private readonly abort = new AbortController();

  constructor(
    private readonly world: HTMLElement,
    private readonly replica: Replica,
    private readonly options: RendererOptions = {},
  ) {
    const signal = this.abort.signal;
    // Designs are view-only: links and forms inside them do nothing.
    for (const type of ["click", "auxclick", "submit"]) {
      world.addEventListener(type, (e) => e.preventDefault(), { capture: true, signal });
    }
    if (options.live) window.addEventListener("message", (e) => this.onMessage(e), { signal });
  }

  dispose() {
    this.abort.abort();
    this.culler.dispose();
    this.resizes?.disconnect();
    for (const frame of this.frames.values()) {
      clearTimeout(frame.reload);
      clearTimeout(frame.rebuild);
    }
    this.queue.clear();
  }

  /** Rebuilds everything from the replica. */
  reset() {
    for (const frame of this.frames.values()) {
      clearTimeout(frame.reload);
      clearTimeout(frame.rebuild);
      this.discard(frame);
      frame.root.remove();
    }
    this.frames.clear();
    this.queue.clear();
    this.culler.clear();
    this.elements.clear();
    this.scripts.clear();
    this.instances.clear();
    this.instanceScripts.clear();
    this.virtuals.clear();
    for (const node of this.replica.nodes.values()) {
      if (isScript(node)) this.scripts.add(node.id);
      if (node.instanceOf !== undefined) this.instances.add(node.id);
    }
    // Loading a snapshot marks nothing, but don't let a stale list linger.
    this.replica.takeDirty();
    for (const board of this.replica.artboards()) this.mount(board);
  }

  /**
   * Sets the canvas area that's on screen, plus a margin, and hides the
   * artboards outside it (`null`: show them all). A hidden artboard costs
   * no layout or paint, and a sandboxed one is unloaded, which also stops
   * its scripts. Both come back when the area reaches them.
   *
   * An artboard is measured while shown and keeps that size while hidden,
   * so `artboardBounds` and "fit to view" still see it. Until it's
   * measured it stays drawn. Passes run once per frame.
   *
   * Below a zoom the artboards in view are drawn as cached bitmaps too
   * (see `./lod`), and as live DOM again above it.
   */
  setViewport(area: Bounds | null, zoom = 1) {
    this.culler.setArea(area);
    const zoomed = zoom !== this.zoom;
    this.zoom = zoom;
    this.center = area && { x: area.x + area.width / 2, y: area.y + area.height / 2 };
    const bitmaps = area !== null && wantsBitmaps(zoom, this.bitmaps);
    // A pan changes which artboards are in view, which the culler reports one by one;
    // only a new mode or zoom asks every artboard.
    if (bitmaps !== this.bitmaps || (bitmaps && zoomed)) {
      this.bitmaps = bitmaps;
      this.syncBitmaps();
    }
  }

  private setCulled(id: string, frame: Frame, culled: boolean) {
    if (!culled) {
      // A component edited while this was hidden may have changed how it
      // renders (it gained or lost a script): build it the right way now.
      const node = this.replica.get(id);
      if (node && (frame.iframe !== null) !== this.isLive(id)) {
        this.remount(node);
        return;
      }
    }
    frame.root.style.display = culled ? "none" : "";
    // Bitmaps in view can't be dropped, so hiding one is when it can be.
    if (culled) this.evict("");
    if (!culled && this.bitmaps) {
      // A bitmap that's still current comes back as it was, without loading the iframe.
      if (frame.bitmap && frame.bitmapVersion === frame.version) {
        this.showBitmap(frame);
        if (this.blurry(frame)) this.enqueue(id);
        return;
      }
      // An edit made while it was hidden left the bitmap stale: draw live DOM
      // until a new one is built, instead of showing the old.
      const wasShown = frame.shown;
      if (wasShown) this.showLive(id, frame);
      this.enqueue(id);
      if (wasShown) return;
    }
    if (!frame.iframe) return;
    clearTimeout(frame.reload);
    if (culled) this.unload(frame.iframe, frame);
    else this.load(id, frame.iframe);
  }

  /** Loads a sandboxed artboard's latest document. */
  private load(id: string, iframe: HTMLIFrameElement) {
    iframe.srcdoc = artboardDocument(this.replica, id);
  }

  /** Empties a sandboxed artboard's iframe, which stops its scripts, and forgets what it said about its layout. */
  private unload(iframe: HTMLIFrameElement, frame: Frame) {
    clearTimeout(frame.reload);
    iframe.srcdoc = "";
    delete frame.hit;
    delete frame.asked;
    frame.rects.clear();
    frame.pendingRects.clear();
  }

  /** Brings the artboards in view in line with `this.bitmaps`: draws or queues bitmaps, or goes back to live DOM. */
  private syncBitmaps() {
    for (const [id, frame] of this.frames) {
      if (!this.bitmaps) {
        if (frame.shown) this.showLive(id, frame);
        // Live DOM is what's on screen now; the pixels aren't worth holding.
        this.discard(frame);
      } else if (!this.culler.isCulled(id)) {
        if (!frame.shown) {
          if (frame.bitmap && frame.bitmapVersion === frame.version) this.showBitmap(frame);
          else this.enqueue(id);
        }
        // Zoomed in since it was drawn: draw it again sharper, and show this one meanwhile.
        if (frame.shown && this.blurry(frame)) this.enqueue(id);
      }
    }
  }

  private enqueue(id: string) {
    const frame = this.frames.get(id);
    if (!frame || frame.iframe || frame.failed === frame.version) return;
    this.queue.add(id);
    if (this.pumping) return;
    this.pumping = true;
    void this.pump();
  }

  /** Builds the queued bitmaps, one per animation frame, in the order they were asked for. */
  private async pump() {
    try {
      for (;;) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const id = this.queue.values().next().value;
        if (id === undefined) return;
        this.queue.delete(id);
        const frame = this.frames.get(id);
        if (frame && this.bitmaps && !this.culler.isCulled(id)) await this.drawBitmap(id, frame);
      }
    } finally {
      this.pumping = false;
    }
  }

  /** Draws the artboard into a canvas from the replica, and shows it if bitmaps are on. */
  private async drawBitmap(id: string, frame: Frame) {
    // A current bitmap being drawn again sharper keeps its size, and so avoids a layout.
    const size =
      frame.shown && frame.bitmapVersion === frame.version && frame.bitmapSize
        ? frame.bitmapSize
        : this.liveSize(frame);
    if (!size) return;
    const version = frame.version;
    const scale = this.scaleFor(size);
    const model = designModel();
    const css = `@layer ${BASE_LAYER} { ${model.baseCss} }${
      this.replica.css === null ? "" : model.sharedStyle(this.replica.css, false)
    }`;
    let canvas: HTMLCanvasElement;
    try {
      canvas = await (this.options.rasterize ?? rasterize)(
        this.replica.exportHtml(id, true),
        css,
        size.width,
        size.height,
        scale,
      );
    } catch {
      // The browser couldn't draw it; the artboard stays live.
      frame.failed = version;
      return;
    }
    // Edited while drawing: that bitmap is out of date. Wait for the next pause.
    if (this.frames.get(id) !== frame || frame.version !== version) return;
    frame.built = Date.now();
    frame.bitmapSize = size;
    frame.bitmapVersion = version;
    frame.bitmapScale = scale;
    canvas.className = stylex.props(styles.bitmap).className ?? "";
    this.discard(frame);
    frame.bitmap = canvas;
    this.setPixels(this.pixels + canvas.width * canvas.height);
    this.evict(id);
    // Its size may have changed with the edit: measure it again.
    this.culler.touch(id);
    if (this.bitmaps && !this.culler.isCulled(id)) this.showBitmap(frame);
  }

  /** The scale to draw an artboard of `size` at, at the current zoom. */
  private scaleFor(size: { readonly width: number; readonly height: number }): number {
    return bitmapScale(size.width, size.height, window.devicePixelRatio || 1, this.zoom);
  }

  /** Whether the bitmap was drawn at less than 1/BLUR_FACTOR of the scale the zoom now calls for. */
  private blurry(frame: Frame): boolean {
    return (
      frame.bitmapSize !== undefined &&
      frame.bitmapScale !== undefined &&
      frame.bitmapScale * BLUR_FACTOR < this.scaleFor(frame.bitmapSize)
    );
  }

  /** Drops the artboard's bitmap. */
  private discard(frame: Frame) {
    if (!frame.bitmap) return;
    this.setPixels(this.pixels - frame.bitmap.width * frame.bitmap.height);
    frame.bitmap.remove();
    delete frame.bitmap;
  }

  /** Records the pixels bitmaps hold, and shows it as `data-bitmap-pixels` on the world, for the bench. */
  private setPixels(pixels: number) {
    this.pixels = pixels;
    this.world.dataset.bitmapPixels = String(pixels);
  }

  /**
   * Drops bitmaps, farthest from the view first, until they fit the budget.
   * Those in view stay, and so does the one just built (`keep`).
   */
  private evict(keep: string) {
    const budget = this.options.bitmapBudget ?? BITMAP_BUDGET;
    if (this.pixels <= budget) return;
    const candidates = [];
    for (const [id, frame] of this.frames) {
      if (!frame.bitmap || id === keep) continue;
      if (this.bitmaps && !this.culler.isCulled(id)) continue;
      const box = this.culler.box(id);
      const distance =
        box && this.center
          ? Math.hypot(
              box.x + box.width / 2 - this.center.x,
              box.y + box.height / 2 - this.center.y,
            )
          : 0;
      candidates.push({ id, pixels: frame.bitmap.width * frame.bitmap.height, distance });
    }
    for (const id of evictionPlan(candidates, this.pixels, budget)) {
      const frame = this.frames.get(id)!;
      // An evicted artboard that's still shown as a bitmap goes back to live DOM, hidden by culling.
      if (frame.shown) this.showLive(id, frame);
      this.discard(frame);
    }
  }

  /**
   * The artboard's size now. One drawn as a bitmap isn't laid out, so its
   * live DOM is shown for a moment (nothing paints in between) to measure it.
   */
  private liveSize(frame: Frame): { readonly width: number; readonly height: number } | null {
    const hidden = frame.shown;
    if (hidden) this.setLive(frame, true);
    const width = frame.root.offsetWidth;
    const height = frame.root.offsetHeight;
    if (hidden) this.setLive(frame, false);
    return width === 0 && height === 0 ? null : { width, height };
  }

  /** Shows or hides the artboard's live content, keeping its box the size it has. */
  private setLive(frame: Frame, live: boolean) {
    const inner = frame.shadow ? frame.content.firstElementChild : frame.iframe;
    if (inner instanceof HTMLElement) inner.style.display = live ? "" : "none";
    const size = frame.bitmapSize;
    frame.content.style.width = live || !size ? "" : `${size.width}px`;
    frame.content.style.height = live || !size ? "" : `${size.height}px`;
  }

  private showBitmap(frame: Frame) {
    if (!frame.bitmap || !frame.bitmapSize) return;
    if (!frame.shown) {
      frame.shown = true;
      frame.root.dataset.lod = "bitmap";
    }
    // The bitmap may have been built at another size than the box has now.
    this.setLive(frame, false);
    if (frame.bitmap.parentElement !== frame.content) frame.content.append(frame.bitmap);
  }

  private showLive(id: string, frame: Frame) {
    frame.shown = false;
    delete frame.root.dataset.lod;
    this.setLive(frame, true);
    frame.bitmap?.remove();
    this.culler.touch(id);
    if (frame.iframe && !this.culler.isCulled(id)) this.load(id, frame.iframe);
  }

  /** An edit changed the artboard: its bitmap is out of date, and is rebuilt once edits pause. */
  private invalidate(id: string, frame: Frame) {
    frame.version++;
    clearTimeout(frame.rebuild);
    if (!this.bitmaps) {
      // Live DOM is current; a new bitmap is built when zooming out again.
      this.discard(frame);
      return;
    }
    frame.rebuild = setTimeout(
      () => {
        if (this.frames.get(id) === frame && this.bitmaps) this.enqueue(id);
      },
      rebuildDelay(Date.now(), frame.built),
    );
  }

  /** Shows only the artboards on `page` (`null`: the first page). */
  setPage(page: string | null) {
    this.page = page;
    this.syncPage();
  }

  /** The page shown: the one asked for, or the first page if it's gone. */
  shownPage(): string {
    const { pages } = this.replica;
    return pages.some((p) => p.id === this.page) ? this.page! : pages[0]!.id;
  }

  /** Mounts the shown page's artboards and unmounts the rest. */
  private syncPage() {
    const page = this.shownPage();
    for (const board of this.replica.artboards()) this.syncBoard(board, page);
  }

  /** Mounts or unmounts one artboard, by whether it's on `page`. */
  private syncBoard(board: Node, page: string) {
    const shown = this.replica.pageOf(board) === page;
    if (shown && !this.frames.has(board.id)) this.mount(board);
    else if (!shown && this.frames.has(board.id))
      for (const id of this.replica.subtree(board.id)) this.unmount(id);
  }

  apply(applied: Applied) {
    if (applied.op === "page") {
      // Removing a page moves its artboards to the first page.
      this.syncPage();
      return;
    }
    if (applied.op === "set" && applied.key === "page") {
      if (applied.node.parent === null) this.syncBoard(applied.node, this.shownPage());
      return;
    }
    if (applied.op === "css") {
      // Every artboard uses it: restyle shadow roots, reload sandboxed ones.
      const css = this.sharedCss();
      for (const [id, frame] of this.frames) {
        if (frame.sharedStyle) frame.sharedStyle.textContent = css;
        else this.scheduleReload(id, frame);
        this.invalidate(id, frame);
      }
      return;
    }
    const boards = this.touchedBoards(applied);
    if (applied.op === "create" && isScript(applied.node)) this.scripts.add(applied.node.id);
    if (applied.op === "delete") {
      for (const id of applied.removed) {
        this.scripts.delete(id);
        this.instances.delete(id);
        this.instanceScripts.delete(id);
      }
    } else if (applied.node.instanceOf !== undefined) this.instances.add(applied.node.id);
    else this.instances.delete(applied.node.id);

    // Patch shadow-root artboards in place. This is a no-op for sandboxed ones.
    this.patch(applied);

    // Then rebuild artboards whose mode changed, and reload sandboxed ones.
    const layoutOnly =
      applied.op === "set" &&
      applied.node.parent === null &&
      ["name", "x", "y"].includes(applied.key);
    for (const id of boards) {
      const frame = this.frames.get(id);
      const node = this.replica.get(id);
      if (!frame || !node) continue;
      if (!layoutOnly) this.culler.touch(id);
      if ((frame.iframe !== null) !== this.isLive(id)) this.remount(node);
      else if (!layoutOnly) {
        this.invalidate(id, frame);
        if (frame.iframe) this.scheduleReload(id, frame);
      }
    }
  }

  /**
   * Draws again the instances a change touched: an edit to a component
   * changes what every instance of it shows, and an instance's overrides
   * change only it. Call after a change's ops have all applied, since an
   * instance is expanded from the document as it ends up.
   */
  flush() {
    const boards = new Set<string>();
    for (const id of this.replica.takeDirty()) {
      this.instanceScripts.delete(id);
      const node = this.replica.get(id);
      const board = this.replica.artboardOf(id);
      if (!node || !board) continue;
      boards.add(board.id);
      const frame = this.frames.get(board.id);
      if (!frame || frame.iframe) continue;
      // Draw it again only where it's drawn now.
      if (node.parent !== null && !this.elements.has(id)) continue;
      for (const sub of this.replica.subtree(id)) this.unmount(sub);
      this.mount(node);
    }
    for (const id of boards) {
      const frame = this.frames.get(id);
      const node = this.replica.get(id);
      if (!frame || !node) continue;
      // What the instance shows may be a different size now.
      this.culler.touch(id);
      // A hidden artboard is built, or loaded, again when it's shown: the
      // new content is read then, so a hidden iframe stays unloaded.
      if (this.culler.isCulled(id)) continue;
      if ((frame.iframe !== null) !== this.isLive(id)) this.remount(node);
      else if (frame.iframe) this.scheduleReload(id, frame);
    }
  }

  /** Canvas-space bounds of every artboard, as rendered. */
  artboardBounds(): Map<string, Bounds> {
    const out = new Map<string, Bounds>();
    for (const [id, frame] of this.frames) {
      const node = this.replica.get(id);
      // A hidden artboard has no layout, so it reports the size it had when last shown.
      const size = (this.culler.isCulled(id) && this.culler.size(id)) || {
        width: frame.root.offsetWidth,
        height: frame.root.offsetHeight,
      };
      out.set(id, { x: node?.x ?? 0, y: node?.y ?? 0, ...size });
    }
    return out;
  }

  /**
   * The topmost artboard under a page point, and the element in it. A
   * sandboxed artboard answers later, so this returns its latest answer,
   * even for another point, unless `exact` is set: then it's `null` until
   * the answer for this point arrives.
   */
  hitTest(clientX: number, clientY: number, exact = false): Hit | null {
    const frames = [...this.frames];
    for (let i = frames.length - 1; i >= 0; i--) {
      const [artboardId, frame] = frames[i]!;
      const rect = frame.content.getBoundingClientRect();
      if (
        clientX < rect.left ||
        clientX >= rect.right ||
        clientY < rect.top ||
        clientY >= rect.bottom
      ) {
        continue;
      }
      // A bitmap has no live nodes to ask, so it answers with the artboard.
      if (frame.shown) return { artboardId, nodeId: artboardId };
      if (frame.iframe) {
        const nodeId = this.askHit(frame, clientX, clientY, exact);
        if (exact && nodeId === null) return null;
        return { artboardId, nodeId: nodeId ?? artboardId };
      }
      let el = frame.shadow?.elementFromPoint(clientX, clientY) ?? null;
      while (el && !this.ids.has(el)) el = el.parentElement;
      return { artboardId, nodeId: (el && this.ids.get(el)) ?? artboardId };
    }
    return null;
  }

  /**
   * Asks a sandboxed artboard what's under a page point. The answer arrives
   * by message, so this returns the latest one for that point, if any.
   */
  private askHit(frame: Frame, clientX: number, clientY: number, exact: boolean): string | null {
    const iframe = frame.iframe!;
    const { left, top, scale } = iframeBox(iframe);
    const x = Math.round((clientX - left) / scale);
    const y = Math.round((clientY - top) / scale);
    if (frame.asked?.x !== x || frame.asked?.y !== y) {
      frame.asked = { x, y };
      iframe.contentWindow?.postMessage({ finite: { type: "hit", x, y } }, "*");
    }
    if (frame.hit?.x === x && frame.hit.y === y) return frame.hit.id;
    return exact ? null : (frame.hit?.id ?? null);
  }

  /**
   * Where a node is drawn, in page coordinates. For a node in a sandboxed
   * artboard, this is the artboard until the iframe reports the node's position.
   */
  nodeRect(id: string): DOMRect | null {
    // A hidden artboard has no layout; use the box it had when last shown.
    const hidden = this.replica.artboardOf(id);
    if (hidden && this.culler.isCulled(hidden.id)) {
      const box = this.culler.box(hidden.id);
      if (!box || !this.options.toPage) return null;
      const r = pageBox(box, this.options.toPage);
      return new DOMRect(r.x, r.y, r.width, r.height);
    }
    // Hidden behind a bitmap, a node has no layout either: report the artboard.
    if (hidden && this.frames.get(hidden.id)?.shown) {
      return this.frames.get(hidden.id)!.content.getBoundingClientRect();
    }
    const el = this.elements.get(id);
    if (el?.isConnected) {
      if (el instanceof Element) return el.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(el);
      return range.getBoundingClientRect();
    }
    const board = this.replica.artboardOf(id);
    const frame = board && this.frames.get(board.id);
    if (!frame) return null;
    if (frame.iframe && id !== board.id) {
      const known = frame.rects.get(id);
      if ((!known || performance.now() - known.at > RECT_TTL_MS) && !frame.pendingRects.has(id)) {
        frame.pendingRects.add(id);
        frame.iframe.contentWindow?.postMessage({ finite: { type: "rect", id } }, "*");
      }
      if (known) {
        const { left, top, scale } = iframeBox(frame.iframe);
        const r = known.rect;
        return new DOMRect(
          left + r.x * scale,
          top + r.y * scale,
          r.width * scale,
          r.height * scale,
        );
      }
    }
    return frame.content.getBoundingClientRect();
  }

  /** In comment mode, clicks over sandboxed artboards go to the canvas instead of the artboard. */
  setCommenting(commenting: boolean) {
    this.commenting = commenting;
    for (const frame of this.frames.values()) this.showCommenting(frame);
  }

  private showCommenting(frame: Frame) {
    if (frame.iframe) frame.iframe.style.pointerEvents = this.commenting ? "none" : "";
    if (frame.commentStyle) frame.commentStyle.textContent = this.commenting ? COMMENTING_CSS : "";
  }

  /** Marks artboards that agents are working on, keyed by artboard id. */
  setWorking(working: ReadonlyMap<string, string>) {
    this.working = working;
    for (const [id, frame] of this.frames) this.showWorking(frame, working.get(id));
  }

  private showWorking(frame: Frame, label: string | undefined) {
    frame.badge.textContent = label ?? "";
    frame.badge.hidden = label === undefined;
    frame.root.className =
      stylex.props(styles.frame, label !== undefined && styles.working).className ?? "";
  }

  private isLive(board: string) {
    if (!this.options.live) return false;
    for (const id of this.scripts) if (this.replica.artboardOf(id)?.id === board) return true;
    // An instance runs its component's scripts too.
    for (const id of this.instances) {
      if (this.replica.artboardOf(id)?.id !== board) continue;
      let scripted = this.instanceScripts.get(id);
      if (scripted === undefined) {
        scripted = this.replica.expand(id).some(isScript);
        this.instanceScripts.set(id, scripted);
      }
      if (scripted) return true;
    }
    return false;
  }

  /** Artboards an op changed: where its node is now, and where it was before. */
  private touchedBoards(applied: Exclude<Applied, { op: "css" | "page" }>): Set<string> {
    const boards = new Set<string>();
    const add = (id: string | null) => {
      const board = id === null ? undefined : this.replica.artboardOf(id);
      if (board) boards.add(board.id);
    };
    if (applied.op === "delete") add(applied.parent);
    else add(applied.node.id);
    if (applied.op === "move") add(applied.from);
    return boards;
  }

  private patch(applied: Exclude<Applied, { op: "css" | "page" }>) {
    switch (applied.op) {
      case "create":
        this.mount(applied.node);
        return;
      case "delete":
        for (const id of applied.removed) this.unmount(id);
        return;
      case "move":
        for (const id of this.replica.subtree(applied.node.id)) this.unmount(id);
        this.mount(applied.node);
        return;
      case "set":
        this.update(applied.node, applied.key);
        return;
    }
  }

  private remount(board: Node) {
    for (const id of this.replica.subtree(board.id)) this.unmount(id);
    this.mount(board);
  }

  /** Builds `node` and its subtree, and inserts it in sibling order. */
  private mount(node: Node) {
    if (node.parent === null) {
      if (node.type !== "element" || this.replica.pageOf(node) !== this.shownPage()) return;
      const frame = this.createFrame(node, this.isLive(node.id));
      this.frames.set(node.id, frame);
      this.world.append(frame.root);
      this.showWorking(frame, this.working.get(node.id));
      this.showCommenting(frame);
      if (frame.shadow) this.build(node, frame.shadow, false);
      this.culler.add(node.id, node.x ?? 0, node.y ?? 0);
      this.resizes?.observe(frame.root);
      if (this.bitmaps) this.enqueue(node.id);
      return;
    }
    // Nodes in sandboxed artboards have no element here, so this skips them.
    const parent = this.elements.get(node.parent);
    if (!(parent instanceof Element)) return;
    const el = this.build(
      node,
      null,
      parent.namespaceURI === SVG_NS && parent.localName !== "foreignObject",
    );
    parent.insertBefore(el, this.nextSiblingElement(node));
  }

  private nextSiblingElement(node: Node): ChildNode | null {
    for (const sibling of this.replica.siblingsAfter(node.id)) {
      const el = this.elements.get(sibling.id);
      if (el) return el;
    }
    return null;
  }

  /** Creates the DOM for `node` and its descendants. Appends to `container` when given. */
  private build(node: Node, container: ParentNode | null, inSvg: boolean): Element | Text {
    if (node.instanceOf !== undefined) return this.buildInstance(node, container, inSvg);
    const el = this.create(node, inSvg);
    if (el instanceof Element) {
      const childSvg = (inSvg || node.tag === "svg") && node.tag !== "foreignObject";
      for (const child of this.replica.children(node.id)) {
        el.appendChild(this.build(child, null, childSvg));
      }
    }
    container?.appendChild(el);
    return el;
  }

  /**
   * Draws instance `node` as its component, expanded by the Rust rules.
   * The elements inside it are registered under their virtual ids, so
   * hit tests and comments can point at them.
   */
  private buildInstance(node: Node, container: ParentNode | null, inSvg: boolean): Element | Text {
    const [root, ...inside] = this.replica.expand(node.id);
    const children = new Map<string, Node[]>();
    for (const n of inside) {
      if (n.parent === null) continue;
      let list = children.get(n.parent);
      if (!list) children.set(n.parent, (list = []));
      list.push(n);
    }
    const drawn: string[] = [];
    const draw = (n: Node, svg: boolean): Element | Text => {
      const el = this.create(n, svg);
      if (n.id !== node.id) drawn.push(n.id);
      if (el instanceof Element) {
        const childSvg = (svg || n.tag === "svg") && n.tag !== "foreignObject";
        for (const child of children.get(n.id) ?? []) el.appendChild(draw(child, childSvg));
      }
      return el;
    };
    const el = draw(root ?? node, inSvg);
    this.virtuals.set(node.id, drawn);
    container?.appendChild(el);
    return el;
  }

  /** One node's own element or text, registered under its id, without its children. */
  private create(node: Node, inSvg: boolean): Element | Text {
    let el: Element | Text;
    if (node.type === "text") {
      el = document.createTextNode(node.text ?? "");
    } else {
      const tag = node.tag ?? "div";
      const svg = inSvg || tag === "svg";
      if (BLOCKED_TAGS.has(tag.toLowerCase())) {
        el = document.createElement("div");
        (el as HTMLElement).hidden = true;
      } else {
        el = svg ? document.createElementNS(SVG_NS, tag) : document.createElement(tag);
        for (const [name, value] of Object.entries(node.attrs)) setAttr(el, name, value);
        for (const [name, value] of Object.entries(node.styles)) setStyle(el, name, value);
      }
      this.ids.set(el, node.id);
    }
    this.elements.set(node.id, el);
    return el;
  }

  private unmount(id: string) {
    const frame = this.frames.get(id);
    if (frame) {
      clearTimeout(frame.reload);
      clearTimeout(frame.rebuild);
      this.queue.delete(id);
      this.discard(frame);
      frame.root.remove();
      this.frames.delete(id);
      this.culler.remove(id);
      this.resizes?.unobserve(frame.root);
    }
    this.elements.get(id)?.remove();
    this.elements.delete(id);
    for (const inside of this.virtuals.get(id) ?? []) this.elements.delete(inside);
    this.virtuals.delete(id);
  }

  private update(node: Node, key: string) {
    const el = this.elements.get(node.id);
    const frame = this.frames.get(node.id);
    // An instance shows its component, so `flush` draws it again instead.
    const instance = node.instanceOf !== undefined || key === "instanceOf";
    if (instance && !["name", "x", "y"].includes(key)) return;
    if (key === "text") {
      if (el instanceof Text) el.data = node.text ?? "";
    } else if (key === "name") {
      if (frame) frame.label.textContent = labelOf(node);
    } else if (key === "x" || key === "y") {
      if (frame) {
        positionFrame(frame.root, node);
        this.culler.move(node.id, node.x ?? 0, node.y ?? 0);
      }
    } else if (key.startsWith("style:") && el instanceof Element) {
      const name = key.slice(6);
      const value = node.styles[name];
      if (value === undefined) styleOf(el)?.removeProperty(name);
      else setStyle(el, name, value);
    } else if (key.startsWith("attr:") && el instanceof Element) {
      const name = key.slice(5);
      const value = node.attrs[name];
      if (value === undefined) el.removeAttribute(name);
      else setAttr(el, name, value);
    }
  }

  private createFrame(node: Node, live: boolean): Frame {
    const root = document.createElement("div");
    root.dataset.artboard = node.id;
    positionFrame(root, node);

    const label = document.createElement("div");
    label.className = stylex.props(styles.label).className ?? "";
    label.textContent = labelOf(node);

    const badge = document.createElement("div");
    badge.className = stylex.props(styles.badge).className ?? "";

    // Paint containment keeps content (even `position: fixed`) inside the frame.
    const content = document.createElement("div");
    content.className = stylex.props(styles.content).className ?? "";
    root.append(label, badge, content);

    if (live) {
      const iframe = document.createElement("iframe");
      iframe.sandbox.add("allow-scripts");
      iframe.title = labelOf(node);
      iframe.className = stylex.props(styles.iframe).className ?? "";
      const size = pixelSize(node);
      iframe.style.width = `${size.width ?? 1440}px`;
      iframe.style.height = `${size.height ?? 900}px`;
      iframe.srcdoc = artboardDocument(this.replica, node.id);
      content.append(iframe);
      return {
        root,
        label,
        badge,
        content,
        shadow: null,
        commentStyle: null,
        sharedStyle: null,
        iframe,
        shown: false,
        version: 0,
        built: 0,
        rects: new Map(),
        pendingRects: new Set(),
      };
    }

    const host = document.createElement("div");
    host.className = stylex.props(styles.host).className ?? "";
    const shadow = host.attachShadow({ mode: "open" });
    // The constructor cancels clicks and submits on the whole canvas, but
    // `submit` isn't composed, so it stops at this shadow root. A form with
    // one text field and no button submits on Enter without any click, and
    // would send what someone typed to its action and navigate this tab.
    shadow.addEventListener("submit", (event) => event.preventDefault(), {
      signal: this.abort.signal,
    });
    // In a layer, so the shared CSS can set what `HOST_CSS` resets, like
    // the font on `:root`.
    const base = document.createElement("style");
    base.textContent = `@layer ${BASE_LAYER} { ${HOST_CSS} ${designModel().baseCss} }`;
    const sharedStyle = document.createElement("style");
    sharedStyle.textContent = this.sharedCss();
    const commentStyle = document.createElement("style");
    shadow.append(base, sharedStyle, commentStyle);
    content.append(host);
    return {
      root,
      label,
      badge,
      content,
      shadow,
      commentStyle,
      sharedStyle,
      iframe: null,
      shown: false,
      version: 0,
      built: 0,
      rects: new Map(),
      pendingRects: new Set(),
    };
  }

  /** The shared CSS as a shadow root's `<style>` text, or nothing. */
  private sharedCss(): string {
    const { css } = this.replica;
    return css === null ? "" : designModel().sharedStyle(css, true);
  }

  private scheduleReload(id: string, frame: Frame) {
    clearTimeout(frame.reload);
    // A hidden artboard loads its latest version when it's shown again.
    if (this.culler.isCulled(id) || frame.shown) return;
    frame.reload = setTimeout(() => {
      if (
        this.frames.get(id) === frame &&
        frame.iframe &&
        !this.culler.isCulled(id) &&
        !frame.shown
      ) {
        this.load(id, frame.iframe);
        // A new document: earlier answers about its layout no longer hold.
        delete frame.hit;
        delete frame.asked;
        frame.rects.clear();
        frame.pendingRects.clear();
      }
    }, RELOAD_DELAY_MS);
  }

  /** Handles messages from the runtime in sandboxed artboards (see `./html`). */
  private onMessage(event: MessageEvent) {
    let found: [string, Frame] | undefined;
    for (const entry of this.frames) {
      if (entry[1].iframe && entry[1].iframe.contentWindow === event.source) found = entry;
    }
    const message: unknown = (event.data as { finite?: unknown } | null)?.finite;
    if (!found || typeof message !== "object" || message === null) return;
    const [boardId, frame] = found;
    const iframe = frame.iframe!;
    const m = message as Record<string, unknown>;
    const num = (key: string) =>
      typeof m[key] === "number" && Number.isFinite(m[key]) ? (m[key] as number) : 0;
    // The artboard's own scripts can post too, so only trust ids of nodes in this artboard.
    const nodeInBoard = (value: unknown) =>
      typeof value === "string" && this.replica.artboardOf(value)?.id === boardId ? value : null;
    const bounds = (value: unknown): Bounds | null => {
      const r = value as Record<string, unknown> | null;
      const ok = (k: string) => typeof r?.[k] === "number" && Number.isFinite(r[k]);
      return r && ok("x") && ok("y") && ok("width") && ok("height")
        ? {
            x: r.x as number,
            y: r.y as number,
            width: r.width as number,
            height: r.height as number,
          }
        : null;
    };
    if (m.type === "hit") {
      const id = nodeInBoard(m.id);
      const rect = bounds(m.rect);
      if (id && rect) frame.rects.set(id, { rect, at: performance.now() });
      const changed = frame.hit?.id !== id;
      frame.hit = { x: num("x"), y: num("y"), id };
      if (changed) this.options.onLayout?.();
    } else if (m.type === "rect") {
      const id = nodeInBoard(m.id);
      if (!id) return;
      frame.pendingRects.delete(id);
      const rect = bounds(m.rect);
      if (!rect) return;
      const before = frame.rects.get(id)?.rect;
      frame.rects.set(id, { rect, at: performance.now() });
      const moved =
        !before ||
        before.x !== rect.x ||
        before.y !== rect.y ||
        before.width !== rect.width ||
        before.height !== rect.height;
      if (moved) this.options.onLayout?.();
    } else if (m.type === "size") {
      const fit = (n: number) => `${Math.min(MAX_SIDE, Math.max(1, n))}px`;
      const [width, height] = [fit(num("width")), fit(num("height"))];
      const changed = iframe.style.width !== width || iframe.style.height !== height;
      this.culler.touch(boardId);
      iframe.style.width = width;
      iframe.style.height = height;
      if (changed) this.options.onResize?.();
    } else if (m.type === "wheel" && this.options.onWheel) {
      // The iframe's content is unscaled; the canvas zoom scales its box.
      const rect = iframe.getBoundingClientRect();
      const scale = iframe.offsetWidth > 0 ? rect.width / iframe.offsetWidth : 1;
      this.options.onWheel({
        deltaX: num("deltaX"),
        deltaY: num("deltaY"),
        deltaMode: num("deltaMode"),
        ctrlKey: m.ctrlKey === true,
        metaKey: m.metaKey === true,
        shiftKey: m.shiftKey === true,
        clientX: rect.left + num("clientX") * scale,
        clientY: rect.top + num("clientY") * scale,
      });
    }
  }
}

/** Where an iframe's content sits on the page, and how much the canvas zoom scales it. */
function iframeBox(iframe: HTMLIFrameElement) {
  const rect = iframe.getBoundingClientRect();
  const scale = iframe.offsetWidth > 0 ? rect.width / iframe.offsetWidth : 1;
  return { left: rect.left, top: rect.top, scale };
}

function labelOf(node: Node) {
  return node.name ?? node.tag ?? "Artboard";
}

function positionFrame(root: HTMLElement, node: Node) {
  root.style.transform = `translate(${node.x ?? 0}px, ${node.y ?? 0}px)`;
}

function styleOf(el: Element): CSSStyleDeclaration | undefined {
  return (el as HTMLElement | SVGElement).style;
}

function setStyle(el: Element, name: string, value: string) {
  const important = /!\s*important\s*$/i.test(value);
  styleOf(el)?.setProperty(
    name,
    important ? value.replace(/!\s*important\s*$/i, "").trim() : value,
    important ? "important" : "",
  );
}

/** Sets an attribute the server's own check (`html::is_safe_attr`) allows. */
function setAttr(el: Element, name: string, value: string) {
  if (!designModel().isSafeAttr(name, value)) return;
  try {
    el.setAttribute(name, value);
  } catch {
    // Invalid attribute names are ignored, as the HTML parser would.
  }
}

const styles = stylex.create({
  frame: {
    position: "absolute",
    left: 0,
    top: 0,
    boxShadow: "0 1px 3px rgba(0, 0, 0, 0.12), 0 0 0 1px rgba(0, 0, 0, 0.06)",
  },
  working: {
    outline: `calc(2px * var(--inv-zoom, 1)) solid ${colors.accent}`,
  },
  label: {
    position: "absolute",
    left: 0,
    bottom: "100%",
    paddingBottom: 4,
    fontSize: 12,
    lineHeight: 1.3,
    color: colors.muted,
    whiteSpace: "nowrap",
    transform: "scale(var(--inv-zoom, 1))",
    transformOrigin: "bottom left",
    fontFamily: "ui-sans-serif, system-ui, sans-serif",
  },
  badge: {
    position: "absolute",
    right: 0,
    bottom: "100%",
    marginBottom: 4,
    paddingBlock: 2,
    paddingInline: 6,
    borderRadius: 4,
    fontSize: 11,
    lineHeight: 1.3,
    color: colors.onAccent,
    backgroundColor: colors.accent,
    whiteSpace: "nowrap",
    transform: "scale(var(--inv-zoom, 1))",
    transformOrigin: "bottom right",
    fontFamily: "ui-sans-serif, system-ui, sans-serif",
  },
  content: {
    contain: "layout paint",
  },
  bitmap: {
    position: "absolute",
    left: 0,
    top: 0,
    width: "100%",
    height: "100%",
  },
  host: {
    display: "block",
  },
  iframe: {
    display: "block",
    borderWidth: 0,
    colorScheme: "normal",
  },
});
