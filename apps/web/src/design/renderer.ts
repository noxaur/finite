import * as stylex from "@stylexjs/stylex";
import { colors } from "@/styles/tokens.stylex";
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
  private working: ReadonlyMap<string, string> = new Map();
  private commenting = false;
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
    for (const frame of this.frames.values()) clearTimeout(frame.reload);
  }

  /** Rebuilds everything from the replica. */
  reset() {
    for (const frame of this.frames.values()) {
      clearTimeout(frame.reload);
      frame.root.remove();
    }
    this.frames.clear();
    this.elements.clear();
    this.scripts.clear();
    for (const node of this.replica.nodes.values()) if (isScript(node)) this.scripts.add(node.id);
    for (const board of this.replica.artboards()) this.mount(board);
  }

  apply(applied: Applied) {
    if (applied.op === "css") {
      // Every artboard uses it: restyle shadow roots, reload sandboxed ones.
      const css = this.sharedCss();
      for (const [id, frame] of this.frames) {
        if (frame.sharedStyle) frame.sharedStyle.textContent = css;
        else this.scheduleReload(id, frame);
      }
      return;
    }
    const boards = this.touchedBoards(applied);
    if (applied.op === "create" && isScript(applied.node)) this.scripts.add(applied.node.id);
    if (applied.op === "delete") for (const id of applied.removed) this.scripts.delete(id);

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
      if ((frame.iframe !== null) !== this.isLive(id)) this.remount(node);
      else if (frame.iframe && !layoutOnly) this.scheduleReload(id, frame);
    }
  }

  /** Canvas-space bounds of every artboard, as rendered. */
  artboardBounds(): Map<string, Bounds> {
    const out = new Map<string, Bounds>();
    for (const [id, frame] of this.frames) {
      const node = this.replica.get(id);
      out.set(id, {
        x: node?.x ?? 0,
        y: node?.y ?? 0,
        width: frame.root.offsetWidth,
        height: frame.root.offsetHeight,
      });
    }
    return out;
  }

  /** The topmost artboard under a page point, and the element in it. */
  hitTest(clientX: number, clientY: number): Hit | null {
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
      if (frame.iframe)
        return { artboardId, nodeId: this.askHit(frame, clientX, clientY) ?? artboardId };
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
  private askHit(frame: Frame, clientX: number, clientY: number): string | null {
    const iframe = frame.iframe!;
    const { left, top, scale } = iframeBox(iframe);
    const x = Math.round((clientX - left) / scale);
    const y = Math.round((clientY - top) / scale);
    if (frame.asked?.x !== x || frame.asked?.y !== y) {
      frame.asked = { x, y };
      iframe.contentWindow?.postMessage({ finite: { type: "hit", x, y } }, "*");
    }
    return frame.hit?.x === x && frame.hit.y === y ? frame.hit.id : (frame.hit?.id ?? null);
  }

  /**
   * Where a node is drawn, in page coordinates. For a node in a sandboxed
   * artboard, this is the artboard until the iframe reports the node's position.
   */
  nodeRect(id: string): DOMRect | null {
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
    return false;
  }

  /** Artboards an op changed: where its node is now, and where it was before. */
  private touchedBoards(applied: Exclude<Applied, { op: "css" }>): Set<string> {
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

  private patch(applied: Exclude<Applied, { op: "css" }>) {
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
      if (node.type !== "element") return;
      const frame = this.createFrame(node, this.isLive(node.id));
      this.frames.set(node.id, frame);
      this.world.append(frame.root);
      this.showWorking(frame, this.working.get(node.id));
      this.showCommenting(frame);
      if (frame.shadow) this.build(node, frame.shadow, false);
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
      const childSvg = svg && tag !== "foreignObject";
      this.elements.set(node.id, el);
      this.ids.set(el, node.id);
      for (const child of this.replica.children(node.id)) {
        el.appendChild(this.build(child, null, childSvg));
      }
    }
    this.elements.set(node.id, el);
    container?.appendChild(el);
    return el;
  }

  private unmount(id: string) {
    const frame = this.frames.get(id);
    if (frame) {
      clearTimeout(frame.reload);
      frame.root.remove();
      this.frames.delete(id);
    }
    this.elements.get(id)?.remove();
    this.elements.delete(id);
  }

  private update(node: Node, key: string) {
    const el = this.elements.get(node.id);
    const frame = this.frames.get(node.id);
    if (key === "text") {
      if (el instanceof Text) el.data = node.text ?? "";
    } else if (key === "name") {
      if (frame) frame.label.textContent = labelOf(node);
    } else if (key === "x" || key === "y") {
      if (frame) positionFrame(frame.root, node);
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
    frame.reload = setTimeout(() => {
      if (this.frames.get(id) === frame && frame.iframe) {
        frame.iframe.srcdoc = artboardDocument(this.replica, id);
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
  host: {
    display: "block",
  },
  iframe: {
    display: "block",
    borderWidth: 0,
    colorScheme: "normal",
  },
});
