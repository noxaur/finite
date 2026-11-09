import {
  type Agents,
  type DesignEntry,
  Refused,
  type ServerMessage,
  type Store,
} from "@finite/protocol";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import WebSocket from "ws";
import { createAgents } from "./agent/index.ts";
import { type RunningServer, startServer } from "./app.ts";
import { allowedHosts } from "./guard.ts";
import { handlers } from "./handlers.ts";
import type { Handlers } from "./hub.ts";
import { createPreviews } from "./preview/index.ts";
import { createSourceEditor } from "./source/index.ts";
import { createStore } from "./store/index.ts";

const designs: DesignEntry[] = [
  { id: "d1", name: "Shop", root: "/tmp/shop", origin: "connected", updatedAt: 1 },
];

let running: RunningServer | undefined;
afterEach(async () => {
  await running?.close();
  running = undefined;
});

async function start(
  store: Partial<Store> = {},
  agents: Partial<Agents> = {},
  handlers?: Handlers,
) {
  const base = createStore({ dataDir: "/nonexistent" });
  const fake: Store = { ...base, designs: async () => designs, ...store };
  const previews = createPreviews({ host: "127.0.0.1" });
  const source = createSourceEditor();
  running = await startServer({
    port: 0,
    host: "127.0.0.1",
    allowedHosts: allowedHosts(undefined),
    modules: {
      store: fake,
      previews,
      source,
      agents: { ...createAgents({ store: fake, previews, source }), ...agents },
    },
    ...(handlers ? { handlers } : {}),
  });
  return running.url.replace("http", "ws") + "/api/ws";
}

function connect(url: string, origin = "http://localhost:5310") {
  const ws = new WebSocket(url, { origin });
  const inbox: ServerMessage[] = [];
  const waiting: ((m: ServerMessage) => void)[] = [];
  ws.on("message", (data) => {
    const message = JSON.parse((data as Buffer).toString("utf8")) as ServerMessage;
    const next = waiting.shift();
    if (next) next(message);
    else inbox.push(message);
  });
  const opened = new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
    ws.once("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
  });
  const next = () =>
    new Promise<ServerMessage>((resolve) => {
      const queued = inbox.shift();
      if (queued) resolve(queued);
      else waiting.push(resolve);
    });
  const request = async (message: object) => {
    ws.send(JSON.stringify(message));
    return next();
  };
  return { ws, opened, request, next };
}

