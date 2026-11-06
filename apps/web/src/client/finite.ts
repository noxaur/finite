"use client";

import {
  type Canvas,
  type ClaudeStatus,
  type DesignEntry,
  type DesignState,
  type Params,
  type RefusalCode,
  type RequestType,
  type Result,
  type ServerEvent,
  type ServerMessage,
  type Settings,
  type ThreadEvent,
  type ThreadMeta,
  type User,
  WS_PATH,
} from "@finite/protocol";
import { useEffect, useSyncExternalStore } from "react";

/**
 * The page's one connection to the Finite server: a WebSocket on `/api/ws` that reconnects by
 * itself, typed requests, server events, and the live state React reads through the hooks below.
 *
 * Requests made while the socket is down wait for it, and every design a screen shows is
 * subscribed again after a reconnect, so callers never see the socket come and go.
 */

/** A refused or failed request. `message` is the reason, written to be shown to a person. */
export class FiniteError extends Error {
  readonly code: RefusalCode | undefined;
  constructor(reason: string, code?: RefusalCode) {
    super(reason);
    this.name = "FiniteError";
    this.code = code;
  }
}

export type ConnectionStatus = "connecting" | "open" | "closed";

/** A design's state as a screen sees it: `null` until `subscribe` answers. */
export interface DesignView {
  readonly state: DesignState | null;
  /** Why the design couldn't be opened. */
  readonly error: string | null;
}

/** A thread's messages: the stored history plus what arrived live, and the text still streaming. */
export interface ThreadView {
  readonly events: ReadonlyArray<ThreadEvent>;
  /** Agent text streamed by `text.delta` since the last `text` event. */
  readonly streaming: string;
  readonly loaded: boolean;
}

type EventType = ServerEvent["type"];
type EventOf<T extends EventType> = Extract<ServerEvent, { type: T }>;

/** The parts of the browser's WebSocket this uses, so tests can pass a fake. */
export interface SocketLike {
  readyState: number;
  onopen: ((e: unknown) => void) | null;
  onclose: ((e: unknown) => void) | null;
  onerror: ((e: unknown) => void) | null;
  onmessage: ((e: { data: unknown }) => void) | null;
  send(data: string): void;
  close(): void;
}

export interface FiniteOptions {
  url: () => string;
  WebSocket: new (url: string) => SocketLike;
  user: () => User;
  /** How long a request waits for its reply. */
  timeoutMs?: number;
  /** How long a design stays subscribed after its last screen lets go, so a remount doesn't resubscribe. */
  lingerMs?: number;
}

const OPEN = 1;
const DEFAULT_TIMEOUT_MS = 30_000;
/** Requests that do slow work on the server (scaffolding a project, installing packages). */
const SLOW: ReadonlySet<RequestType> = new Set(["design.create", "design.connect", "subscribe"]);
const SLOW_TIMEOUT_MS = 10 * 60_000;
const BACKOFF_MS = [250, 500, 1000, 2000, 5000];

const NO_DESIGN: DesignView = { state: null, error: null };
const NO_THREAD: ThreadView = { events: [], streaming: "", loaded: false };

export type Finite = ReturnType<typeof createFinite>;

