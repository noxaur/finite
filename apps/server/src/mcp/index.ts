import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { Actor } from "@finite/protocol";
import type { Screenshots } from "../agent/screenshot.ts";
import type { Hub, Modules } from "../hub.ts";
import { json } from "../http.ts";
import { finiteMcpServer } from "./tools.ts";

export const MCP_PATH = "/mcp";

const IDLE_MS = 60 * 60 * 1000;
const SWEEP_MS = 60 * 1000;
const MAX_BODY_BYTES = 16 * 1024 * 1024;

type Session = { transport: StreamableHTTPServerTransport; lastSeen: number };

export type McpEndpointOptions = {
  hub: Hub;
  modules: Modules;
  screenshots: Screenshots;
  idleMs?: number;
};

/** Streamable HTTP at `/mcp`: one transport and MCP server per session. */
export function createMcpEndpoint(options: McpEndpointOptions) {
  const sessions = new Map<string, Session>();
  const idleMs = options.idleMs ?? IDLE_MS;

  const sweep = setInterval(
    () => {
      const cutoff = Date.now() - idleMs;
      for (const session of sessions.values()) {
        if (session.lastSeen < cutoff) void session.transport.close();
      }
    },
    Math.min(idleMs, SWEEP_MS),
  );
  sweep.unref();

  async function begin(req: IncomingMessage, res: ServerResponse, body: unknown) {
    const header = req.headers["x-finite-agent"];
    const agent = typeof header === "string" && header.trim() ? header.trim() : undefined;
    const session: Session = {
      lastSeen: Date.now(),
      transport: new StreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        onsessioninitialized: (id) => void sessions.set(id, session),
      }),
    };
    const { transport } = session;
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };
    const actor = (): Actor => ({
      kind: "agent",
      id: `mcp-${agent ?? transport.sessionId}`,
      name: agent ?? server.server.getClientVersion()?.name ?? "External agent",
    });
    const server = finiteMcpServer({ ...options, actor });
    // The SDK's own transport misses its Transport type under exactOptionalPropertyTypes.
    await server.connect(transport as Transport);
    await transport.handleRequest(req, res, body);
  }

  async function serve(req: IncomingMessage, res: ServerResponse) {
    if (req.method !== "POST" && req.method !== "GET" && req.method !== "DELETE") {
      res.setHeader("allow", "GET, POST, DELETE");
      return rpcError(res, 405, "/mcp takes POST, GET and DELETE.");
    }
    const body = req.method === "POST" ? await readJson(req, res) : undefined;
    if (body === NOT_READ) return;

    const id = req.headers["mcp-session-id"];
    if (typeof id === "string") {
      const session = sessions.get(id);
      if (!session) {
        return rpcError(res, 404, "That MCP session is gone. Initialize a new one.");
      }
      session.lastSeen = Date.now();
      return session.transport.handleRequest(req, res, body);
    }
    if (req.method === "POST" && initializes(body)) return begin(req, res, body);
    rpcError(res, 400, "Send an initialize request first, or pass your mcp-session-id.");
  }

  return {
    async handle(req: IncomingMessage, res: ServerResponse) {
      try {
        await serve(req, res);
      } catch (error) {
        console.error(`${req.method} ${MCP_PATH} failed:`, error);
        rpcError(res, 500, error instanceof Error ? error.message : String(error));
      }
    },
    async close() {
      clearInterval(sweep);
      await Promise.all([...sessions.values()].map((s) => s.transport.close()));
    },
  };
}

function initializes(body: unknown): boolean {
  return Array.isArray(body) ? body.some((m) => isInitializeRequest(m)) : isInitializeRequest(body);
}

function rpcError(res: ServerResponse, status: number, message: string) {
  json(res, status, { jsonrpc: "2.0", error: { code: -32000, message }, id: null });
}

const NOT_READ = Symbol("the request body was refused");

/** The JSON body, or `NOT_READ` after answering the request with why it can't be read. */
async function readJson(req: IncomingMessage, res: ServerResponse): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      rpcError(res, 413, `An MCP request is at most ${MAX_BODY_BYTES / 1024 / 1024} MB.`);
      return NOT_READ;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    rpcError(res, 400, "The request body isn't JSON.");
    return NOT_READ;
  }
}
