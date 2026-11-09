import {
  type Actor,
  type ClientMessage,
  type OpenDesign,
  type Params,
  parseClientMessage,
  type Previews,
  Refused,
  type Reply,
  type RequestType,
  type Result,
  type ServerEvent,
  type ServerMessage,
  type SourceEditor,
  type Store,
  type Unsubscribe,
  type User,
  type Agents,
} from "@finite/protocol";
import type { WebSocket } from "ws";
import { handlers } from "./handlers.ts";
import { syncRoutes } from "./store/routes.ts";

export type Modules = {
  store: Store;
  previews: Previews;
  source: SourceEditor;
  agents: Agents;
};

/** One open socket. */
export type Client = {
  readonly id: number;
  user: User | undefined;
  readonly subscriptions: Set<string>;
  send(message: ServerMessage): void;
};

export type Context = {
  client: Client;
  /** The person behind the socket. */
  by: Actor;
  hub: Hub;
  modules: Modules;
};

export type Handlers = {
  [K in RequestType]: (params: Params<K>, ctx: Context) => Promise<Result<K>>;
};

export type Hub = {
  /** Serves one socket until it closes. */
  connect(socket: WebSocket): void;
  /** Sends to every client subscribed to the design. */
  broadcast(designId: string, message: ServerEvent): void;
  /** Sends to every client that said hello. */
  broadcastAll(message: ServerEvent): void;
  /** Drops the client's subscription; the design's preview idles when nobody else watches it. */
  unsubscribe(client: Client, designId: string): void;
  /** Starts the preview's idle grace period, unless a client is subscribed to the design. */
  release(designId: string): void;
  /** The design, opened once and kept; its changes are broadcast to its subscribers. */
  open(designId: string): Promise<OpenDesign>;
  close(): Promise<void>;
};

const HEARTBEAT_MS = 30_000;

export function createHub(modules: Modules, handle: Handlers = handlers): Hub {
  const clients = new Set<Client>();
  const opened = new Map<string, Promise<OpenDesign>>();
  const detach: Unsubscribe[] = [];
  /** Stops passing one open design's changes to its subscribers. */
  const perDesign = new Map<string, Unsubscribe>();
  let nextId = 1;

  const hub: Hub = {
    connect(socket) {
      const client: Client = {
        id: nextId++,
        user: undefined,
        subscriptions: new Set(),
        send(message) {
          if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
        },
      };
      clients.add(client);

      let alive = true;
      socket.on("pong", () => (alive = true));
      const heartbeat = setInterval(() => {
        if (!alive) return socket.terminate();
        alive = false;
        socket.ping();
      }, HEARTBEAT_MS);

      socket.on("message", (data, isBinary) => {
        if (isBinary) return client.send(refusal(undefined, "send JSON text frames"));
        void receive(client, (data as Buffer).toString("utf8"));
      });
      socket.on("close", () => {
        clearInterval(heartbeat);
        for (const designId of client.subscriptions) hub.unsubscribe(client, designId);
        clients.delete(client);
      });
    },

    broadcast(designId, message) {
      for (const client of clients) {
        if (client.subscriptions.has(designId)) client.send(message);
      }
    },

    unsubscribe(client, designId) {
      if (client.subscriptions.delete(designId)) hub.release(designId);
    },

    release(designId) {
      for (const client of clients) if (client.subscriptions.has(designId)) return;
      modules.previews.idle(designId);
    },

    broadcastAll(message) {
      for (const client of clients) if (client.user) client.send(message);
    },

    open(designId) {
      let pending = opened.get(designId);
      if (!pending) {
        pending = modules.store.open(designId).then((design) => {
          const offs = [
            design.on((change) => hub.broadcast(designId, { ...change, designId })),
            modules.previews.on(designId, (event) => {
              hub.broadcast(designId, { ...event, designId });
              if (event.type === "routes") {
                syncRoutes(design, event.routes).catch((error: unknown) =>
                  console.error(`updating the Routes page of ${designId} failed:`, error),
                );
              }
            }),
          ];
          perDesign.set(designId, () => offs.forEach((off) => off()));
          return design;
        });
        pending.catch(() => opened.delete(designId));
        opened.set(designId, pending);
      }
      return pending;
    },

    async close() {
      for (const off of detach.splice(0)) off();
      for (const off of perDesign.values()) off();
      perDesign.clear();
      await Promise.all([modules.agents.close(), modules.previews.close()]);
    },
  };

  detach.push(
    modules.store.on((list) => {
      // A removed design is forgotten, so opening it again asks the store (which refuses).
      const ids = new Set(list.map((d) => d.id));
      for (const id of opened.keys()) {
        if (ids.has(id)) continue;
        opened.delete(id);
        perDesign.get(id)?.();
        perDesign.delete(id);
      }
      hub.broadcastAll({ type: "designs", list });
    }),
  );

  async function receive(client: Client, data: string) {
    const parsed = parseClientMessage(data);
    if (!parsed.ok) return client.send(refusal(parsed.rid, parsed.reason, "invalid"));
    const message = parsed.message;
    if (message.type !== "hello" && !client.user) {
      return client.send(refusal(message.rid, "send hello first", "invalid"));
    }
    try {
      const value = await dispatch(client, message);
      client.send({ type: "reply", rid: message.rid, ok: true, value: value ?? null });
    } catch (error) {
      if (error instanceof Refused) {
        return client.send(refusal(message.rid, error.message, error.code));
      }
      console.error(`${message.type} failed:`, error);
      const reason = error instanceof Error ? error.message : String(error);
      client.send(refusal(message.rid, `${message.type} failed: ${reason}`));
    }
  }

  function dispatch(client: Client, message: ClientMessage): Promise<unknown> {
    const { type, rid: _rid, ...params } = message;
    const user = client.user ?? (message.type === "hello" ? message.user : undefined);
    const by: Actor = { kind: "person", id: user?.id ?? "anonymous", name: user?.name ?? "" };
    const run = handle[type] as (params: unknown, ctx: Context) => Promise<unknown>;
    return run(params, { client, by, hub, modules });
  }

  return hub;
}

function refusal(rid: string | undefined, reason: string, code?: Refused["code"]): Reply {
  return {
    type: "reply",
    rid: rid ?? "",
    ok: false,
    reason,
    ...(code === undefined ? {} : { code }),
  };
}
