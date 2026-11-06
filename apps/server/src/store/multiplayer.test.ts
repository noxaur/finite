import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Agents, Previews, ServerMessage, SourceEditor } from "@finite/protocol";
import { afterEach, describe, expect, it } from "vite-plus/test";
import WebSocket from "ws";
import { type RunningServer, startServer } from "../app.ts";
import { allowedHosts } from "../guard.ts";
import { createStore } from "./index.ts";

const previews: Previews = {
  ensure: async () => ({ url: "http://127.0.0.1:1" }),
  state: () => ({ status: "stopped" }),
  routes: async () => [],
  frameUrl: () => "",
  stop: async () => {},
  on: () => () => {},
  reportError: () => {},
  errors: () => [],
  close: async () => {},
};
const agents = { close: async () => {} } as unknown as Agents;
const source = {} as SourceEditor;

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function tempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "finite-mp-"));
  cleanup.push(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

/** A socket that sends requests and collects what the server pushes. */
async function client(url: string, name: string) {
  const ws = new WebSocket(url, { origin: "http://localhost:5310" });
  cleanup.push(async () => ws.close());
  const events: ServerMessage[] = [];
  const replies = new Map<string, (m: ServerMessage & { type: "reply" }) => void>();
  const waiters: (() => void)[] = [];
  ws.on("message", (data) => {
    const message = JSON.parse((data as Buffer).toString("utf8")) as ServerMessage;
    if (message.type === "reply") replies.get(message.rid)?.(message);
    else events.push(message);
    for (const wake of waiters.splice(0)) wake();
  });
  await new Promise((resolve, reject) => ws.once("open", resolve).once("error", reject));
  let rid = 0;
  const request = (type: string, params: object = {}) =>
    new Promise<unknown>((resolve, reject) => {
      const id = String(++rid);
      replies.set(id, (m) => (m.ok ? resolve(m.value) : reject(new Error(m.reason))));
      ws.send(JSON.stringify({ type, rid: id, ...params }));
    });
  const event = async (match: (m: ServerMessage) => boolean) => {
    for (;;) {
      const found = events.find(match);
      if (found) return found;
      await new Promise<void>((wake) => waiters.push(wake));
    }
  };
  await request("hello", { user: { id: name, name } });
  return { request, event, events };
}

describe("two people on one design", () => {
  it("see each other's canvas patches and comments", async () => {
    const store = createStore({ dataDir: await tempDir() });
    cleanup.push(() => store.close());
    const root = await tempDir();
    await fs.writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ name: "shop", dependencies: { vite: "^8", "react-router": "^8" } }),
    );
    const running: RunningServer = await startServer({
      port: 0,
      host: "127.0.0.1",
      allowedHosts: allowedHosts(undefined),
      modules: { store, previews, source, agents },
    });
    cleanup.push(() => running.close());
    const url = running.url.replace("http", "ws") + "/api/ws";

    const ana = await client(url, "ana");
    const bo = await client(url, "bo");
    const entry = (await ana.request("design.connect", { path: root })) as { id: string };
    await bo.event((m) => m.type === "designs" && m.list.some((d) => d.id === entry.id));

    const state = (await ana.request("subscribe", { designId: entry.id })) as {
      canvases: { id: string; name: string }[];
    };
    await bo.request("subscribe", { designId: entry.id });
    const routes = state.canvases.find((c) => c.name === "Routes")!;

    const frame = {
      id: "f1",
      name: "Home",
      x: 0,
      y: 0,
      width: 1440,
      height: 900,
      source: { kind: "route", path: "/" },
    };
    await ana.request("canvas.patch", {
      designId: entry.id,
      canvasId: routes.id,
      patch: { op: "addFrames", frames: [frame] },
    });
    expect(
      await bo.event((m) => m.type === "canvas" && m.canvas.frames.some((f) => f.id === "f1")),
    ).toMatchObject({ designId: entry.id, canvas: { id: routes.id, frames: [frame] } });

    await bo.request("canvas.patch", {
      designId: entry.id,
      canvasId: routes.id,
      patch: { op: "moveFrames", frames: [{ id: "f1", x: 400, y: 80 }] },
    });
    await ana.event(
      (m) => m.type === "canvas" && m.canvas.frames.some((f) => f.id === "f1" && f.x === 400),
    );

    await bo.request("comment.add", {
      designId: entry.id,
      canvasId: routes.id,
      anchor: { frameId: "f1" },
      text: "Tighter headline?",
    });
    const commented = await ana.event((m) => m.type === "canvas" && m.canvas.comments.length === 1);
    expect(commented).toMatchObject({
      canvas: { comments: [{ text: "Tighter headline?", author: { id: "bo" } }] },
    });
  });
});
