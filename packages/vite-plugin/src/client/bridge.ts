/// <reference lib="dom" />
/**
 * The iframe half of the bridge (`@finite/protocol` bridge.ts), loaded into every page the design's
 * dev server renders. The plugin serves it with its types stripped, so it imports nothing: the
 * constants below mirror the protocol and a test keeps them equal.
 */

export const HELLO = "finite:hello";
export const CONNECT = "finite:connect";
const LOC = "data-finite-loc";
const REV = "data-finite-rev";
const MAX_PENDING = 100;
const MAX_MESSAGE = 4_000;
/**
 * How long `updated` waits: React Refresh applies an update a moment after Vite's
 * `vite:afterUpdate`, and under Next the DOM must go quiet.
 */
const SETTLE_MS = 50;
/** The plugin's default for `allowedHosts`, the same loopback names the Finite server allows. */
export const LOOPBACK_HOSTS: readonly string[] = ["localhost", "127.0.0.1", "::1"];
/** The plugin defines this above the bridge it serves: the hosts the Finite shell may be on. */
declare const FINITE_ALLOWED_HOSTS: readonly string[] | undefined;

/**
 * Whether `origin` is one the Finite shell may be served from: its host is a name in `hosts`
 * (any port), or its `host:port` is. The Finite server applies the same rule to requests.
 */
export function allowsOrigin(hosts: readonly string[], origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const name = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const authority = url.host.toLowerCase();
  return hosts.some((h) => {
    const listed = h.toLowerCase();
    return listed === name || listed === authority;
  });
}

/** The computed styles the inspector shows. */
const COMPUTED = [
  "display",
  "position",
  "top",
  "right",
  "bottom",
  "left",
  "zIndex",
  "flexDirection",
  "flexWrap",
  "justifyContent",
  "alignItems",
  "alignSelf",
  "alignContent",
  "flexGrow",
  "flexShrink",
  "flexBasis",
  "gap",
  "rowGap",
  "columnGap",
  "gridTemplateColumns",
  "gridTemplateRows",
  "width",
  "height",
  "minWidth",
  "maxWidth",
  "minHeight",
  "maxHeight",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "marginTop",
  "marginRight",
  "marginBottom",
  "marginLeft",
  "boxSizing",
  "overflow",
  "color",
  "backgroundColor",
  "backgroundImage",
  "opacity",
  "fontFamily",
  "fontSize",
  "fontWeight",
  "fontStyle",
  "lineHeight",
  "letterSpacing",
  "textAlign",
  "textTransform",
  "textDecorationLine",
  "whiteSpace",
  "borderTopWidth",
  "borderRightWidth",
  "borderBottomWidth",
  "borderLeftWidth",
  "borderTopColor",
  "borderStyle",
  "borderTopLeftRadius",
  "borderTopRightRadius",
  "borderBottomRightRadius",
  "borderBottomLeftRadius",
  "boxShadow",
  "objectFit",
  "zoom",
] as const;

type Rect = { x: number; y: number; width: number; height: number };
type HitElement = { loc: string; rev: string; tag: string };
type LayerNode = HitElement & { index: number; name: string; children: LayerNode[] };
type DropChild = HitElement & {
  index: number;
  count: number;
  rect: Rect;
  display: string;
  flexDirection: string;
  position: string;
  borderLeft: number;
  borderTop: number;
  scrollLeft: number;
  scrollTop: number;
};
type DropNode = DropChild & { children: DropChild[] };
type Request = { type: string; id: number } & Record<string, unknown>;

declare global {
  interface ImportMeta {
    /** Vite's HMR API; written out as `import.meta.hot` so Vite sees it. */
    readonly hot?: { on(event: string, fn: () => void): void };
  }
}

let port: MessagePort | null = null;
const pending: unknown[] = [];

function post(message: unknown, buffer = false): void {
  if (port) port.postMessage(message);
  else if (buffer && pending.length < MAX_PENDING) pending.push(message);
}

function stamped(element: Element | null): Element | null {
  return element?.closest(`[${LOC}]`) ?? null;
}

