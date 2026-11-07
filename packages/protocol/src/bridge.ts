import { z } from "zod";
import { Loc, Rect, Rev } from "./model.ts";

/**
 * The parent page and each frame's iframe talk over a MessageChannel. The iframe announces itself
 * with `window.parent.postMessage(BridgeHello)`; the parent answers with `BridgeConnect` on the
 * iframe's window and transfers `port2`. Everything after that goes over the port.
 */
export const BRIDGE_HELLO = "finite:hello";
export const BRIDGE_CONNECT = "finite:connect";

export const BridgeHello = z.object({ type: z.literal(BRIDGE_HELLO) });
export type BridgeHello = z.infer<typeof BridgeHello>;
export const BridgeConnect = z.object({ type: z.literal(BRIDGE_CONNECT), frameId: z.string() });
export type BridgeConnect = z.infer<typeof BridgeConnect>;

export const HitElement = z.object({ loc: Loc, rev: Rev, tag: z.string() });
export type HitElement = z.infer<typeof HitElement>;

export const Hit = HitElement.extend({
  rect: Rect,
  /** Which rendered instance of `loc` was hit, and how many there are. */
  index: z.number().int().min(0),
  count: z.number().int().min(1),
  /** Stamped ancestors, nearest first. */
  path: z.array(HitElement),
});
export type Hit = z.infer<typeof Hit>;

export const Inspection = z.object({
  tag: z.string(),
  rev: Rev,
  className: z.string(),
  computed: z.record(z.string(), z.string()),
  parent: z.object({ display: z.string(), flexDirection: z.string() }),
  text: z.string().optional(),
});
export type Inspection = z.infer<typeof Inspection>;

export type LayerNode = {
  loc: Loc;
  rev: Rev;
  tag: string;
  index: number;
  name: string;
  children: LayerNode[];
};
export const LayerNode: z.ZodType<LayerNode> = z.lazy(() =>
  z.object({
    loc: Loc,
    rev: Rev,
    tag: z.string(),
    index: z.number().int().min(0),
    name: z.string(),
    children: z.array(LayerNode),
  }),
);

/** Requests the parent sends; `id` pairs a request with its reply. */
export const bridgeRequests = {
  hit: { params: { x: z.number(), y: z.number() }, result: Hit.nullable() },
  rects: { params: { locs: z.array(Loc) }, result: z.record(z.string(), z.array(Rect)) },
  inspect: { params: { loc: Loc, index: z.number().int().min(0) }, result: Inspection.nullable() },
  layers: { params: {}, result: z.array(LayerNode) },
} as const satisfies Record<string, { params: z.ZodRawShape; result: z.ZodType }>;

export type BridgeRequestType = keyof typeof bridgeRequests;
export type BridgeResult<K extends BridgeRequestType> = z.infer<
  (typeof bridgeRequests)[K]["result"]
>;

const request = <K extends BridgeRequestType>(type: K) =>
  z.object({ type: z.literal(type), id: z.number().int(), ...bridgeRequests[type].params });

/** Parent → iframe. `preview` shows styles without writing them; `null` clears it (so does an HMR update). */
export const ParentMessage = z.discriminatedUnion("type", [
  request("hit"),
  request("rects"),
  request("inspect"),
  request("layers"),
  z.object({
    type: z.literal("preview"),
    loc: Loc,
    styles: z.record(z.string(), z.string().nullable()).nullable(),
  }),
]);
export type ParentMessage = z.infer<typeof ParentMessage>;

/** Iframe → parent. */
export const FrameMessage = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("reply"),
    id: z.number().int(),
    ok: z.literal(true),
    value: z.unknown(),
  }),
  z.object({
    type: z.literal("refused"),
    id: z.number().int(),
    reason: z.string(),
  }),
  /** The document's size changed (drives hug frames). */
  z.object({ type: z.literal("size"), width: z.number(), height: z.number() }),
  /** Vite applied an HMR update, so rects and revs may have moved. */
  z.object({ type: z.literal("updated") }),
  /** A key pressed while the iframe had focus, for canvas shortcuts. */
  z.object({
    type: z.literal("key"),
    key: z.string(),
    code: z.string(),
    meta: z.boolean(),
    ctrl: z.boolean(),
    shift: z.boolean(),
    alt: z.boolean(),
  }),
  z.object({
    type: z.literal("error"),
    kind: z.enum(["error", "rejection", "console"]),
    message: z.string(),
    stack: z.string().optional(),
  }),
]);
export type FrameMessage = z.infer<typeof FrameMessage>;

export type BridgeEvent = Exclude<FrameMessage, { type: "reply" | "refused" }>;

/** The parent's handle on one frame (`apps/web/src/canvas/bridge.ts`). */
export interface FrameBridge {
  hit(x: number, y: number): Promise<Hit | null>;
  rects(locs: Loc[]): Promise<Record<Loc, Rect[]>>;
  inspect(loc: Loc, index: number): Promise<Inspection | null>;
  layers(): Promise<LayerNode[]>;
  preview(loc: Loc, styles: Record<string, string | null> | null): void;
  on(fn: (event: BridgeEvent) => void): () => void;
  close(): void;
}
