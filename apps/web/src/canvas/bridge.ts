import {
  BRIDGE_CONNECT,
  BRIDGE_HELLO,
  type BridgeEvent,
  type BridgeRequestType,
  bridgeRequests,
  type BridgeResult,
  type DropNode,
  type FrameBridge,
  FrameMessage,
  type Hit,
  type Inspection,
  type LayerNode,
  type Loc,
  MEASURE_PROPS,
  type Rect,
  type VectorInfo,
} from "@finite/protocol";

/** How long a request waits for the frame, its hello included, before it gives up. */
const TIMEOUT_MS = 5000;

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };

/** The bridges of the frames mounted now, by frame id, so the editor can reach any of them. */
const live = new Map<string, FrameBridge>();
const liveListeners = new Set<() => void>();

export function bridgeOf(frameId: string): FrameBridge | undefined {
  return live.get(frameId);
}

export function mountedBridges(): ReadonlyMap<string, FrameBridge> {
  return live;
}

/** Runs `fn` whenever a frame's bridge connects or goes. */
export function onBridgesChange(fn: () => void): () => void {
  liveListeners.add(fn);
  return () => liveListeners.delete(fn);
}

/** The frame windows waiting for a hello, by window. One `message` listener serves them all. */
const byWindow = new Map<Window, (source: Window) => void>();
let listening = false;

function listen() {
  if (listening) return;
  listening = true;
  window.addEventListener("message", (e) => {
    if (!e.source || (e.data as { type?: unknown } | null)?.type !== BRIDGE_HELLO) return;
    byWindow.get(e.source as Window)?.(e.source as Window);
  });
}

/**
 * The parent half of the bridge for one iframe. The frame says hello on every load (a reload or
 * a full HMR reload included); each hello opens a new MessageChannel, and requests made before it
 * wait for it. Requests in flight when the frame reloads are refused: the frame says when it's
 * leaving, and a next hello refuses anything a frame left without saying so.
 */
export function connectFrame(iframe: HTMLIFrameElement, frameId: string): FrameBridge {
  listen();
  let port: MessagePort | null = null;
  /** Requests made before a hello, by id. Each is in `pending` too, so its timer and `close` reach it. */
  const waiting = new Map<number, () => void>();
  let nextId = 0;
  const pending = new Map<number, Pending>();
  const listeners = new Set<(event: BridgeEvent) => void>();
  let closed = false;

  const dropPending = (reason: string) => {
    for (const [id, p] of pending) {
      if (waiting.has(id)) continue;
      pending.delete(id);
      p.reject(new Error(reason));
    }
  };

  /** Whether this document said hello; a load without one (it said it too early) connects anyway. */
  let greeted = false;
  /** `port` came from that load, so its document's own hello may still be on the way. */
  let helloDue = false;
  const onHello = (source: Window, fromLoad = false) => {
    if (closed) return;
    // Not `greeted`: if this was a next document's hello after all, its load connects it.
    if (port && helloDue && !fromLoad) {
      helloDue = false;
      return;
    }
    greeted = true;
    helloDue = fromLoad;
    port?.close();
    dropPending("The frame reloaded");
    const channel = new MessageChannel();
    port = channel.port1;
    port.onmessage = (m) => {
      const parsed = FrameMessage.safeParse(m.data);
      if (!parsed.success) return;
      const msg = parsed.data;
      if (msg.type === "leaving") {
        port?.close();
        port = null;
        greeted = false;
        helloDue = false;
        dropPending("The frame reloaded");
        return;
      }
      if (msg.type === "reply" || msg.type === "refused") {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.type === "reply") p?.resolve(msg.value);
        else p?.reject(new Error(msg.reason));
        return;
      }
      for (const fn of listeners) fn(msg);
    };
    source.postMessage({ type: BRIDGE_CONNECT, frameId }, "*", [channel.port2]);
    for (const fn of waiting.values()) fn();
    waiting.clear();
  };

  const register = () => {
    const win = iframe.contentWindow;
    if (win) byWindow.set(win, onHello);
  };
  register();
  // A navigation keeps the same WindowProxy, but register again in case the browser swapped it.
  // Module scripts run before `load`, so a frame that said hello before we listened is caught here.
  const onLoad = () => {
    register();
    if (!greeted && iframe.contentWindow) onHello(iframe.contentWindow, true);
    greeted = false;
  };
  iframe.addEventListener("load", onLoad);

  const send = <K extends BridgeRequestType>(
    type: K,
    params: Record<string, unknown>,
  ): Promise<BridgeResult<K>> => {
    if (closed) return Promise.reject(new Error("The frame is gone"));
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(id);
        waiting.delete(id);
        reject(new Error("The frame didn't answer"));
      }, TIMEOUT_MS);
      pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v as BridgeResult<K>);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      const go = () => port!.postMessage({ type, id, ...params });
      if (port) go();
      else waiting.set(id, go);
    });
  };

  const bridge: FrameBridge = {
    hit: (x, y) => send("hit", { x, y }) as Promise<Hit | null>,
    rects: (locs) => send("rects", { locs }) as Promise<Record<Loc, Rect[]>>,
    inspect: (loc, index) => send("inspect", { loc, index }) as Promise<Inspection | null>,
    layers: () => send("layers", {}) as Promise<LayerNode[]>,
    // Parsed, unlike the rest: the overlay is innerHTML, and a design's JS can answer on this port.
    measure: async (targets) =>
      bridgeRequests.measure.result.parse(await send("measure", { targets, props: MEASURE_PROPS })),
    drop: (x, y) => send("drop", { x, y }) as Promise<{ chain: DropNode[] }>,
    vector: (loc, index) => send("vector", { loc, index }) as Promise<VectorInfo | null>,
    preview(loc, styles) {
      port?.postMessage({ type: "preview", loc, styles });
    },
    on(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    close() {
      closed = true;
      iframe.removeEventListener("load", onLoad);
      for (const [win, fn] of byWindow) if (fn === onHello) byWindow.delete(win);
      port?.close();
      waiting.clear();
      dropPending("The frame is gone");
      if (live.get(frameId) === bridge) {
        live.delete(frameId);
        for (const fn of liveListeners) fn();
      }
    },
  };
  live.set(frameId, bridge);
  for (const fn of liveListeners) fn();
  return bridge;
}