export function createFinite(options: FiniteOptions) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const lingerMs = options.lingerMs ?? 5000;

  let socket: SocketLike | null = null;
  let status: ConnectionStatus = "closed";
  let ready = false;
  let started = false;
  let attempt = 0;
  let nextRid = 1;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;

  const pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  /** Requests waiting for the socket to open and say hello. */
  const waiting: { send: () => void }[] = [];
  const handlers = new Map<EventType, Set<(event: ServerEvent) => void>>();

  // Live state, replaced (never mutated) on every change so useSyncExternalStore sees it.
  const listeners = new Set<() => void>();
  let designs: ReadonlyArray<DesignEntry> | null = null;
  let designsWanted = false;
  let settings: Settings | null = null;
  let settingsWanted = false;
  let claude: ClaudeStatus | null = null;
  let claudeWanted = false;
  const views = new Map<string, DesignView>();
  const holds = new Map<string, number>();
  const lingering = new Map<string, ReturnType<typeof setTimeout>>();
  const threads = new Map<string, ThreadView>();
  const threadHolds = new Map<string, { designId: string; count: number }>();

  const notify = () => {
    for (const listener of listeners) listener();
  };

  function setStatus(next: ConnectionStatus) {
    if (status === next) return;
    status = next;
    notify();
  }

  function start() {
    if (started) return;
    started = true;
    connect();
  }

  function connect() {
    setStatus("connecting");
    let ws: SocketLike;
    try {
      ws = new options.WebSocket(options.url());
    } catch {
      return retry();
    }
    socket = ws;
    ws.onopen = () => {
      attempt = 0;
      const rid = `r${nextRid++}`;
      track(rid, "hello")
        .then(() => {
          if (socket !== ws) return;
          ready = true;
          setStatus("open");
          for (const w of waiting.splice(0)) w.send();
          resume();
        })
        .catch(() => ws.close());
      ws.send(JSON.stringify({ type: "hello", rid, user: options.user() }));
    };
    ws.onmessage = (e) => {
      if (typeof e.data !== "string") return;
      let message: ServerMessage;
      try {
        message = JSON.parse(e.data) as ServerMessage;
      } catch {
        return;
      }
      receive(message);
    };
    ws.onerror = () => {};
    ws.onclose = () => {
      if (socket !== ws) return;
      socket = null;
      ready = false;
      for (const [rid, p] of pending) {
        clearTimeout(p.timer);
        pending.delete(rid);
        p.reject(new FiniteError("Lost the connection to Finite. Try again in a moment."));
      }
      retry();
    };
  }

  function retry() {
    setStatus("closed");
    const delay = BACKOFF_MS[Math.min(attempt++, BACKOFF_MS.length - 1)]!;
    clearTimeout(retryTimer);
    retryTimer = setTimeout(connect, delay);
  }

  /** After (re)connecting: fetch again whatever the page is showing. */
  function resume() {
    if (designsWanted) void loadDesigns();
    if (settingsWanted) void loadSettings();
    if (claudeWanted) void loadClaude();
    for (const designId of holds.keys()) void subscribeDesign(designId);
    for (const [threadId, { designId }] of threadHolds) void loadThread(designId, threadId);
  }

  function track(rid: string, type: RequestType): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => {
          pending.delete(rid);
          reject(new FiniteError(`Finite didn't answer ${type} in time. Try again.`));
        },
        SLOW.has(type) ? Math.max(timeoutMs, SLOW_TIMEOUT_MS) : timeoutMs,
      );
      pending.set(rid, { resolve, reject, timer });
    });
  }

  function receive(message: ServerMessage) {
    if (message.type === "reply") {
      const p = pending.get(message.rid);
      if (!p) return;
      pending.delete(message.rid);
      clearTimeout(p.timer);
      if (message.ok) p.resolve(message.value);
      else p.reject(new FiniteError(message.reason, message.code));
      return;
    }
    apply(message);
    for (const fn of handlers.get(message.type) ?? []) fn(message);
  }

  /** Folds a server event into the live state. */
  function apply(event: ServerEvent) {
    switch (event.type) {
      case "designs":
        designs = event.list;
        break;
      case "settings":
        settings = event.settings;
        break;
      case "canvas":
        updateState(event.designId, (s) => ({ ...s, canvases: upsert(s.canvases, event.canvas) }));
        return;
      case "thread":
        updateState(event.designId, (s) => ({ ...s, threads: upsert(s.threads, event.meta) }));
        return;
      case "preview": {
        const { type: _t, designId, ...preview } = event;
        updateState(designId, (s) => ({ ...s, preview }));
        return;
      }
      case "routes":
        updateState(event.designId, (s) => ({ ...s, routes: event.routes }));
        return;
      case "thread.event":
        appendThreadEvent(event.threadId, event.event);
        return;
    }
    notify();
  }

  function updateState(designId: string, fn: (state: DesignState) => DesignState) {
    const view = views.get(designId);
    if (!view?.state) return;
    views.set(designId, { ...view, state: fn(view.state) });
    notify();
  }

  function appendThreadEvent(threadId: string, event: ThreadEvent) {
    const view = threads.get(threadId);
    if (!view) return;
    if (event.type === "text.delta") {
      threads.set(threadId, { ...view, streaming: view.streaming + event.text });
    } else {
      const streaming = event.type === "text" || event.type === "result" ? "" : view.streaming;
      threads.set(threadId, { ...view, events: [...view.events, event], streaming });
    }
    notify();
  }

  function request<K extends RequestType>(type: K, params: Params<K>): Promise<Result<K>> {
    start();
    return new Promise<Result<K>>((resolve, reject) => {
      const send = () => {
        const ws = socket;
        if (!ws || !ready || ws.readyState !== OPEN) {
          waiting.push({ send });
          return;
        }
        const rid = `r${nextRid++}`;
        track(rid, type).then((v) => resolve(v as Result<K>), reject);
        ws.send(JSON.stringify({ ...params, type, rid }));
      };
      send();
    });
  }

  function on<T extends EventType>(type: T, fn: (event: EventOf<T>) => void): () => void {
    start();
    let set = handlers.get(type);
    if (!set) handlers.set(type, (set = new Set()));
    const handler = fn as (event: ServerEvent) => void;
    set.add(handler);
    return () => void set.delete(handler);
  }

  async function loadDesigns() {
    try {
      designs = await request("designs.list", {});
      notify();
    } catch {
      // The socket reconnects and asks again.
    }
  }

  async function loadSettings() {
    try {
      settings = await request("settings.get", {});
      notify();
    } catch {
      // As above.
    }
  }

  async function loadClaude() {
    try {
      claude = await request("claude.status", {});
      notify();
    } catch {
      claude = { installed: false, loggedIn: false, models: [] };
      notify();
    }
  }

  async function subscribeDesign(designId: string) {
    try {
      const state = await request("subscribe", { designId });
      if (!holds.has(designId)) return;
      views.set(designId, { state, error: null });
    } catch (error) {
      if (!holds.has(designId)) return;
      const reason = error instanceof Error ? error.message : String(error);
      // A lost connection resubscribes on its own; keep what's on screen.
      if (status !== "open") return;
      views.set(designId, { state: views.get(designId)?.state ?? null, error: reason });
    }
    notify();
  }

  /** Keeps a design subscribed while anything holds it. Returns the release. */
  function holdDesign(designId: string): () => void {
    clearTimeout(lingering.get(designId));
    lingering.delete(designId);
    const count = holds.get(designId) ?? 0;
    holds.set(designId, count + 1);
    if (count === 0 && !views.has(designId)) {
      views.set(designId, NO_DESIGN);
      void subscribeDesign(designId);
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (holds.get(designId) ?? 1) - 1;
      if (left > 0) return void holds.set(designId, left);
      lingering.set(
        designId,
        setTimeout(() => {
          lingering.delete(designId);
          if ((holds.get(designId) ?? 0) > 0) return;
          holds.delete(designId);
          views.delete(designId);
          if (ready) request("unsubscribe", { designId }).catch(() => {});
          notify();
        }, lingerMs),
      );
      holds.set(designId, 0);
    };
  }

  async function loadThread(designId: string, threadId: string) {
    try {
      const history = await request("thread.history", { designId, threadId });
      const view = threads.get(threadId);
      if (!view) return;
      // Events that arrived while history loaded may already be in it.
      const stored = new Set(history.map((e) => JSON.stringify(e)));
      const live = view.events.filter((e) => !stored.has(JSON.stringify(e)));
      threads.set(threadId, {
        events: [...history, ...live],
        streaming: view.streaming,
        loaded: true,
      });
    } catch {
      const view = threads.get(threadId);
      if (view) threads.set(threadId, { ...view, loaded: true });
    }
    notify();
  }

  function holdThread(designId: string, threadId: string): () => void {
    const releaseDesign = holdDesign(designId);
    const hold = threadHolds.get(threadId);
    if (hold) hold.count++;
    else {
      threadHolds.set(threadId, { designId, count: 1 });
      threads.set(threadId, NO_THREAD);
      void loadThread(designId, threadId);
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseDesign();
      const h = threadHolds.get(threadId);
      if (!h) return;
      if (--h.count > 0) return;
      threadHolds.delete(threadId);
      threads.delete(threadId);
    };
  }

  // React subscribes during commit, so the socket starts just after, not inside it.
  const subscribe = (listener: () => void) => {
    queueMicrotask(start);
    listeners.add(listener);
    return () => void listeners.delete(listener);
  };

  return {
    request,
    on,
    subscribe,
    holdDesign,
    holdThread,
    status: () => status,
    designs: () => designs,
    settings: () => settings,
    claude: () => claude,
    /** Loads what a hook reads, once, and again after each reconnect. */
    want(what: "designs" | "settings" | "claude") {
      if (what === "designs" && !designsWanted) {
        designsWanted = true;
        void loadDesigns();
      } else if (what === "settings" && !settingsWanted) {
        settingsWanted = true;
        void loadSettings();
      } else if (what === "claude" && !claudeWanted) {
        claudeWanted = true;
        void loadClaude();
      }
    },
    /** Asks Claude's status again, after the person installs or logs in. */
    refreshClaude: () => {
      claudeWanted = true;
      return loadClaude();
    },
    design: (designId: string) => views.get(designId) ?? NO_DESIGN,
    thread: (threadId: string) => threads.get(threadId) ?? NO_THREAD,
    /** Stops reconnecting and closes the socket: for tests. */
    close() {
      clearTimeout(retryTimer);
      started = true;
      const ws = socket;
      socket = null;
      ws?.close();
    },
  };
}