function instances(loc: string): Element[] {
  return Array.from(document.querySelectorAll(`[${LOC}="${CSS.escape(loc)}"]`));
}

function rectOf(element: Element): Rect {
  const { x, y, width, height } = element.getBoundingClientRect();
  return { x, y, width, height };
}

function describe(element: Element): HitElement {
  return {
    loc: element.getAttribute(LOC) ?? "",
    rev: element.getAttribute(REV) ?? "",
    tag: element.tagName.toLowerCase(),
  };
}

/** The element's text when all it holds is text. */
function ownText(element: Element): string | undefined {
  const nodes = Array.from(element.childNodes);
  if (nodes.length === 0 || nodes.some((node) => node.nodeType !== Node.TEXT_NODE))
    return undefined;
  return element.textContent ?? "";
}

function layerName(element: Element): string {
  const named =
    element.getAttribute("data-name") ??
    element.getAttribute("alt") ??
    element.getAttribute("aria-label") ??
    element.getAttribute("title");
  if (named?.trim()) return named.trim();
  const text = ownText(element)?.trim();
  if (text) return text.length > 40 ? `${text.slice(0, 39)}…` : text;
  return element.tagName.toLowerCase();
}

const requests: Record<string, (params: Request) => unknown> = {
  hit({ x, y }) {
    const element = stamped(document.elementFromPoint(x as number, y as number));
    if (!element) return null;
    const hit = describe(element);
    const all = instances(hit.loc);
    const path: HitElement[] = [];
    for (let up = stamped(element.parentElement); up; up = stamped(up.parentElement)) {
      path.push(describe(up));
    }
    return { ...hit, rect: rectOf(element), index: all.indexOf(element), count: all.length, path };
  },

  rects({ locs }) {
    const rects: Record<string, Rect[]> = {};
    for (const loc of locs as string[]) rects[loc] = instances(loc).map(rectOf);
    return rects;
  },

  inspect({ loc, index }) {
    const element = instances(loc as string)[index as number];
    if (!element) return null;
    const style = getComputedStyle(element);
    const computed: Record<string, string> = {};
    for (const key of COMPUTED) computed[key] = style[key];
    const parent = element.parentElement ? getComputedStyle(element.parentElement) : undefined;
    Object.assign(
      computed,
      style.display.includes("flex") || parent?.display.includes("flex") ? sizing(element) : {},
    );
    const text = ownText(element);
    return {
      tag: element.tagName.toLowerCase(),
      rev: element.getAttribute(REV) ?? "",
      className: element.getAttribute("class") ?? "",
      computed,
      parent: {
        display: parent?.display ?? "block",
        flexDirection: parent?.flexDirection ?? "row",
      },
      ...(text === undefined ? {} : { text }),
    };
  },

  /** Stamped elements as a tree; unstamped elements in between are skipped. */
  layers() {
    const seen = new Map<string, number>();
    const visit = (parent: Element): LayerNode[] => {
      const nodes: LayerNode[] = [];
      for (const child of Array.from(parent.children)) {
        if (!child.hasAttribute(LOC)) {
          nodes.push(...visit(child));
          continue;
        }
        const hit = describe(child);
        const index = seen.get(hit.loc) ?? 0;
        seen.set(hit.loc, index + 1);
        nodes.push({ ...hit, index, name: layerName(child), children: visit(child) });
      }
      return nodes;
    };
    return visit(document.body);
  },

  /** The stamped chain at a point, nearest first, with what placing a new element there needs. */
  drop({ x, y }) {
    const under = stamped(document.elementFromPoint(x as number, y as number));
    // A framework route renders <html> and <body> itself, and those are the page, not content.
    const first = under === document.documentElement || under === document.body ? null : under;
    const nodes: Element[] = [];
    for (let up = first; up; up = stamped(up.parentElement)) nodes.push(up);
    // Over empty page: the top-level elements, nearest (last in the page) first.
    if (!first) nodes.push(...stampedChildren(document.body).reverse());
    const chain: DropNode[] = nodes.map((element) => ({
      ...dropChild(element),
      children: stampedChildren(element).map(dropChild),
    }));
    return { chain };
  },

  /** A `<path>`'s geometry as drawn, or `null` when `loc` isn't one. */
  vector({ loc, index }) {
    const element = instances(loc as string)[index as number];
    if (!(element instanceof SVGPathElement)) return null;
    const m = element.getScreenCTM();
    if (!m) return null;
    return {
      d: element.getAttribute("d") ?? "",
      ctm: [m.a, m.b, m.c, m.d, m.e, m.f],
      viewBox: element.ownerSVGElement?.getAttribute("viewBox") ?? null,
    };
  },
};

