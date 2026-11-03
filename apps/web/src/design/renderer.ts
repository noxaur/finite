import * as stylex from "@stylexjs/stylex";
import { colors } from "@/styles/tokens.stylex";
import { Culler, pageBox } from "./culling";
import { artboardDocument, BASE_LAYER, pixelSize } from "./html";
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

/** How long a sandboxed artboard waits for edits to settle before reloading. */
const RELOAD_DELAY_MS = 150;
/**
 * How long a hidden sandboxed artboard keeps its document. Showing it again
 * before then is instant, and its scripts carry on where they were instead
 * of starting over, so panning back and forth doesn't reload it each time.
 */
const UNLOAD_DELAY_MS = 30_000;
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
  /** Holds the design's tokens in the artboard's mode, before its own styles. */
  readonly tokenStyle: HTMLStyleElement | null;
  /** Set for artboards with scripts, rendered in a sandboxed iframe. */
  readonly iframe: HTMLIFrameElement | null;
  /**
   * Set while an auto-sized iframe hasn't reported its size: until then it
   * has a placeholder size, which a restored view far down a tall artboard
   * could miss, culling it before it can report.
   */
  awaitingSize?: boolean;
  reload?: ReturnType<typeof setTimeout>;
  /** Unloads a hidden iframe once it has stayed hidden for `UNLOAD_DELAY_MS`. */
  unload?: ReturnType<typeof setTimeout>;
  /** The iframe's document is unloaded or out of date, so it loads again when shown. */
  stale?: boolean;
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
/**
 * What the live DOM says about one drawn element, which a person's edit
 * needs to turn a drag into CSS: the document only holds inline styles,
 * and the cascade (`<style>` blocks, classes, the shared CSS) decides the rest.
 */