function upsert<T extends { id: string }>(list: ReadonlyArray<T>, item: T): T[] {
  const at = list.findIndex((x) => x.id === item.id);
  if (at === -1) return [...list, item];
  const next = [...list];
  next[at] = item;
  return next;
}

// The page's client.

const USER_ID_KEY = "finite.user";
const USER_NAME_KEY = "finite.user.name";
const fallbackId = typeof crypto !== "undefined" ? crypto.randomUUID() : "anonymous";

/** This browser's identity: people have no accounts yet, so each browser keeps a random id. */
export function localUser(): User {
  try {
    let id = localStorage.getItem(USER_ID_KEY);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(USER_ID_KEY, id);
    }
    return { id, name: localStorage.getItem(USER_NAME_KEY) || "Guest" };
  } catch {
    return { id: fallbackId, name: "Guest" };
  }
}

const browser = typeof window !== "undefined";

export const finite: Finite = createFinite({
  url: () => `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${WS_PATH}`,
  WebSocket: (browser ? window.WebSocket : class {}) as unknown as FiniteOptions["WebSocket"],
  user: localUser,
});

// Hooks. On the server render they read nothing; the socket starts in the browser.

const noop = () => () => {};
const subscribe = browser ? finite.subscribe : noop;

export function useConnection(): ConnectionStatus {
  return useSyncExternalStore(subscribe, finite.status, () => "connecting" as const);
}