/**
 * How each axis sizes an element in a flex layout, which its computed size can't say: `hug` when it
 * measures as its content, `auto` as without a size of its own (stretched), else `fixed`. It
 * applies each size and measures it inside this one task, so nothing paints.
 */
function sizing(element: Element): Record<string, string> {
  if (!(element instanceof HTMLElement)) return {};
  const now = rectOf(element);
  const before = element.getAttribute("style");
  const measure = (value: string) => {
    element.style.setProperty("width", value, "important");
    element.style.setProperty("height", value, "important");
    return rectOf(element);
  };
  const hug = measure("fit-content");
  const auto = measure("auto");
  if (before === null) element.removeAttribute("style");
  else element.setAttribute("style", before);
  const read = (size: number, fit: number, free: number) =>
    Math.abs(size - fit) < 0.5 ? "hug" : Math.abs(size - free) < 0.5 ? "auto" : "fixed";
  return {
    sizedWidth: read(now.width, hug.width, auto.width),
    sizedHeight: read(now.height, hug.height, auto.height),
  };
}

function dropChild(element: Element): DropChild {
  const style = getComputedStyle(element);
  const hit = describe(element);
  const all = instances(hit.loc);
  return {
    ...hit,
    index: all.indexOf(element),
    count: all.length,
    rect: rectOf(element),
    display: style.display,
    flexDirection: style.flexDirection,
    position: style.position,
    borderLeft: parseFloat(style.borderLeftWidth) || 0,
    borderTop: parseFloat(style.borderTopWidth) || 0,
    scrollLeft: element.scrollLeft,
    scrollTop: element.scrollTop,
  };
}

/** The nearest stamped elements under `parent`, looking through unstamped ones. */
function stampedChildren(parent: Element): Element[] {
  return Array.from(parent.children).flatMap((child) =>
    child.hasAttribute(LOC) ? [child] : stampedChildren(child),
  );
}

// Previews: inline styles shown without writing them, undone on the next HMR update.

/** Each previewed element's `style` attribute before the preview. */
const previewed = new Map<HTMLElement | SVGElement, string | null>();

function restore(element: HTMLElement | SVGElement): void {
  const before = previewed.get(element);
  if (before === undefined) return;
  if (before === null) element.removeAttribute("style");
  else element.setAttribute("style", before);
  previewed.delete(element);
}

function preview(loc: string, styles: Record<string, string | null> | null): void {
  for (const element of instances(loc)) {
    if (!(element instanceof HTMLElement || element instanceof SVGElement)) continue;
    restore(element);
    if (!styles) continue;
    previewed.set(element, element.getAttribute("style"));
    for (const [key, value] of Object.entries(styles)) {
      const property = key.startsWith("--")
        ? key
        : key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
      element.style.setProperty(property, value ?? "unset", "important");
    }
  }
}

function clearPreviews(): void {
  for (const element of Array.from(previewed.keys())) restore(element);
}

function receive(event: MessageEvent): void {
  const message = event.data as Request;
  if (message.type === "preview") {
    preview(message.loc as string, message.styles as Record<string, string | null> | null);
    return;
  }
  const handle = requests[message.type];
  if (!handle) {
    post({ type: "refused", id: message.id, reason: `the frame doesn't know ${message.type}` });
    return;
  }
  try {
    post({ type: "reply", id: message.id, ok: true, value: handle(message) });
  } catch (error) {
    post({ type: "refused", id: message.id, reason: String((error as Error)?.message ?? error) });
  }
}

// Events

let size = { width: 0, height: 0 };

