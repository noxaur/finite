import * as stylex from "@stylexjs/stylex";
import { iconMarkup } from "@/components/Icons";
import { colors } from "@/styles/tokens.stylex";
import { Culler, pageBox } from "./culling";
import { artboardDocument, artboardLinkTarget, BASE_LAYER, pixelSize } from "./html";
import { type Outset, strokeOutset } from "./outset";
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

/** What the pointer does on the canvas: select and edit, use pages, or place comments. */
export type Tool = "pointer" | "interact" | "comment";

/** A key pressed inside a sandboxed artboard that the canvas acts on. */
export interface FrameKey {
  readonly key: string;
  readonly phase: "down" | "up";
  readonly meta: boolean;
  readonly repeat: boolean;
}

/** A change to the design's page storage: keys to set (`null` removes one), or clear it all. */
export interface StorageChange {
  readonly set?: ReadonlyArray<readonly [string, string | null]>;
  readonly clear?: boolean;
}

/** Where pages' `localStorage` lives: one map per design, shared by its artboards. */
export interface PageStorage {
  read(): Record<string, string>;
  /** Applies a change. Returns false if it doesn't fit. */
  write(change: StorageChange): boolean;
}

/** How many pages people used with the Interact tool keep running while out of view. */
const KEEP_USED = 4;
/** How long "Updated by …" stays on a label. */
const UPDATED_MS = 1800;

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
  /** The artboard's name, in `label`. */
  readonly name: HTMLElement;
  /** Opens the artboard in preview mode, shown in `label` while the artboard is focused. */
  readonly play: HTMLButtonElement;
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
  /** Shows the hosts the page reached, in `label`. */
  readonly network: HTMLElement;
  /** Holds off reloads, in `label`, for pages people use. */
  readonly pin: HTMLButtonElement;
  /** "Updated by …", in `label`. */
  readonly note: HTMLElement;
  /** Identifies the iframe's current document, so only its bootstrap gets the port. */
  nonce: string;
  /** The private channel to the iframe's bootstrap, once it said hello. */
  port: MessagePort | null;
  /** Load events for the current document. A second one means the page navigated away. */
  loads: number;
  /** Hosts the page reached, as its bootstrap saw them. */
  readonly hosts: Set<string>;
  /** Reloads wait while this is set. */
  held: boolean;
  /** A change arrived while held: what to do on release. */
  pending?: "reload" | "remount";
  noteTimer?: ReturnType<typeof setTimeout>;
  /** When the page last navigated itself away. */
  navigatedAt?: number;
  /**
   * Set while interactive mode shows the artboard through a window this
   * many CSS pixels tall, scrolling inside it, with its size before that.
   */
  clip?: { readonly height: number; readonly full: { width: number; height: number } };
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
  /** How far the node's strokes reach past the box, from a sandboxed artboard. */
  readonly outset?: Outset;
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
  /** Called when the play button next to the focused artboard's name is clicked. */
  readonly onPreview?: (artboardId: string) => void;
  /** Backs pages' `localStorage`. Without it, storage lasts as long as the page. */
  readonly storage?: PageStorage;
  /** A person clicked a link to another artboard (`#finite-artboard=<id>`) in `from`. */
  readonly onGoto?: (from: string, target: string) => void;
  /** A key the canvas acts on was pressed inside a sandboxed artboard. */
  readonly onFrameKey?: (artboardId: string, key: FrameKey) => void;
  /** The middle button was pressed inside a sandboxed artboard. */
  readonly onFramePan?: (artboardId: string) => void;
  /** A sandboxed artboard lost focus, so keys held in it were let go. */
  readonly onFrameBlur?: () => void;
  /** A person pressed or typed in an artboard with the Interact tool. */
  readonly onUsed?: (artboardId: string) => void;
  /** An artboard that people use changed, and reloaded or is waiting to (`held`). */
  readonly onUpdated?: (artboardId: string, actor: string | null, held: boolean) => void;
  /** A page reached a new host, or its hosts were forgotten on reload. */
  readonly onNetwork?: (artboardId: string) => void;
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
  private tool: Tool = "pointer";
  /** The artboard shown in interactive mode. */
  private presenting: string | null = null;
  /** While Space is held, presses go to the camera, even over pages. */
  private panning = false;
  /** Pages used with the Interact tool, most recent last. */
  private readonly used = new Map<string, number>();
  /** Who made the change being applied, for "Updated by …". */
  private actor: string | null = null;
  /** The scroll container the running wheel gesture belongs to, in a shadow-root artboard. */
  private wheelOwner: Element | null = null;
  private lastWheel = -Infinity;
  /** The element being typed into (`editText`), and what ends that, keeping the text. */
  private editing: HTMLElement | null = null;
  private finishText: (() => void) | null = null;
  /** The artboard whose label shows the play button. */
  private focused: string | null = null;
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
    // Links and forms never navigate the app. A page people use (the
    // Interact tool, interactive mode) keeps its other clicks, so checkboxes
    // and the like work; otherwise designs are view-only.
    world.addEventListener("click", (e) => this.onClick(e), { capture: true, signal });
    for (const type of ["auxclick", "submit"]) {
      world.addEventListener(type, (e) => e.preventDefault(), { capture: true, signal });
    }
    if (options.live) window.addEventListener("message", (e) => this.onHello(e), { signal });
  }

  dispose() {
    this.abort.abort();
    this.culler.dispose();
    this.resizes?.disconnect();
    for (const frame of this.frames.values()) closeFrame(frame);
  }

  /** Rebuilds everything from the replica. */
  reset() {
    // Interactive mode's window and Hold belong to the artboard, not to the
    // frames being replaced.
    const kept = new Map<string, { clip: number | null; held: boolean }>();
    for (const [id, frame] of this.frames) {
      kept.set(id, { clip: frame.clip?.height ?? null, held: frame.held });
      closeFrame(frame);
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
    for (const [id, { clip, held }] of kept) {
      if (clip !== null) this.setWindow(id, clip);
      if (held) this.hold(id, true);
    }
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
      this.scheduleUnload(id, frame);
    } else if (frame.stale && !frame.held) {
      frame.stale = false;
      this.load(id, frame);
    }
  }

  /**
   * Unloads a hidden iframe once it has stayed hidden for a while: a hidden
   * iframe isn't rendered, and panning back to it shouldn't start its
   * scripts over. A page people used keeps running until newer ones push it
   * out, which schedules this again.
   */
  private scheduleUnload(id: string, frame: Frame) {
    clearTimeout(frame.unload);
    frame.unload = setTimeout(() => {
      if (this.frames.get(id) !== frame || !this.culler.isCulled(id) || this.keeps(id)) return;
      this.load(id, frame, false);
      frame.stale = true;
    }, UNLOAD_DELAY_MS);
  }

  /** Whether a hidden page keeps running: it's in interactive mode, or among the latest used. */
  private keeps(id: string): boolean {
    if (id === this.presenting) return true;
    const recent = [...this.used.keys()].slice(-KEEP_USED);
    return recent.includes(id);
  }

  /**
   * Loads the artboard's latest document into its iframe (`fresh` false:
   * an empty one, to stop its scripts). Every document gets a new nonce, so
   * only its own bootstrap gets the port.
   */
  private load(id: string, frame: Frame, fresh = true) {
    const iframe = frame.iframe;
    if (!iframe) return;
    frame.port?.close();
    frame.port = null;
    frame.loads = 0;
    frame.nonce = newNonce();
    if (frame.hosts.size > 0) {
      frame.hosts.clear();
      this.showNetwork(id, frame);
    }
    iframe.srcdoc = fresh
      ? artboardDocument(this.replica, id, {
          nonce: frame.nonce,
          storage: this.options.storage?.read() ?? {},
        })
      : "";
    forgetLayout(frame);
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
      if ((frame.iframe !== null) !== this.isLive(id)) this.refresh(id, frame, "remount");
      else if (frame.iframe && !layoutOnly) this.refresh(id, frame, "reload");
      else if (!layoutOnly) this.noteUpdate(id, frame, false);
    }
  }

  /** Who makes the changes applied next, until the next call. */
  setActor(actor: string | null) {
    this.actor = actor;
  }

  /**
   * Replaces an artboard's document after a change: reloads its iframe, or
   * builds it again when it gained or lost its scripts. A held page waits,
   * and does the latest of these once it's let go.
   */
  private refresh(id: string, frame: Frame, kind: "reload" | "remount") {
    if (frame.held) {
      frame.pending = kind === "remount" || frame.pending === "remount" ? "remount" : "reload";
      clearTimeout(frame.reload);
      delete frame.reload;
      this.noteUpdate(id, frame, true);
      return;
    }
    this.noteUpdate(id, frame, false);
    const node = this.replica.get(id);
    if (kind === "remount" && node) this.remount(node);
    else this.scheduleReload(id, frame);
  }

  /** Shows "Updated by …" on a page people use, and tells the canvas. */
  private noteUpdate(id: string, frame: Frame, held: boolean) {
    if (id !== this.presenting && !this.used.has(id)) return;
    const actor = this.actor;
    frame.note.textContent = actor ? `Updated by ${actor}` : "Updated";
    frame.note.hidden = false;
    clearTimeout(frame.noteTimer);
    frame.noteTimer = setTimeout(() => {
      // A held page keeps saying it's out of date.
      if (!frame.held || !frame.pending) frame.note.hidden = true;
    }, UPDATED_MS);
    this.options.onUpdated?.(id, actor, held);
  }

  /**
   * Holds off reloads for artboard `id`, so changes don't reset what a
   * person is doing in it. Letting go loads the latest version once.
   */
  hold(id: string, held: boolean) {
    const frame = this.frames.get(id);
    if (!frame || frame.held === held) return;
    frame.held = held;
    frame.pin.ariaPressed = String(held);
    if (held) {
      // A reload already on its way waits too.
      if (frame.reload !== undefined) {
        clearTimeout(frame.reload);
        delete frame.reload;
        frame.pending ??= "reload";
      }
      return;
    }
    const pending = frame.pending;
    delete frame.pending;
    frame.note.hidden = true;
    const node = this.replica.get(id);
    if (pending === "remount" && node) this.remount(node);
    else if (pending && this.culler.isCulled(id)) frame.stale = true;
    else if ((pending || frame.stale) && !this.culler.isCulled(id)) {
      frame.stale = false;
      this.load(id, frame);
    }
  }

  isHeld(id: string): boolean {
    return this.frames.get(id)?.held ?? false;
  }

  /** Loads artboard `id`'s page again from the start. */
  reload(id: string) {
    const frame = this.frames.get(id);
    if (!frame?.iframe) return;
    clearTimeout(frame.reload);
    delete frame.reload;
    delete frame.pending;
    this.load(id, frame);
  }

  /** The hosts artboard `id`'s page reached, as far as its bootstrap could see. */
  hostsOf(id: string): ReadonlyArray<string> {
    return [...(this.frames.get(id)?.hosts ?? [])];
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
      if (this.culler.isCulled(id) && !frame.held) {
        if (frame.iframe) frame.stale = true;
        continue;
      }
      if ((frame.iframe !== null) !== this.isLive(id)) this.refresh(id, frame, "remount");
      else if (frame.iframe) this.refresh(id, frame, "reload");
    }
  }

  /**
   * Shows artboard `id` through a window `height` CSS pixels tall that
   * scrolls, like a browser window over a long page (`null`: as it is).
   * For interactive mode. The artboard keeps its size on the canvas.
   */
  setWindow(id: string, height: number | null) {
    const frame = this.frames.get(id);
    if (!frame) return;
    if (height === null) {
      const clip = frame.clip;
      if (!clip) return;
      delete frame.clip;
      if (frame.iframe) frame.iframe.style.height = `${clip.full.height}px`;
      else {
        frame.content.style.height = "";
        frame.content.style.overflowY = "";
        frame.content.scrollTop = 0;
      }
      this.culler.touch(id);
      return;
    }
    const full = frame.clip?.full ?? {
      width: frame.root.offsetWidth,
      height: frame.iframe ? frame.iframe.offsetHeight : frame.root.offsetHeight,
    };
    frame.clip = { height, full };
    if (frame.iframe) frame.iframe.style.height = `${height}px`;
    else {
      frame.content.style.height = `${height}px`;
      frame.content.style.overflowY = "auto";
    }
  }

  /** Canvas-space bounds of every artboard, as rendered. */
  artboardBounds(): Map<string, Bounds> {
    const out = new Map<string, Bounds>();
    for (const [id, frame] of this.frames) {
      const node = this.replica.get(id);
      // A hidden artboard has no layout, so it reports the size it had when last shown.
      const size =
        frame.clip?.full ??
        ((this.culler.isCulled(id) && this.culler.size(id)) || {
          width: frame.root.offsetWidth,
          height: frame.root.offsetHeight,
        });
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
      frame.port?.postMessage({ type: "hit", x, y });
    }
    if (frame.hit?.x === x && frame.hit.y === y) return frame.hit.id;
    return exact ? null : (frame.hit?.id ?? null);
  }

  /**
   * Where a node is drawn, in page coordinates. For a node in a sandboxed
   * artboard, this is the artboard until the iframe reports the node's position.
   */
  nodeRect(id: string): DOMRect | null {
    return this.rectOf(id, false);
  }

  /**
   * Like `nodeRect`, grown to take in the node's outline and its stroke-like
   * shadows, so a line drawn around it sits outside everything it paints.
   */
  outerRect(id: string): DOMRect | null {
    return this.rectOf(id, true);
  }

  private rectOf(id: string, outer: boolean): DOMRect | null {
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
      if (el instanceof Element) {
        const rect = el.getBoundingClientRect();
        if (!outer) return rect;
        // The outset is in the element's own pixels; the camera's zoom scales it.
        const own = el instanceof HTMLElement ? el.offsetWidth : 0;
        return grow(rect, strokeOutset(getComputedStyle(el)), own > 0 ? rect.width / own : 1);
      }
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
        frame.port?.postMessage({ type: "rect", id });
      }
      if (known) {
        const { left, top, scale } = iframeBox(frame.iframe);
        const r = known.rect;
        const rect = new DOMRect(
          left + r.x * scale,
          top + r.y * scale,
          r.width * scale,
          r.height * scale,
        );
        return outer && r.outset ? grow(rect, r.outset, scale) : rect;
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
   * The browser's styles for an element drawn in a shadow-root artboard, or
   * an artboard itself, for the inspector to show what classes and
   * `<style>` blocks set. `null` where `measure` is: inside a sandboxed
   * artboard, and on hidden artboards.
   */
  computedStyle(id: string): CSSStyleDeclaration | null {
    const board = this.replica.artboardOf(id);
    const frame = board && this.frames.get(board.id);
    if (!frame || frame.iframe || this.culler.isCulled(board.id)) return null;
    const el = this.elements.get(id);
    return el instanceof Element && el.isConnected ? getComputedStyle(el) : null;
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

  /**
   * Sets what the pointer does. Pages take input only with the Interact
   * tool, or in interactive mode; otherwise presses over sandboxed
   * artboards go to the canvas, to select or comment.
   */
  setTool(tool: Tool) {
    this.tool = tool;
    this.wheelOwner = null;
    this.showInputs();
  }

  /**
   * Shows artboard `id` in interactive mode (`null`: back to the canvas).
   * Only that page takes input, it owns the wheel, and its audio plays.
   */
  setPresenting(id: string | null) {
    this.presenting = id;
    this.wheelOwner = null;
    if (id) this.use(id);
    this.showInputs();
  }

  /** While Space is held, presses over pages go to the camera, to pan. */
  setPanning(panning: boolean) {
    if (this.panning === panning) return;
    this.panning = panning;
    this.showInputs();
  }

  private showInputs() {
    for (const [id, frame] of this.frames) this.showInput(id, frame);
    // A page that stops taking input gives the keyboard back, or its frame
    // would keep the keys the canvas needs, like Escape.
    const active = document.activeElement;
    if (active instanceof HTMLIFrameElement) {
      for (const [id, frame] of this.frames) {
        if (frame.iframe !== active || this.takesInput(id)) continue;
        // blur() alone doesn't take the focus out of a cross-origin frame;
        // focusing something in this document does.
        active.blur();
        this.world.tabIndex = -1;
        this.world.style.outline = "none";
        this.world.focus({ preventScroll: true });
      }
    }
  }

  /** Whether artboard `id` takes clicks, typing and the wheel right now. */
  takesInput(id: string): boolean {
    if (this.tool === "comment" || this.panning) return false;
    return this.presenting === null ? this.tool === "interact" : id === this.presenting;
  }

  private showInput(id: string, frame: Frame) {
    if (frame.iframe) frame.iframe.style.pointerEvents = this.takesInput(id) ? "" : "none";
    if (frame.commentStyle) {
      frame.commentStyle.textContent = this.tool === "comment" ? COMMENTING_CSS : "";
    }
    frame.pin.hidden = !this.used.has(id) && id !== this.presenting;
    // In interactive mode Tab walks the shown page and the pill, nothing else
    // on the canvas. The label buttons stay clickable, only out of the Tab
    // order. Other pages go inert, which also drops them from hit testing, so
    // comment mode (hold C) keeps them live to pin elements in them.
    const presenting = this.presenting !== null;
    frame.play.tabIndex = frame.pin.tabIndex = presenting ? -1 : 0;
    frame.content.inert = presenting && id !== this.presenting && this.tool !== "comment";
    this.sendState(id, frame);
  }

  private sendState(id: string, frame: Frame) {
    frame.port?.postMessage({
      type: "state",
      interact: this.tool === "interact" && this.presenting === null,
      presenting: id === this.presenting,
      audio: id === this.presenting,
    });
  }

  /** Marks artboard `id` as just used, so it keeps running while out of view. */
  private use(id: string) {
    const latest = new Set([...this.used.keys()].slice(-KEEP_USED));
    const first = !this.used.has(id);
    this.used.delete(id);
    this.used.set(id, Date.now());
    // The pin stays on labels of pages used a while ago, so keep a few more.
    for (const old of [...this.used.keys()].slice(0, -KEEP_USED * 8)) this.used.delete(old);
    // A page this pushed out of the latest stops once it's been hidden a while.
    const now = new Set([...this.used.keys()].slice(-KEEP_USED));
    for (const dropped of latest) {
      const out = now.has(dropped) ? undefined : this.frames.get(dropped);
      if (out?.iframe && this.culler.isCulled(dropped) && out.iframe.srcdoc !== "") {
        this.scheduleUnload(dropped, out);
      }
    }
    const frame = this.frames.get(id);
    if (first && frame) frame.pin.hidden = false;
    this.options.onUsed?.(id);
  }

  /**
   * Whether a wheel event should scroll the page under it instead of
   * moving the camera. A gesture belongs to the scroll container it starts
   * over, in a page that takes input, whether or not that container can
   * move that way yet, through its momentum and its own edges.
   */
  scrollsPage(e: WheelEvent): boolean {
    if (e.ctrlKey || e.metaKey) return false;
    if (e.timeStamp - this.lastWheel > GESTURE_GAP_MS) this.wheelOwner = this.scrollOwner(e);
    this.lastWheel = e.timeStamp;
    return this.wheelOwner !== null;
  }

  private scrollOwner(e: WheelEvent): Element | null {
    const id = this.boardOf(e);
    const frame = id && this.frames.get(id);
    if (!id || !frame || frame.iframe || !this.takesInput(id)) return null;
    for (const target of e.composedPath()) {
      if (target === frame.root) break;
      // The path passes through the shadow root, which isn't an element.
      if (target instanceof Element && scrolls(target, e.deltaX, e.deltaY)) return target;
    }
    return null;
  }

  /** The artboard an event happened in, by its path. */
  boardOf(e: Event): string | null {
    for (const target of e.composedPath()) {
      if (target instanceof HTMLElement && target.dataset.artboard) return target.dataset.artboard;
    }
    return null;
  }

  /**
   * Clicks in shadow-root artboards. Only a page that takes input keeps its
   * clicks. Links never navigate the app: one to another artboard asks the
   * canvas to go there, an external one opens a new tab, and one to a part
   * of the page scrolls to it.
   */
  private onClick(e: MouseEvent) {
    const id = this.boardOf(e);
    if (!id || this.frames.get(id)?.label.contains(e.target as globalThis.Node)) {
      e.preventDefault();
      return;
    }
    if (!this.takesInput(id)) {
      e.preventDefault();
      return;
    }
    this.use(id);
    const link = e
      .composedPath()
      .find((t): t is HTMLAnchorElement | HTMLAreaElement =>
        t instanceof Element ? t.matches("a[href], area[href]") : false,
      );
    if (!link) return;
    e.preventDefault();
    const href = link.getAttribute("href") ?? "";
    const to = artboardLinkTarget(href);
    if (to !== null) {
      this.options.onGoto?.(id, to);
    } else if (href.startsWith("#")) {
      const root = link.getRootNode();
      const target =
        root instanceof ShadowRoot ? root.getElementById(decodeURIComponent(href.slice(1))) : null;
      target?.scrollIntoView({ block: "start" });
    } else openExternal(link.href);
  }

  /** Marks artboards that agents are working on, keyed by artboard id. */
  setWorking(working: ReadonlyMap<string, string>) {
    this.working = working;
    for (const [id, frame] of this.frames) this.showWorking(frame, working.get(id));
  }

  /** Shows the play button next to `id`'s name, and hides the rest. */
  setFocused(id: string | null) {
    this.focused = id;
    for (const [boardId, frame] of this.frames) frame.play.hidden = boardId !== id;
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
    // Interactive mode's window belongs to the artboard, not to the frame
    // being replaced.
    const clipped = this.frames.get(board.id)?.clip?.height ?? null;
    for (const id of this.replica.subtree(board.id)) this.unmount(id);
    this.mount(board);
    if (clipped !== null) this.setWindow(board.id, clipped);
  }

  /** Builds `node` and its subtree, and inserts it in sibling order. */
  private mount(node: Node) {
    if (node.parent === null) {
      if (node.type !== "element" || this.replica.pageOf(node) !== this.shownPage()) return;
      const frame = this.createFrame(node, this.isLive(node.id));
      this.frames.set(node.id, frame);
      this.world.append(frame.root);
      this.showWorking(frame, this.working.get(node.id));
      this.showInput(node.id, frame);
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
      closeFrame(frame);
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
      if (frame) frame.name.textContent = labelOf(node);
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
    const name = document.createElement("span");
    name.textContent = labelOf(node);
    const play = document.createElement("button");
    play.type = "button";
    play.title = "Preview";
    play.ariaLabel = `Preview ${labelOf(node)}`;
    play.className = stylex.props(styles.play).className ?? "";
    // Its own filter id, since the unfocused artboards' buttons are hidden.
    play.innerHTML = iconMarkup("play", 10, node.id);
    play.hidden = node.id !== this.focused || !this.options.onPreview;
    // So pressing it neither pans the canvas nor places a comment.
    play.dataset.cameraIgnore = "";
    play.addEventListener("click", () => this.options.onPreview?.(node.id), {
      signal: this.abort.signal,
    });
    const network = document.createElement("span");
    network.className = stylex.props(styles.network).className ?? "";
    network.innerHTML = iconMarkup("wifi", 10, `net-${node.id}`);
    network.hidden = true;
    const pin = document.createElement("button");
    pin.type = "button";
    pin.className = stylex.props(styles.pin).className ?? "";
    pin.textContent = "Hold";
    pin.title = "Hold off reloads, so changes don't reset this page";
    pin.ariaPressed = "false";
    pin.hidden = true;
    pin.dataset.cameraIgnore = "";
    pin.addEventListener("click", () => this.hold(node.id, !this.isHeld(node.id)), {
      signal: this.abort.signal,
    });
    const note = document.createElement("span");
    note.className = stylex.props(styles.note).className ?? "";
    note.hidden = true;
    label.append(name, play, network, note, pin);

    const badge = document.createElement("div");
    badge.className = stylex.props(styles.badge).className ?? "";

    // Paint containment keeps content (even `position: fixed`) inside the frame.
    const content = document.createElement("div");
    content.className = stylex.props(styles.content).className ?? "";
    root.append(label, badge, content);

    const parts = {
      root,
      label,
      name,
      play,
      badge,
      content,
      network,
      pin,
      note,
      nonce: "",
      port: null,
      loads: 0,
      hosts: new Set<string>(),
      held: false,
      rects: new Map(),
      pendingRects: new Set<string>(),
    };

    if (live) {
      const iframe = document.createElement("iframe");
      // No allow-same-origin, allow-modals, allow-popups, allow-top-navigation
      // or allow-pointer-lock: an opaque origin that can't take over the app.
      // Forms run their submit handlers; the content policy's form-action
      // keeps them from sending anything.
      iframe.sandbox.add("allow-scripts", "allow-forms");
      iframe.allow =
        "autoplay 'none'; fullscreen 'none'; camera 'none'; microphone 'none'; geolocation 'none'; display-capture 'none'";
      iframe.title = labelOf(node);
      iframe.className = stylex.props(styles.iframe).className ?? "";
      const size = pixelSize(node);
      iframe.style.width = `${size.width ?? 1440}px`;
      iframe.style.height = `${size.height ?? 900}px`;
      iframe.addEventListener("load", () => this.onLoad(node.id), { signal: this.abort.signal });
      content.append(iframe);
      const frame: Frame = {
        ...parts,
        shadow: null,
        commentStyle: null,
        tokenStyle: null,
        iframe,
        awaitingSize: size.width === null || size.height === null,
      };
      this.load(node.id, frame);
      return frame;
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
    return { ...parts, shadow, commentStyle, tokenStyle, iframe: null };
  }

  /** Gives artboard `id` its tokens as they are now, in its mode. */
  private restyleTokens(id: string, frame: Frame) {
    if (frame.tokenStyle) frame.tokenStyle.textContent = this.replica.tokenStyle(id, true);
    else this.refresh(id, frame, "reload");
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
      if (this.frames.get(id) !== frame || !frame.iframe) return;
      if (frame.held) frame.pending ??= "reload";
      else if (!this.culler.isCulled(id)) this.load(id, frame);
    }, RELOAD_DELAY_MS);
  }

  /** A page changed its storage: keep it, and tell the design's other pages. */
  private onStorage(boardId: string, m: Record<string, unknown>) {
    const set: Array<readonly [string, string | null]> = [];
    if (Array.isArray(m.set)) {
      for (const entry of m.set as unknown[]) {
        if (!Array.isArray(entry) || typeof entry[0] !== "string") return;
        const value: unknown = entry[1];
        if (value !== null && typeof value !== "string") return;
        set.push([entry[0], value]);
      }
    }
    const change: StorageChange = { set, clear: m.clear === true };
    if (this.options.storage && !this.options.storage.write(change)) return;
    for (const [id, frame] of this.frames) {
      if (id !== boardId) frame.port?.postMessage({ type: "storage", ...change });
    }
  }

  private showNetwork(id: string, frame: Frame) {
    const hosts = [...frame.hosts];
    frame.network.hidden = hosts.length === 0;
    frame.network.title = hosts.length > 0 ? `Uses the network: ${hosts.join(", ")}` : "";
    this.options.onNetwork?.(id);
  }

  /**
   * A sandboxed artboard's bootstrap said hello: hand it the private port.
   * The page's own scripts can post here too, so only the first hello with
   * the current document's nonce gets one, and the bootstrap's comes first.
   */
  private onHello(event: MessageEvent) {
    const m = (event.data as { finite?: { type?: unknown; nonce?: unknown } } | null)?.finite;
    if (m?.type !== "hello") return;
    for (const [id, frame] of this.frames) {
      const iframe = frame.iframe;
      if (!iframe || iframe.contentWindow !== event.source) continue;
      if (frame.port || m.nonce !== frame.nonce) return;
      const channel = new MessageChannel();
      frame.port = channel.port1;
      channel.port1.onmessage = (e) => {
        if (this.frames.get(id) === frame && frame.port === channel.port1)
          this.onMessage(id, frame, e.data);
      };
      iframe.contentWindow?.postMessage({ finite: { type: "init", nonce: frame.nonce } }, "*", [
        channel.port2,
      ]);
      this.sendState(id, frame);
      return;
    }
  }

  /**
   * The iframe finished loading a document. A second load for the same
   * document means the page navigated itself somewhere else: load it again.
   */
  private onLoad(id: string) {
    const frame = this.frames.get(id);
    if (!frame?.iframe) return;
    frame.loads += 1;
    if (frame.loads < 2 || frame.iframe.srcdoc === "") return;
    // A page that keeps navigating away stays empty until it changes.
    const again = frame.navigatedAt !== undefined && performance.now() - frame.navigatedAt < 2000;
    frame.navigatedAt = performance.now();
    this.load(id, frame, !again);
    if (again) frame.stale = true;
  }

  /** Handles messages from the bootstrap in sandboxed artboards, over the private port. */
  private onMessage(boardId: string, frame: Frame, message: unknown) {
    if (typeof message !== "object" || message === null) return;
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
      const o = r?.outset as Record<string, unknown> | undefined;
      const side = (k: string) =>
        typeof o?.[k] === "number" && Number.isFinite(o[k]) ? Math.max(0, o[k] as number) : 0;
      return r && ok("x") && ok("y") && ok("width") && ok("height")
        ? {
            x: r.x as number,
            y: r.y as number,
            width: r.width as number,
            height: r.height as number,
            outset: {
              top: side("top"),
              right: side("right"),
              bottom: side("bottom"),
              left: side("left"),
            },
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
      frame.awaitingSize = false;
      // In interactive mode's window, the page's size changes what's behind it.
      if (frame.clip) {
        frame.clip = { ...frame.clip, full: { width: num("width"), height: num("height") } };
        iframe.style.width = width;
        return;
      }
      const changed = iframe.style.width !== width || iframe.style.height !== height;
      this.culler.touch(boardId);
      iframe.style.width = width;
      iframe.style.height = height;
      if (changed) this.options.onResize?.();
    } else if (m.type === "storage") {
      this.onStorage(boardId, m);
    } else if (m.type === "network" && typeof m.host === "string" && m.host.length <= 253) {
      if (frame.hosts.size >= 50 || frame.hosts.has(m.host)) return;
      frame.hosts.add(m.host);
      this.showNetwork(boardId, frame);
    } else if (m.type === "goto" && typeof m.target === "string") {
      if (this.takesInput(boardId)) this.options.onGoto?.(boardId, m.target);
    } else if (m.type === "open" && typeof m.url === "string") {
      // The bootstrap sends this only for a person's click on a link.
      if (this.takesInput(boardId)) openExternal(m.url);
    } else if (m.type === "key" && typeof m.key === "string") {
      this.options.onFrameKey?.(boardId, {
        key: m.key,
        phase: m.phase === "up" ? "up" : "down",
        meta: m.meta === true,
        repeat: m.repeat === true,
      });
    } else if (m.type === "pan") {
      this.options.onFramePan?.(boardId);
    } else if (m.type === "blur") {
      this.options.onFrameBlur?.();
    } else if (m.type === "used") {
      // Sent on every press and key, so skip it while it's already the latest.
      if (this.takesInput(boardId) && [...this.used.keys()].at(-1) !== boardId) this.use(boardId);
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

/** Stops a frame's timers and closes its port. */
function closeFrame(frame: Frame) {
  clearTimeout(frame.reload);
  clearTimeout(frame.unload);
  clearTimeout(frame.noteTimer);
  frame.port?.close();
  frame.port = null;
}

/** A gesture's wheel events come closer together than this; a longer gap starts a new one. */
const GESTURE_GAP_MS = 120;

/** Whether `el` is a scroll container with room to scroll along the wheel's axis. */
function scrolls(el: Element, dx: number, dy: number): boolean {
  const style = getComputedStyle(el);
  const y = /(auto|scroll)/.test(style.overflowY) && el.scrollHeight > el.clientHeight;
  const x = /(auto|scroll)/.test(style.overflowX) && el.scrollWidth > el.clientWidth;
  return (dy !== 0 && y) || (dx !== 0 && x);
}

function newNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Opens an http(s) link from a page in a new tab, with no way back to the app. */
function openExternal(url: string) {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return;
  window.open(parsed.href, "_blank", "noopener,noreferrer");
}

/** A new or unloaded document: earlier answers about its layout no longer hold. */
function forgetLayout(frame: Frame) {
  delete frame.hit;
  delete frame.asked;
  frame.rects.clear();
  frame.pendingRects.clear();
}

/** Where an iframe's content sits on the page, and how much the canvas zoom scales it. */
/** `rect` grown by `outset`, which is in pixels `scale` times smaller than the page's. */
function grow(rect: DOMRect, outset: Outset, scale: number) {
  return new DOMRect(
    rect.x - outset.left * scale,
    rect.y - outset.top * scale,
    rect.width + (outset.left + outset.right) * scale,
    rect.height + (outset.top + outset.bottom) * scale,
  );
}

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
    boxShadow: `0 1px 3px color-mix(in srgb, ${colors.ink} 12%, transparent), 0 0 0 1px color-mix(in srgb, ${colors.ink} 8%, transparent)`,
  },
  working: {
    outline: `calc(2px * var(--inv-zoom, 1)) solid ${colors.accent}`,
  },
  label: {
    position: "absolute",
    left: 0,
    bottom: "100%",
    display: "flex",
    alignItems: "center",
    gap: 4,
    paddingBottom: 4,
    fontSize: 12,
    lineHeight: 1.3,
    color: colors.muted,
    whiteSpace: "nowrap",
    transform: "scale(var(--inv-zoom, 1))",
    transformOrigin: "bottom left",
    fontFamily: "ui-sans-serif, system-ui, sans-serif",
  },
  play: {
    display: { default: "grid", ":is([hidden])": "none" },
    placeItems: "center",
    width: 16,
    height: 16,
    padding: 0,
    borderWidth: 0,
    borderRadius: 4,
    backgroundColor: { default: "transparent", ":hover": colors.surface },
    color: { default: colors.muted, ":hover": colors.text },
    cursor: "var(--cursor-pointer, pointer)",
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
  network: {
    display: { default: "grid", ":is([hidden])": "none" },
    placeItems: "center",
    width: 16,
    height: 16,
    color: colors.muted,
  },
  note: {
    display: { default: "inline", ":is([hidden])": "none" },
    color: colors.text,
  },
  pin: {
    display: { default: "inline-block", ":is([hidden])": "none" },
    height: 16,
    paddingInline: 5,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    borderRadius: 4,
    fontSize: 11,
    lineHeight: 1,
    backgroundColor: { default: "transparent", ":is([aria-pressed=true])": colors.activeFill },
    color: { default: colors.muted, ":is([aria-pressed=true])": colors.text },
    cursor: "var(--cursor-pointer, pointer)",
  },
});