export interface Measured {
  /** The border box, in page pixels. */
  readonly rect: DOMRect;
  /** Page pixels per CSS pixel of the artboard: the camera's zoom. */
  readonly scale: number;
  readonly position: string;
  readonly display: string;
  readonly flexDirection: string;
  readonly flexWrap: string;
  readonly flexGrow: number;
  /**
   * With `box-sizing: content-box`, the padding and borders across and
   * down, in CSS pixels, which `width` and `height` leave out. 0 for `border-box`.
   */
  readonly frameX: number;
  readonly frameY: number;
  /** Resolved insets in CSS pixels, `NaN` for `auto`. */
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

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
  /** The element being typed into (`editText`), and what ends that, keeping the text. */
  private editing: HTMLElement | null = null;
  private finishText: (() => void) | null = null;
  /** The page shown, or `null` for the first page. Only its artboards are mounted. */
  private page: string | null = null;
  /** Hides artboards outside the view. A hidden sandboxed one has its iframe unloaded. */
  private readonly culler = new Culler(
    {
      measure: (id) => {
        const frame = this.frames.get(id);
        if (frame?.awaitingSize) return null;
        const root = frame?.root;
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
    for (const frame of this.frames.values()) clearTimers(frame);
  }

  /** Rebuilds everything from the replica. */
  reset() {
    for (const frame of this.frames.values()) {
      clearTimers(frame);
      frame.root.remove();
    }
    this.frames.clear();
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
   * no layout or paint, and a sandboxed one is unloaded once it has stayed
   * hidden for `UNLOAD_DELAY_MS`, which also stops its scripts. Both come
   * back when the area reaches them.
   *
   * An artboard is measured while shown and keeps that size while hidden,
   * so `artboardBounds` and "fit to view" still see it. Until it's
   * measured it stays drawn. Passes run once per frame.
   */
  setViewport(area: Bounds | null) {
    this.culler.setArea(area);
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
    const iframe = frame.iframe;
    if (!iframe) return;
    clearTimeout(frame.unload);
    if (culled) {
      // An edit waiting to reload it is loaded when it's shown instead.
      if (frame.reload !== undefined) frame.stale = true;
      clearTimeout(frame.reload);
      delete frame.reload;
      // Keep the document for a while: a hidden iframe isn't rendered, and
      // panning back to it shouldn't start its scripts over.
      frame.unload = setTimeout(() => {
        if (this.frames.get(id) !== frame || !this.culler.isCulled(id)) return;
        iframe.srcdoc = "";
        frame.stale = true;
        forgetLayout(frame);
      }, UNLOAD_DELAY_MS);
    } else if (frame.stale) {
      frame.stale = false;
      iframe.srcdoc = artboardDocument(this.replica, id);
      forgetLayout(frame);
    }
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
    // Before the document loads there are no pages, and no artboards to sync.
    if (this.replica.pages.length === 0) return;
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
    if (applied.op === "tokens") {
      // Every artboard uses them: restyle shadow roots, reload sandboxed ones.
      for (const [id, frame] of this.frames) this.restyleTokens(id, frame);
      return;
    }
    if (applied.op === "set" && applied.key === "mode") {
      const frame = this.frames.get(applied.node.id);
      if (frame) this.restyleTokens(applied.node.id, frame);
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
      else if (frame.iframe && !layoutOnly) this.scheduleReload(id, frame);
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
      // new content is read then, so a hidden iframe isn't reloaded now.
      if (this.culler.isCulled(id)) {
        if (frame.iframe) frame.stale = true;
        continue;
      }
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

  /**
   * Measures an element drawn in a shadow-root artboard, or an artboard
   * itself. `null` for text, for what's inside a sandboxed artboard (its
   * iframe can't be read from here) and for hidden artboards.
   */
  measure(id: string): Measured | null {
    const board = this.replica.artboardOf(id);
    const frame = board && this.frames.get(board.id);
    if (!frame || this.culler.isCulled(board.id)) return null;
    // A sandboxed artboard's box is its iframe's, which is drawn at the artboard's size.
    const el = frame.iframe ? (id === board.id ? frame.iframe : null) : this.elements.get(id);
    if (!(el instanceof Element) || !el.isConnected) return null;
    const css = getComputedStyle(el);
    const inset = (value: string) => (value.endsWith("px") ? parseFloat(value) : NaN);
    const width = frame.root.offsetWidth;
    const sum = (...values: string[]) => values.reduce((n, v) => n + (parseFloat(v) || 0), 0);
    const content = css.boxSizing === "content-box";
    return {
      rect: el.getBoundingClientRect(),
      scale: width > 0 ? frame.root.getBoundingClientRect().width / width : 1,
      // An artboard sits on the canvas by `x` and `y`, never by insets.
      position: id === board.id ? "static" : css.position,
      display: css.display,
      flexDirection: css.flexDirection,
      flexWrap: css.flexWrap,
      flexGrow: parseFloat(css.flexGrow) || 0,
      frameX: content
        ? sum(css.paddingLeft, css.paddingRight, css.borderLeftWidth, css.borderRightWidth)
        : 0,
      frameY: content
        ? sum(css.paddingTop, css.paddingBottom, css.borderTopWidth, css.borderBottomWidth)
        : 0,
      left: inset(css.left),
      top: inset(css.top),
      right: inset(css.right),
      bottom: inset(css.bottom),
    };
  }

  /**
   * Lets the person type into the text of element `id`, in place, as
   * plain text. Enter or leaving it calls `done` with the text, and
   * Escape with `null`. Either way the element's content is drawn from
   * the document again, so what the browser did while typing never
   * lingers. Returns whether it started: only an element in a shadow-root
   * artboard that holds nothing but text can be typed into, and not one
   * inside an instance, which its component draws.
   */
  editText(id: string, done: (text: string | null) => void): boolean {
    const el = this.elements.get(id);
    const board = this.replica.artboardOf(id);
    if (!(el instanceof HTMLElement) || !board || this.frames.get(board.id)?.iframe) return false;
    if (id.includes("/") || this.replica.get(id)?.instanceOf !== undefined) return false;
    if (![...el.childNodes].every((child) => child instanceof Text)) return false;
    const before = el.textContent ?? "";
    const stop = new AbortController();
    const finish = (keep: boolean) => {
      stop.abort();
      const text = el.textContent ?? "";
      el.removeAttribute("contenteditable");
      this.editing = null;
      this.finishText = null;
      // Typing changed the DOM behind the renderer's back; draw it from the document.
      const children = this.replica.children(id);
      for (const child of children) this.elements.delete(child.id);
      el.replaceChildren(...children.map((child) => this.build(child, null, false)));
      done(keep && text !== before ? text : null);
    };
    el.contentEditable = "plaintext-only";
    this.editing = el;
    this.finishText = () => finish(true);
    const { signal } = stop;
    el.addEventListener(
      "keydown",
      (e) => {
        // The canvas's shortcuts would take letters typed here.
        e.stopPropagation();
        if (e.key === "Escape") finish(false);
        else if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          finish(true);
        }
      },
      { signal },
    );
    el.addEventListener("blur", () => finish(true), { signal });
    el.focus();
    const selection = window.getSelection();
    selection?.selectAllChildren(el);
    return true;
  }

  /** Keeps what was typed into the text being edited, and stops editing it. */
  finishTextEdit() {
    this.finishText?.();
  }

  /** Whether `target` is the element being typed into. */
  isEditing(target: EventTarget | null): boolean {
    return this.editing !== null && target === this.editing;
  }

  /** The artboard whose name label `target` is, if it's one. People drag artboards by it. */
  labelOf(target: EventTarget | null): string | null {
    if (!(target instanceof Element)) return null;
    for (const [id, frame] of this.frames) if (frame.label.contains(target)) return id;
    return null;
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
  private touchedBoards(applied: Exclude<Applied, { op: "tokens" | "page" }>): Set<string> {
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

  private patch(applied: Exclude<Applied, { op: "tokens" | "page" }>) {
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
      clearTimers(frame);
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
        tokenStyle: null,
        iframe,
        awaitingSize: size.width === null || size.height === null,
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
    // In a layer, so the artboard's styles can set what `HOST_CSS` resets,
    // like the font on `:root`.
    const base = document.createElement("style");
    base.textContent = `@layer ${BASE_LAYER} { ${HOST_CSS} ${designModel().baseCss} }`;
    const tokenStyle = document.createElement("style");
    tokenStyle.textContent = this.replica.tokenStyle(node.id, true);
    const commentStyle = document.createElement("style");
    shadow.append(base, tokenStyle, commentStyle);
    content.append(host);
    return {
      root,
      label,
      badge,
      content,
      shadow,
      commentStyle,
      tokenStyle,
      iframe: null,
      rects: new Map(),
      pendingRects: new Set(),
    };
  }

  /** Gives artboard `id` its tokens as they are now, in its mode. */
  private restyleTokens(id: string, frame: Frame) {
    if (frame.tokenStyle) frame.tokenStyle.textContent = this.replica.tokenStyle(id, true);
    else this.scheduleReload(id, frame);
  }

  private scheduleReload(id: string, frame: Frame) {
    clearTimeout(frame.reload);
    delete frame.reload;
    // A hidden artboard loads its latest version when it's shown again.
    if (this.culler.isCulled(id)) {
      frame.stale = true;
      return;
    }
    frame.reload = setTimeout(() => {
      delete frame.reload;
      if (this.frames.get(id) === frame && frame.iframe && !this.culler.isCulled(id)) {
        frame.iframe.srcdoc = artboardDocument(this.replica, id);
        forgetLayout(frame);
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
      // A new document reports zero both ways before its content lays out.
      // Keep the size it has, or a tiny box could get it culled, and a culled
      // iframe is unloaded before it can report its real size.
      if (num("width") === 0 && num("height") === 0) return;
      const fit = (n: number) => `${Math.min(MAX_SIDE, Math.max(1, n))}px`;
      const [width, height] = [fit(num("width")), fit(num("height"))];
      const changed = iframe.style.width !== width || iframe.style.height !== height;
      frame.awaitingSize = false;
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

function clearTimers(frame: Frame) {
  clearTimeout(frame.reload);
  clearTimeout(frame.unload);
}

/** A new or unloaded document: earlier answers about its layout no longer hold. */
function forgetLayout(frame: Frame) {
  delete frame.hit;
  delete frame.asked;
  frame.rects.clear();
  frame.pendingRects.clear();
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
  host: {
    display: "block",
  },
  iframe: {
    display: "block",
    borderWidth: 0,
    colorScheme: "normal",
  },
});
