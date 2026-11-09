/// <reference lib="dom" />
/**
 * The iframe half of the bridge (`@finite/protocol` bridge.ts), loaded into every page the design's
 * dev server renders. The plugin serves it with its types stripped, so it imports nothing at
 * runtime: the constants below mirror the protocol and a test keeps them equal.
 */

import type { Measurement, MeasuredGap, MeasureTarget } from "@finite/protocol";

export const HELLO = "finite:hello";
export const CONNECT = "finite:connect";
const LOC = "data-finite-loc";
const REV = "data-finite-rev";
const MAX_PENDING = 100;
const MAX_MESSAGE = 4_000;
const MAX_CHILDREN = 200;
/** How far apart two lengths can be and still be the same CSS value after layout rounding. */
const SAME_LENGTH = 0.5;
/** Layout works in fractions of a pixel, so neighbours can overlap by this much and still touch. */
const TOUCHING = 0.02;
/** How far two rects must overlap across an axis to count as facing each other. */
const MIN_SHARED = 0.5;
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
] as const;

type Rect = { x: number; y: number; width: number; height: number };
type HitElement = { loc: string; rev: string; tag: string };
type LayerNode = HitElement & { index: number; name: string; children: LayerNode[] };
type Request = { type: string; id: number } & Record<string, unknown>;

