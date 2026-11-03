import { Schema } from "effect";
import { DesignMessage, LobbyMessage } from "./schema";

export type SocketStatus = "connecting" | "open" | "closed";

export interface SocketHandlers<M> {
  readonly onMessage: (message: M) => void;
  readonly onStatus?: (status: SocketStatus) => void;
  /** Called with a way to send on each connection once it opens, and with `null` once it's gone. */
  readonly onSend?: (send: ((data: string) => void) | null) => void;
}

/** Same origin as the page. In dev, the Next.js `/api` rewrite proxies WebSockets too. */
function socketUrl(path: string) {
  const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${window.location.host}${path}`;
}

/**
 * How often the socket asks the server whether the connection still works,
 * and how long it waits for any message before it gives up and reconnects.
 * The server pings too, but browsers answer those pings without telling the
 * page, so after a laptop wakes up on another network, a dead connection
 * looks like a quiet design. The server answers `PING` with `PONG`.
 */
export const PING_EVERY = 20_000;
export const ANSWER_WITHIN = 10_000;
export const PING = '{"type":"ping"}';
export const PONG = '{"type":"pong"}';

/** The part of `WebSocket` this file uses, so tests can pass a fake. */
export interface SocketLike {
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  send(data: string): void;
  close(): void;
}

/**
 * Opens a WebSocket that decodes each message with `schema` and reconnects
 * with backoff. `url` is called for each attempt, so a reconnect can say
 * where it left off. Returns a function that closes it for good.
 */
export function connect<S extends Schema.Top>(
  url: () => string,
  schema: S,
  { onMessage, onStatus, onSend }: SocketHandlers<S["Type"]>,
  open: (url: string) => SocketLike = (url) => new WebSocket(url) as unknown as SocketLike,
): () => void {
  const decode = Schema.decodeUnknownSync(schema as never) as (input: unknown) => S["Type"];
  let socket: SocketLike | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let ping: ReturnType<typeof setInterval> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;
  let closed = false;

  const stopPinging = () => {
    clearInterval(ping);
    clearTimeout(deadline);
  };

  // Drops the socket and tries again. A dead connection can take minutes to
  // fire `close`, so the old socket is detached rather than waited for.
  const lost = () => {
    stopPinging();
    if (socket) {
      socket.onopen = socket.onmessage = socket.onclose = null;
      socket.close();
      socket = undefined;
      onSend?.(null);
    }
    if (closed) return;
    onStatus?.("closed");
    retry = setTimeout(start, Math.min(500 * 2 ** attempt++, 5000));
  };

  const start = () => {
    onStatus?.("connecting");
    const current = open(url());
    socket = current;
    current.onopen = () => {
      attempt = 0;
      onStatus?.("open");
      onSend?.((data) => current.send(data));
      ping = setInterval(() => {
        current.send(PING);
        clearTimeout(deadline);
        deadline = setTimeout(lost, ANSWER_WITHIN);
      }, PING_EVERY);
    };
    current.onmessage = (event) => {
      // Any message shows the connection works.
      clearTimeout(deadline);
      if (event.data === PONG) return;
      try {
        onMessage(decode(JSON.parse(String(event.data))));
      } catch (error) {
        console.error("Dropped a malformed socket message", error);
      }
    };
    current.onclose = lost;
  };

  start();
  return () => {
    closed = true;
    clearTimeout(retry);
    lost();
  };
}

/**
 * Streams one design. The server starts each connection with a snapshot,
 * unless `query` says where the last one left off (see `DesignSession`).
 */
export const connectDesign = (
  id: string,
  handlers: SocketHandlers<DesignMessage>,
  query: () => string = () => "",
) =>
  connect(
    () => socketUrl(`/api/designs/${encodeURIComponent(id)}/ws${query()}`),
    DesignMessage,
    handlers,
  );

export const connectLobby = (handlers: SocketHandlers<LobbyMessage>) =>
  connect(() => socketUrl("/api/designs/ws"), LobbyMessage, handlers);
