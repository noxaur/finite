import * as stylex from "@stylexjs/stylex";
import { colors } from "@/styles/tokens.stylex";
import { artboardDocument, BASE_CSS, pixelSize } from "./html";
import type { Applied, Replica } from "./replica";
import type { Node } from "./schema";

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

const isSafeAttr = (name: string, value: string) => {
  const lower = name.toLowerCase();
  const url = value.replace(/\s/g, "").toLowerCase();
  return (
    !lower.startsWith("on") &&
    lower !== "srcdoc" &&
    !url.startsWith("javascript:") &&
    !url.startsWith("vbscript:")
  );
};

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
  /** Set for artboards with scripts, rendered in a sandboxed iframe. */
  readonly iframe: HTMLIFrameElement | null;
  reload?: ReturnType<typeof setTimeout>;
}

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
  /** The artboard itself for sandboxed artboards, whose content can't be inspected. */
  readonly nodeId: string;
}

export interface RendererOptions {
  /** Run artboards that contain scripts. Off for thumbnails, which stay static. */
  readonly live?: boolean;
  /** Receives wheel events from sandboxed artboards, so the canvas can pan over them. */
  readonly onWheel?: (event: ForwardedWheel) => void;
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
      let el = frame.shadow?.elementFromPoint(clientX, clientY) ?? null;
      while (el && !this.ids.has(el)) el = el.parentElement;
      return { artboardId, nodeId: (el && this.ids.get(el)) ?? artboardId };
    }
    return null;
  }

  /** Where a node is drawn, in page coordinates. Nodes in sandboxed artboards report the artboard. */
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
    return frame ? frame.content.getBoundingClientRect() : null;
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
  private touchedBoards(applied: Applied): Set<string> {
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

  private patch(applied: Applied) {
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
    const siblings = this.replica.children(node.parent);
    for (let i = siblings.findIndex((s) => s.id === node.id) + 1; i < siblings.length; i++) {
      const el = this.elements.get(siblings[i]!.id);
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
      return { root, label, badge, content, shadow: null, commentStyle: null, iframe };
    }

    const host = document.createElement("div");
    host.className = stylex.props(styles.host).className ?? "";
    const shadow = host.attachShadow({ mode: "open" });
    const base = document.createElement("style");
    base.textContent = `${HOST_CSS} ${BASE_CSS}`;
    const commentStyle = document.createElement("style");
    shadow.append(base, commentStyle);
    content.append(host);
    return { root, label, badge, content, shadow, commentStyle, iframe: null };
  }

  private scheduleReload(id: string, frame: Frame) {
    clearTimeout(frame.reload);
    frame.reload = setTimeout(() => {
      if (this.frames.get(id) === frame && frame.iframe) {
        frame.iframe.srcdoc = artboardDocument(this.replica, id);
      }
    }, RELOAD_DELAY_MS);
  }

  /** Handles messages from the runtime in sandboxed artboards (see `./html`). */
  private onMessage(event: MessageEvent) {
    let iframe: HTMLIFrameElement | null = null;
    for (const frame of this.frames.values()) {
      if (frame.iframe && frame.iframe.contentWindow === event.source) iframe = frame.iframe;
    }
    const message: unknown = (event.data as { finite?: unknown } | null)?.finite;
    if (!iframe || typeof message !== "object" || message === null) return;
    const m = message as Record<string, unknown>;
    const num = (key: string) =>
      typeof m[key] === "number" && Number.isFinite(m[key]) ? (m[key] as number) : 0;
    if (m.type === "size") {
      const fit = (n: number) => `${Math.min(MAX_SIDE, Math.max(1, n))}px`;
      iframe.style.width = fit(num("width"));
      iframe.style.height = fit(num("height"));
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

function setAttr(el: Element, name: string, value: string) {
  if (!isSafeAttr(name, value)) return;
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
    color: "white",
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
