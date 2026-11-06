// What a sandboxed artboard's bootstrap (`crates/design/src/bootstrap.js`)
// tells the viewer, decoded in one place. The artboard's own scripts can
// post to the viewer too, so nothing here is trusted: every field is
// checked, and a message that doesn't fit is dropped.

import type { Bounds } from "./types";

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

/** A wheel event forwarded out of a sandboxed artboard, in the iframe's own pixels. */
export interface FrameWheel {
  readonly deltaX: number;
  readonly deltaY: number;
  readonly deltaMode: number;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly clientX: number;
  readonly clientY: number;
}

/** Longest host name, per DNS. */
const MAX_HOST = 253;

/** A message the bootstrap sends over the private port. */
export type FrameMessage =
  /** The node under a point the viewer asked about, and where it is. */
  | {
      readonly type: "hit";
      readonly x: number;
      readonly y: number;
      readonly id: string | null;
      readonly rect: Bounds | null;
    }
  /** Where a node the viewer asked about is. */
  | { readonly type: "rect"; readonly id: string; readonly rect: Bounds | null }
  | { readonly type: "size"; readonly width: number; readonly height: number }
  | { readonly type: "storage"; readonly change: StorageChange }
  /** The page reached `host`. */
  | { readonly type: "network"; readonly host: string }
  /** A person clicked a link to an artboard; `flow::href_target` reads the target out of `href`. */
  | { readonly type: "goto"; readonly href: string }
  | { readonly type: "open"; readonly url: string }
  | ({ readonly type: "key" } & FrameKey)
  | { readonly type: "pan" }
  | { readonly type: "blur" }
  | { readonly type: "used" }
  | ({ readonly type: "wheel" } & FrameWheel);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

function decodeBounds(value: unknown): Bounds | null {
  if (!isRecord(value)) return null;
  const { x, y, width, height, outset } = value;
  if (!isNumber(x) || !isNumber(y) || !isNumber(width) || !isNumber(height)) return null;
  const o = isRecord(outset) ? outset : {};
  const side = (key: string) => (isNumber(o[key]) ? Math.max(0, o[key]) : 0);
  return {
    x,
    y,
    width,
    height,
    outset: { top: side("top"), right: side("right"), bottom: side("bottom"), left: side("left") },
  };
}

function decodeStorage(m: Record<string, unknown>): StorageChange | null {
  const set: Array<readonly [string, string | null]> = [];
  if (Array.isArray(m.set)) {
    for (const entry of m.set as unknown[]) {
      if (!Array.isArray(entry) || typeof entry[0] !== "string") return null;
      const value: unknown = entry[1];
      if (value !== null && typeof value !== "string") return null;
      set.push([entry[0], value]);
    }
  }
  return { set, clear: m.clear === true };
}

/** The message a port delivered, or `null` when it isn't a well-formed one. */
export function decodeFrameMessage(data: unknown): FrameMessage | null {
  if (!isRecord(data)) return null;
  const m = data;
  // Missing or non-finite numbers read as 0.
  const num = (key: string) => (isNumber(m[key]) ? m[key] : 0);
  switch (m.type) {
    case "hit":
      return {
        type: "hit",
        x: num("x"),
        y: num("y"),
        id: typeof m.id === "string" ? m.id : null,
        rect: decodeBounds(m.rect),
      };
    case "rect":
      return typeof m.id === "string"
        ? { type: "rect", id: m.id, rect: decodeBounds(m.rect) }
        : null;
    case "size":
      return { type: "size", width: num("width"), height: num("height") };
    case "storage": {
      const change = decodeStorage(m);
      return change && { type: "storage", change };
    }
    case "network":
      return typeof m.host === "string" && m.host.length <= MAX_HOST
        ? { type: "network", host: m.host }
        : null;
    case "goto":
      return typeof m.href === "string" ? { type: "goto", href: m.href } : null;
    case "open":
      return typeof m.url === "string" ? { type: "open", url: m.url } : null;
    case "key":
      return typeof m.key === "string"
        ? {
            type: "key",
            key: m.key,
            phase: m.phase === "up" ? "up" : "down",
            meta: m.meta === true,
            repeat: m.repeat === true,
          }
        : null;
    case "pan":
    case "blur":
    case "used":
      return { type: m.type };
    case "wheel":
      return {
        type: "wheel",
        deltaX: num("deltaX"),
        deltaY: num("deltaY"),
        deltaMode: num("deltaMode"),
        ctrlKey: m.ctrlKey === true,
        metaKey: m.metaKey === true,
        shiftKey: m.shiftKey === true,
        clientX: num("clientX"),
        clientY: num("clientY"),
      };
    default:
      return null;
  }
}

/**
 * The nonce in a bootstrap's `hello`, a `window` message that carries no
 * port yet. `null` for anything else.
 */
export function decodeHello(data: unknown): string | null {
  const m = isRecord(data) && isRecord(data.finite) ? data.finite : null;
  return m?.type === "hello" && typeof m.nonce === "string" ? m.nonce : null;
}
