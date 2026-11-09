import http from "node:http";
import type { AddressInfo } from "node:net";
import { WS_PATH } from "@finite/protocol";
import { WebSocketServer } from "ws";
import { refuse } from "./guard.ts";
import { createHttpHandler, json } from "./http.ts";
import { createHub, type Handlers, type Hub, type Modules } from "./hub.ts";
import { createScreenshots, type Screenshots } from "./agent/screenshot.ts";
import { createMcpEndpoint, MCP_PATH } from "./mcp/index.ts";

export type ServerOptions = {
  port: number;
  host: string;
  allowedHosts: readonly string[];
  staticDir?: string | undefined;
  modules: Modules;
  handlers?: Handlers;
  /** The browser `/mcp` renders with. Whoever passes it closes it. */
  screenshots?: Screenshots;
  /** How long an unused `/mcp` session lasts. */
  mcpIdleMs?: number;
};

export type RunningServer = { url: string; hub: Hub; close(): Promise<void> };

/** Starts node:http with the hub's WebSocket on `/api/ws`, behind the host guard. */
export async function startServer(options: ServerOptions): Promise<RunningServer> {
  const hub = createHub(options.modules, options.handlers);
  const handle = createHttpHandler(hub, options.modules, options.staticDir);
  const screenshots = options.screenshots ?? createScreenshots();
  const mcp = createMcpEndpoint({
    hub,
    modules: options.modules,
    screenshots,
    ...(options.mcpIdleMs === undefined ? {} : { idleMs: options.mcpIdleMs }),
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });

  const server = http.createServer((req, res) => {
    const refused = refuse(options.allowedHosts, req.headers);
    if (refused) return json(res, 403, { reason: refused });
    if (new URL(req.url ?? "/", "http://localhost").pathname === MCP_PATH) {
      return void mcp.handle(req, res);
    }
    void handle(req, res);
  });

  server.on("upgrade", (req, socket, head) => {
    const refused = refuse(options.allowedHosts, req.headers);
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (refused || path !== WS_PATH) {
      const status = refused ? "403 Forbidden" : "404 Not Found";
      socket.end(`HTTP/1.1 ${status}\r\nconnection: close\r\n\r\n${refused ?? ""}`);
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => hub.connect(ws));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, resolve);
  });
  const { port } = server.address() as AddressInfo;
  const host = options.host.includes(":") ? `[${options.host}]` : options.host;

  return {
    url: `http://${host}:${port}`,
    hub,
    async close() {
      for (const ws of wss.clients) ws.terminate();
      await mcp.close();
      await hub.close();
      if (!options.screenshots) await screenshots.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