describe("hub", () => {
  it("answers hello and designs.list", async () => {
    const client = connect(await start());
    await client.opened;
    expect(
      await client.request({ type: "hello", rid: "1", user: { id: "u", name: "Per" } }),
    ).toEqual({
      type: "reply",
      rid: "1",
      ok: true,
      value: { version: 1, user: { id: "u", name: "Per" }, memory: expect.any(String) },
    });
    expect(await client.request({ type: "designs.list", rid: "2" })).toEqual({
      type: "reply",
      rid: "2",
      ok: true,
      value: designs,
    });
    client.ws.close();
  });

  it("refuses a bad message with a readable reason", async () => {
    const client = connect(await start());
    await client.opened;
    await client.request({ type: "hello", rid: "1", user: { id: "u", name: "Per" } });
    expect(await client.request({ type: "design.connect", rid: "2", path: 42 })).toMatchObject({
      rid: "2",
      ok: false,
      code: "invalid",
      reason: expect.stringMatching(/^design\.connect: path: .*string/),
    });
    client.ws.close();
  });

  it("passes a module's refusal through", async () => {
    const status = async () => {
      throw new Refused("Claude Code is busy; try again.", "not-implemented");
    };
    const client = connect(await start({}, { status }));
    await client.opened;
    await client.request({ type: "hello", rid: "1", user: { id: "u", name: "Per" } });
    expect(await client.request({ type: "claude.status", rid: "2" })).toEqual({
      type: "reply",
      rid: "2",
      ok: false,
      reason: "Claude Code is busy; try again.",
      code: "not-implemented",
    });
    client.ws.close();
  });

  it("starts a setup thread on a folder Finite can't run, saying why", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "finite-app-setup-"));
    const project = path.join(dir, "shop");
    await fs.mkdir(project);
    await fs.writeFile(path.join(project, "package.json"), '{ "name": "shop" }');
    const store = createStore({ dataDir: path.join(dir, "data") });
    const send = vi.fn(async () => {});
    try {
      const client = connect(await start(store, { send }));
      await client.opened;
      await client.request({ type: "hello", rid: "1", user: { id: "u", name: "Per" } });
      let reply = await client.request({ type: "design.connect", rid: "2", path: project });
      while (reply.type !== "reply") reply = await client.next();
      const design = (reply as { value: DesignEntry }).value;
      expect(design).toMatchObject({ root: project, workspace: project, setup: true });
      let setup = await client.request({ type: "design.setup", rid: "3", designId: design.id });
      // The design list's broadcast may come first.
      while (setup.type !== "reply") setup = await client.next();
      expect(setup).toMatchObject({ ok: true, value: { threadId: expect.any(String) } });
      expect(send).toHaveBeenCalledOnce();
      const [, threadId, turn] = send.mock.calls[0] as unknown as [
        unknown,
        string,
        { text: string },
      ];
      expect(turn.text).toMatch(/^Set up shop for Finite/);
      expect(turn.text).toContain("doesn't use Vite");
      expect((setup as { value: { threadId: string } }).value.threadId).toBe(threadId);
      client.ws.close();
    } finally {
      await store.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("broadcasts design list changes to every client", async () => {
    let emit: ((list: DesignEntry[]) => void) | undefined;
    const client = connect(await start({ on: (fn) => ((emit = fn), () => {}) }));
    await client.opened;
    await client.request({ type: "hello", rid: "1", user: { id: "u", name: "Per" } });
    emit?.(designs);
    expect(await client.next()).toEqual({ type: "designs", list: designs });
    client.ws.close();
  });

  describe("a request sent once", () => {
    const hello = { type: "hello", rid: "h", user: { id: "u", name: "Per" } };
    const set = { type: "settings.set", rid: "page-1", once: true, settings: {} };

    /** A server whose `settings.set` counts its runs and finishes when `finish` is called. */
    async function counting() {
      let runs = 0;
      let finish = () => {};
      const url = await start(
        {},
        {},
        {
          ...handlers,
          "settings.set": async () => {
            runs++;
            await new Promise<void>((resolve) => (finish = resolve));
            return { model: `run ${runs}` } as never;
          },
        },
      );
      return { url, runs: () => runs, finish: () => finish() };
    }

    async function greeted(url: string) {
      const client = connect(url);
      await client.opened;
      await client.request(hello);
      return client;
    }

    it("gives a reconnected page the stored reply without running it again", async () => {
      const { url, runs, finish } = await counting();
      const first = await greeted(url);
      const answer = first.request(set);
      await vi.waitFor(() => expect(runs()).toBe(1));
      finish();
      const reply = await answer;
      first.ws.close();

      const second = await greeted(url);
      expect(await second.request(set)).toEqual(reply);
      expect(runs()).toBe(1);
      second.ws.close();
    });

    it("runs it once and answers the new socket when it's still running", async () => {
      const { url, runs, finish } = await counting();
      const first = await greeted(url);
      first.ws.send(JSON.stringify(set));
      await vi.waitFor(() => expect(runs()).toBe(1));
      first.ws.close();

      const second = await greeted(url);
      expect(await second.request(set)).toEqual({ type: "running", rid: "page-1" });
      finish();
      expect(await second.next()).toMatchObject({ type: "reply", rid: "page-1", ok: true });
      expect(runs()).toBe(1);
      second.ws.close();
    });

    it("runs a request again when it doesn't ask to be remembered", async () => {
      const { url, runs, finish } = await counting();
      const client = await greeted(url);
      const { once: _once, ...plain } = set;
      const first = client.request(plain);
      await vi.waitFor(() => expect(runs()).toBe(1));
      finish();
      await first;
      const second = client.request(plain);
      await vi.waitFor(() => expect(runs()).toBe(2));
      finish();
      await second;
      client.ws.close();
    });
  });

  it("refuses a socket from another site", async () => {
    const client = connect(await start(), "https://evil.example");
    await expect(client.opened).rejects.toThrow("HTTP 403");
  });
});