function reportSize(force = false): void {
  const html = document.documentElement;
  const next = {
    width: Math.ceil(html.scrollWidth),
    height: Math.ceil(
      Math.max(html.getBoundingClientRect().height, document.body?.scrollHeight ?? 0),
    ),
  };
  if (!force && next.width === size.width && next.height === size.height) return;
  size = next;
  post({ type: "size", ...size });
}

let sizeFrame = 0;
function scheduleSize(): void {
  if (sizeFrame) return;
  sizeFrame = requestAnimationFrame(() => {
    sizeFrame = 0;
    reportSize();
  });
}

/** Whether a key press belongs to a field; `composedPath` sees into shadow DOM, where `target` can't. */
function editable(event: Event): boolean {
  const target = event.composedPath()[0];
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName);
}

function text(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function reportError(kind: "error" | "rejection" | "console", message: string, stack?: string) {
  post(
    {
      type: "error",
      kind,
      message: message.slice(0, MAX_MESSAGE),
      ...(stack ? { stack: stack.slice(0, MAX_MESSAGE) } : {}),
    },
    true,
  );
}

/**
 * The update signal without Vite's HMR events (Next.js): a stamped element got a new rev, stamped
 * elements were added, or a stylesheet in the head changed, then quiet for `SETTLE_MS`. Style
 * attributes are left out, since previews write them.
 */
function watchUpdates(updated: () => void): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stampedNode = (node: Node) =>
    node instanceof Element && (node.hasAttribute(LOC) || node.querySelector(`[${LOC}]`) !== null);
  const observer = new MutationObserver((records) => {
    const relevant = records.some(
      (record) =>
        record.type === "attributes" ||
        !document.body?.contains(record.target) ||
        Array.from(record.addedNodes).some(stampedNode),
    );
    if (!relevant) return;
    clearTimeout(timer);
    timer = setTimeout(updated, SETTLE_MS);
  });
  const observe = () => {
    observer.observe(document.head, { childList: true, subtree: true, characterData: true });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [REV],
    });
  };
  if (document.body) observe();
  else document.addEventListener("DOMContentLoaded", observe);
}

function start(): void {
  window.addEventListener("error", (event) => {
    reportError("error", event.message || text(event.error), (event.error as Error)?.stack);
  });
  window.addEventListener("unhandledrejection", (event) => {
    reportError("rejection", text(event.reason), (event.reason as Error)?.stack);
  });
  const consoleError = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    consoleError(...args);
    reportError("console", args.map(text).join(" "));
  };

  window.addEventListener(
    "keydown",
    (event) => {
      if (editable(event) && !event.metaKey && !event.ctrlKey) return;
      post({
        type: "key",
        key: event.key,
        code: event.code,
        meta: event.metaKey,
        ctrl: event.ctrlKey,
        shift: event.shiftKey,
        alt: event.altKey,
      });
    },
    true,
  );

  window.addEventListener("message", (event) => {
    const data = event.data as { type?: unknown } | null;
    if (event.source !== window.parent || data?.type !== CONNECT || !event.ports[0]) return;
    // Only the Finite shell gets the port: another site framing this page can't drive it.
    const hosts =
      typeof FINITE_ALLOWED_HOSTS === "undefined" ? LOOPBACK_HOSTS : FINITE_ALLOWED_HOSTS;
    if (!allowsOrigin(hosts, event.origin)) return;
    port?.close();
    port = event.ports[0];
    port.onmessage = receive;
    for (const message of pending.splice(0)) port.postMessage(message);
    reportSize(true);
  });

  const observer = new ResizeObserver(scheduleSize);
  observer.observe(document.documentElement);
  if (document.body) observer.observe(document.body);
  else document.addEventListener("DOMContentLoaded", () => observer.observe(document.body));

  const updated = () => {
    clearPreviews();
    requestAnimationFrame(() => {
      post({ type: "updated" });
      scheduleSize();
    });
  };
  if (import.meta.hot) {
    import.meta.hot.on("vite:afterUpdate", () => setTimeout(updated, SETTLE_MS));
  } else {
    watchUpdates(updated);
  }

  window.parent.postMessage({ type: HELLO }, "*");
}

if (typeof window !== "undefined" && window.parent !== window) start();
