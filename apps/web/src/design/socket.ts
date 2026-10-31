import { Schema } from "effect";
import { DesignMessage, LobbyMessage } from "./schema";

export type SocketStatus = "connecting" | "open" | "closed";

export interface SocketHandlers<M> {
  readonly onMessage: (message: M) => void;
  readonly onStatus?: (status: SocketStatus) => void;
}

/** Same origin as the page. In dev, the Next.js `/api` rewrite proxies WebSockets too. */
function socketUrl(path: string) {
  const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${window.location.host}${path}`;
}

/**
 * Opens a WebSocket that decodes each message with `schema` and reconnects
 * with backoff. `path` is called for each attempt, so a reconnect can say
 * where it left off. Returns a function that closes it for good.
 */
function connect<S extends Schema.Top>(
  path: () => string,
  schema: S,
  { onMessage, onStatus }: SocketHandlers<S["Type"]>,
): () => void {
  const decode = Schema.decodeUnknownSync(schema as never) as (input: unknown) => S["Type"];
  let socket: WebSocket | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;
  let closed = false;

  const open = () => {
    onStatus?.("connecting");
    socket = new WebSocket(socketUrl(path()));
    socket.onopen = () => {
      attempt = 0;
      onStatus?.("open");
    };
    socket.onmessage = (event) => {
      try {
        onMessage(decode(JSON.parse(String(event.data))));
      } catch (error) {
        console.error("Dropped a malformed socket message", error);
      }
    };
    socket.onclose = () => {
      if (closed) return;
      onStatus?.("closed");
      retry = setTimeout(open, Math.min(500 * 2 ** attempt++, 5000));
    };
  };

  open();
  return () => {
    closed = true;
    clearTimeout(retry);
    socket?.close();
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
) => connect(() => `/api/designs/${encodeURIComponent(id)}/ws${query()}`, DesignMessage, handlers);

export const connectLobby = (handlers: SocketHandlers<LobbyMessage>) =>
  connect(() => "/api/designs/ws", LobbyMessage, handlers);