/** Every design, newest list from the server, or `null` until it answers. */
export function useDesigns(): ReadonlyArray<DesignEntry> | null {
  useEffect(() => finite.want("designs"), []);
  return useSyncExternalStore(subscribe, finite.designs, () => null);
}

/** A design's canvases, threads, preview and routes, kept live while the caller is mounted. */
export function useDesignState(designId: string | null): DesignView {
  useEffect(() => (designId ? finite.holdDesign(designId) : undefined), [designId]);
  return useSyncExternalStore(
    subscribe,
    () => (designId ? finite.design(designId) : NO_DESIGN),
    () => NO_DESIGN,
  );
}

export function useSettings(): Settings | null {
  useEffect(() => finite.want("settings"), []);
  return useSyncExternalStore(subscribe, finite.settings, () => null);
}

export function useClaudeStatus(): ClaudeStatus | null {
  useEffect(() => finite.want("claude"), []);
  return useSyncExternalStore(subscribe, finite.claude, () => null);
}

/** A thread's history and live events. Holds its design subscribed, which carries the events. */
export function useThreadEvents(designId: string | null, threadId: string | null): ThreadView {
  useEffect(
    () => (designId && threadId ? finite.holdThread(designId, threadId) : undefined),
    [designId, threadId],
  );
  return useSyncExternalStore(
    subscribe,
    () => (threadId ? finite.thread(threadId) : NO_THREAD),
    () => NO_THREAD,
  );
}

/** A canvas of a design, from the live state. */
export function findCanvas(view: DesignView, canvasId: string | null): Canvas | undefined {
  return canvasId ? view.state?.canvases.find((c) => c.id === canvasId) : undefined;
}

export function findThread(view: DesignView, threadId: string | null): ThreadMeta | undefined {
  return threadId ? view.state?.threads.find((t) => t.id === threadId) : undefined;
}