declare global {
  interface ImportMeta {
    /** Vite's HMR API; written out as `import.meta.hot` so Vite sees it. */
    readonly hot?: { on(event: string, fn: () => void): void };
  }
  interface Window {
    /** Set only in a top-level page: how headless Chrome reaches the measuring code. */
    __finiteMeasure?: typeof measureElements;
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

export type Cut = { axis: "x" | "y"; size: number; rect: Rect; between: [number, number] };

const round = (n: number) => Math.round(n * 100) / 100;

function roundRect({ x, y, width, height }: Rect): Rect {
  return { x: round(x), y: round(y), width: round(width), height: round(height) };
}

function spanOf(rect: Rect, axis: "x" | "y"): [number, number] {
  return axis === "x" ? [rect.x, rect.x + rect.width] : [rect.y, rect.y + rect.height];
}

function strip(axis: "x" | "y", start: number, size: number, from: number, to: number): Rect {
  const rect =
    axis === "x"
      ? { x: start, y: from, width: size, height: to - from }
      : { x: from, y: start, width: to - from, height: size };
  return roundRect(rect);
}

function groupsAlong(rects: readonly Rect[], indices: number[], axis: "x" | "y"): number[][] {
  const sorted = [...indices].sort((a, b) => spanOf(rects[a], axis)[0] - spanOf(rects[b], axis)[0]);
  const groups: number[][] = [];
  let end = 0;
  for (const i of sorted) {
    const [start, stop] = spanOf(rects[i], axis);
    if (groups.length === 0 || start >= end - TOUCHING) {
      groups.push([i]);
      end = stop;
    } else {
      groups[groups.length - 1].push(i);
      end = Math.max(end, stop);
    }
  }
  return groups;
}

/** The channel between two neighbouring groups, across everything in both. */
function channel(rects: readonly Rect[], a: number[], b: number[], axis: "x" | "y"): Cut {
  const cross = axis === "x" ? "y" : "x";
  const end = (i: number) => spanOf(rects[i], axis)[1];
  const start = (i: number) => spanOf(rects[i], axis)[0];
  const last = a.reduce((best, i) => (end(i) > end(best) ? i : best));
  const first = b.reduce((best, i) => (start(i) < start(best) ? i : best));
  const across = [...a, ...b].map((i) => spanOf(rects[i], cross));
  const size = Math.max(0, start(first) - end(last));
  return {
    axis,
    size: round(size),
    rect: strip(
      axis,
      end(last),
      size,
      Math.min(...across.map((s) => s[0])),
      Math.max(...across.map((s) => s[1])),
    ),
    between: [last, first],
  };
}

/**
 * For a group no channel splits, as a spanning grid cell does: each rect's nearest neighbours to
 * the right and below, if nothing else sits in the strip between them. Grid cells share tracks, so
 * several neighbours are often equally near; they're all kept.
 */
function nearestNeighbours(rects: readonly Rect[], group: number[]): Cut[] {
  const cuts: Cut[] = [];
  for (const axis of ["x", "y"] as const) {
    const cross = axis === "x" ? "y" : "x";
    for (const i of group) {
      const end = spanOf(rects[i], axis)[1];
      const [low, high] = spanOf(rects[i], cross);
      const shared = (j: number) => {
        const [jLow, jHigh] = spanOf(rects[j], cross);
        return { from: Math.max(low, jLow), to: Math.min(high, jHigh) };
      };
      const candidates = group.filter((j) => {
        if (j === i || spanOf(rects[j], axis)[0] < end - TOUCHING) return false;
        const { from, to } = shared(j);
        return to - from > MIN_SHARED;
      });
      const nearest = Math.min(...candidates.map((j) => spanOf(rects[j], axis)[0]));
      for (const j of candidates) {
        const start = spanOf(rects[j], axis)[0];
        if (start > nearest + TOUCHING) continue;
        const { from, to } = shared(j);
        const size = Math.max(0, start - end);
        const rect = strip(axis, end, size, from, to);
        const blocked = group.some(
          (k) =>
            k !== i &&
            k !== j &&
            rects[k].x < rect.x + rect.width - TOUCHING &&
            rects[k].x + rects[k].width > rect.x + TOUCHING &&
            rects[k].y < rect.y + rect.height - TOUCHING &&
            rects[k].y + rects[k].height > rect.y + TOUCHING,
        );
        if (!blocked) cuts.push({ axis, size: round(size), rect, between: [i, j] });
      }
    }
  }
  return cuts;
}

/**
 * Recursive XY-cut (Nagy & Seth, 1984): split the rects into groups along the empty channels on
 * y, else on x, and recurse into each group. It reads only final rects, so flex, wrap, grid,
 * margin stacks and space-between are one code path and every gap is a measured distance.
 */
export function xyCut(rects: readonly Rect[]): Cut[] {
  const solve = (indices: number[]): Cut[] => {
    if (indices.length < 2) return [];
    for (const axis of ["y", "x"] as const) {
      const groups = groupsAlong(rects, indices, axis);
      if (groups.length < 2) continue;
      const cuts = groups.slice(1).map((group, g) => channel(rects, groups[g], group, axis));
      return [...cuts, ...groups.flatMap(solve)];
    }
    return nearestNeighbours(rects, indices);
  };
  return solve(rects.map((_, i) => i));
}

type InFlowChild = { node: Element | Text; rect: Rect; inline: boolean };

/** What the parent lays out: `display: contents` wrappers are replaced by their own children. */
function inFlowChildren(parent: Element): InFlowChild[] {
  return Array.from(parent.childNodes).flatMap((node): InFlowChild[] => {
    if (node instanceof Text) {
      if (!node.textContent?.trim()) return [];
      const range = document.createRange();
      range.selectNodeContents(node);
      const { x, y, width, height } = range.getBoundingClientRect();
      return width > 0 && height > 0
        ? [{ node, rect: roundRect({ x, y, width, height }), inline: true }]
        : [];
    }
    if (!(node instanceof Element)) return [];
    const style = getComputedStyle(node);
    if (style.display === "none") return [];
    if (style.display === "contents") return inFlowChildren(node);
    if (style.position === "absolute" || style.position === "fixed") return [];
    const rect = roundRect(rectOf(node));
    if (rect.width === 0 || rect.height === 0) return [];
    return [{ node, rect, inline: style.display.startsWith("inline") }];
  });
}

const px = (value: string) => parseFloat(value) || 0;

/** A computed corner radius, which can be elliptical ("20px 50%"), as its horizontal radius. */
export function horizontalRadius(value: string, width: number, scale: number): number {
  const [horizontal = ""] = value.split(" ");
  return horizontal.endsWith("%") ? (px(horizontal) / 100) * width : px(horizontal) * scale;
}

/** A computed gap in pixels. A percentage resolves against the content box along its axis. */
export function gapLength(value: string, contentSize: number, scale: number): number {
  return value.endsWith("%") ? (px(value) / 100) * contentSize : px(value) * scale;
}

function isAxisAligned(style: CSSStyleDeclaration): boolean {
  if (style.rotate && style.rotate !== "none") return false;
  const matrix = /matrix(3d)?\(([^)]+)\)/.exec(style.transform);
  if (!matrix) return true;
  const values = matrix[2].split(",").map(Number);
  // The off-diagonal terms; translation is fine and scale is handled by measureOne.
  const terms = matrix[1] ? [1, 2, 3, 4, 6, 7, 8, 9, 11] : [1, 2];
  return terms.every((i) => Math.abs(values[i]) < 1e-4);
}

function measureOne(element: Element, matches: Element[], props: readonly string[]): Measurement {
  const raw = rectOf(element);
  const style = getComputedStyle(element);
  const axisAligned = isAxisAligned(style);
  // offsetWidth is an integer, so a difference under a pixel is rounding and not a scale.
  const ratio = (size: number, offset: number) =>
    offset === 0 || Math.abs(size - offset) < 1 ? 1 : size / offset;
  const html = axisAligned && element instanceof HTMLElement ? element : null;
  const scaleX = html ? ratio(raw.width, html.offsetWidth) : 1;
  const scaleY = html ? ratio(raw.height, html.offsetHeight) : 1;

  const edges = (prefix: string, suffix = "") => {
    const read = (side: string, scale: number) =>
      round(px(style.getPropertyValue(`${prefix}-${side}${suffix}`)) * scale);
    return {
      top: read("top", scaleY),
      right: read("right", scaleX),
      bottom: read("bottom", scaleY),
      left: read("left", scaleX),
    };
  };
  const corner = (name: string) =>
    round(horizontalRadius(style.getPropertyValue(`border-${name}-radius`), raw.width, scaleX));
  const padding = edges("padding");
  const border = edges("border", "-width");

  const all = inFlowChildren(element);
  const items = all.slice(0, MAX_CHILDREN);
  const flow: Measurement["flow"] = style.display.endsWith("flex")
    ? "flex"
    : style.display.endsWith("grid")
      ? "grid"
      : items.some((item) => item.inline)
        ? "inline"
        : "block";

  const margin = (index: number, side: string) => {
    const { node } = items[index];
    return node instanceof Element ? px(getComputedStyle(node).getPropertyValue(side)) : 0;
  };
  const causeOf = ({ axis, size, between: [a, b] }: Cut): MeasuredGap["cause"] => {
    const scale = axis === "x" ? scaleX : scaleY;
    const cssGap =
      axis === "x"
        ? gapLength(
            style.columnGap,
            raw.width - padding.left - padding.right - border.left - border.right,
            scale,
          )
        : gapLength(
            style.rowGap,
            raw.height - padding.top - padding.bottom - border.top - border.bottom,
            scale,
          );
    const before = margin(a, axis === "x" ? "margin-right" : "margin-bottom") * scale;
    const after = margin(b, axis === "x" ? "margin-left" : "margin-top") * scale;
    const same = (length: number) => Math.abs(size - length) < SAME_LENGTH;
    if (cssGap > 0 && same(cssGap)) return "gap";
    if (before + after > 0 && (same(cssGap + before + after) || same(Math.max(before, after))))
      return "margin";
    return "free";
  };
  const gaps =
    flow === "inline"
      ? []
      : xyCut(items.map((item) => item.rect)).map((cut) => ({ ...cut, cause: causeOf(cut) }));

  const computed = style as unknown as Record<string, unknown>;
  const reported: Record<string, string> = {};
  for (const prop of props) {
    const value = computed[prop];
    if (typeof value === "string") reported[prop] = value;
  }

  const hit = describe(element);
  const stamp = element.getAttribute(LOC);
  const text = ownText(element);
  return {
    tag: hit.tag,
    name: layerName(element),
    ...(stamp === null ? {} : { loc: stamp }),
    ...(element.hasAttribute(REV) ? { rev: hit.rev } : {}),
    index: matches.indexOf(element),
    count: matches.length,
    box: roundRect(raw),
    padding,
    border,
    margin: edges("margin"),
    radius: {
      topLeft: corner("top-left"),
      topRight: corner("top-right"),
      bottomRight: corner("bottom-right"),
      bottomLeft: corner("bottom-left"),
    },
    axisAligned,
    flow,
    children: items.map(({ node, rect }) => {
      if (node instanceof Element) {
        const loc = node.getAttribute(LOC);
        return {
          tag: node.tagName.toLowerCase(),
          name: layerName(node),
          ...(loc === null ? {} : { loc }),
          rect,
        };
      }
      const run = (node.textContent ?? "").trim();
      return { tag: "#text", name: run.length > 40 ? `${run.slice(0, 39)}…` : run, rect };
    }),
    childCount: all.length,
    gaps,
    style: reported,
    ...(text === undefined ? {} : { text }),
  };
}

/** Resolves each target and measures it; `null` where nothing matched. Reads layout, writes nothing. */
export function measureElements(
  targets: readonly MeasureTarget[],
  props: readonly string[],
): (Measurement | null)[] {
  return targets.map((target) => {
    if ("at" in target) {
      let element = stamped(document.elementFromPoint(target.at.x, target.at.y));
      for (let up = target.up ?? 0; element && up > 0; up--) {
        const parent = stamped(element.parentElement);
        if (!parent) break;
        element = parent;
      }
      if (!element) return null;
      return measureOne(element, instances(element.getAttribute(LOC) ?? ""), props);
    }
    const matches =
      "loc" in target
        ? instances(target.loc)
        : Array.from(document.querySelectorAll(target.select));
    const element = matches[target.index];
    return element ? measureOne(element, matches, props) : null;
  });
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

  measure({ targets, props }) {
    return measureElements(targets as MeasureTarget[], props as string[]);
  },
};

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

function editable(target: EventTarget | null): boolean {
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
      if (editable(event.target) && !event.metaKey && !event.ctrlKey) return;
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

if (typeof window !== "undefined") {
  if (window.parent !== window) start();
  // A top-level load is headless Chrome measuring for an agent; it has no parent to connect to.
  else window.__finiteMeasure = measureElements;
}
