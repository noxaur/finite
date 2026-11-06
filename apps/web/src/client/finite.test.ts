import type { DesignState, ThreadMeta } from "@finite/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createFinite, FiniteError, type SocketLike } from "./finite";

class FakeSocket implements SocketLike {
  static all: FakeSocket[] = [];
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  onopen: ((e: unknown) => void) | null = null;
  onclose: ((e: unknown) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close() {
    this.readyState = 3;
    this.onclose?.({});
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  push(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  reply(type: string, value: unknown) {
    const m = [...this.sent].reverse().find((s) => s.type === type);
    if (!m) throw new Error(`no ${type} sent`);
    this.push({ type: "reply", rid: m.rid, ok: true, value });
  }
  /** Opens and answers hello. */
  greet() {
    this.open();
    this.reply("hello", { version: 1, user: { id: "u", name: "U" } });
  }
}

const meta = (id: string): ThreadMeta => ({
  id,
  title: "t",
  canvasIds: [],
  running: false,
  model: "m",
  fast: false,
  queued: [],
  createdAt: 1,
  updatedAt: 1,
});

const state = (threads: ThreadMeta[] = []): DesignState => ({
  design: {
    id: "d",
    name: "D",
    root: "/r",
    origin: "blank",
    router: "react-router",
    styling: "tailwind",
    css: [],
    brandDir: "src/assets/brand",
  },
  canvases: [],
  threads,
  preview: { status: "starting" },
  routes: [],
});

const make = () =>
  createFinite({
    url: () => "ws://x/api/ws",
    WebSocket: FakeSocket,
    user: () => ({ id: "u", name: "U" }),
    timeoutMs: 1000,
    lingerMs: 10,
  });

beforeEach(() => {
  FakeSocket.all = [];
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

const flush = () => vi.advanceTimersByTimeAsync(0);

describe("finite client", () => {
  it("says hello first and holds requests until it's answered", async () => {
    const f = make();
    const result = f.request("designs.list", {});
    const ws = FakeSocket.all[0]!;
    ws.open();
    expect(ws.sent.map((m) => m.type)).toEqual(["hello"]);
    ws.reply("hello", { version: 1, user: { id: "u", name: "U" } });
    await flush();
    expect(ws.sent.map((m) => m.type)).toEqual(["hello", "designs.list"]);
    ws.reply("designs.list", []);
    await expect(result).resolves.toEqual([]);
    expect(f.status()).toBe("open");
  });

  it("rejects a refusal with its reason and code", async () => {
    const f = make();
    f.request("settings.get", {}).catch(() => {});
    const ws = FakeSocket.all[0]!;
    ws.greet();
    await flush();
    const p = f.request("design.connect", { path: "/nope" });
    await flush();
    const m = ws.sent.at(-1)!;
    ws.push({
      type: "reply",
      rid: m.rid,
      ok: false,
      reason: "No package.json",
      code: "unsupported-project",
    });
    const error = await p.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FiniteError);
    expect((error as FiniteError).message).toBe("No package.json");
    expect((error as FiniteError).code).toBe("unsupported-project");
  });

  it("times out a request that gets no reply", async () => {
    const f = make();
    const p = f.request("settings.get", {});
    FakeSocket.all[0]!.greet();
    const caught = p.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1500);
    expect(await caught).toBeInstanceOf(FiniteError);
  });

  it("applies design events and resubscribes after a reconnect", async () => {
    const f = make();
    const release = f.holdDesign("d");
    const ws = FakeSocket.all[0]!;
    ws.greet();
    await flush();
    ws.reply("subscribe", state());
    await flush();
    expect(f.design("d").state?.threads).toEqual([]);

    ws.push({ type: "thread", designId: "d", meta: meta("t1") });
    expect(f.design("d").state?.threads.map((t) => t.id)).toEqual(["t1"]);
    ws.push({ type: "thread", designId: "d", meta: { ...meta("t1"), title: "Named" } });
    expect(f.design("d").state?.threads.map((t) => t.title)).toEqual(["Named"]);
    ws.push({ type: "preview", designId: "d", status: "ready", url: "http://p" });
    expect(f.design("d").state?.preview).toEqual({ status: "ready", url: "http://p" });
    ws.push({ type: "install", designId: "d", install: { status: "running", log: "pnpm…" } });
    expect(f.design("d").state?.install).toEqual({ status: "running", log: "pnpm…" });

    ws.close();
    expect(f.status()).toBe("closed");
    await vi.advanceTimersByTimeAsync(300);
    const ws2 = FakeSocket.all[1]!;
    ws2.greet();
    await flush();
    expect(ws2.sent.map((m) => m.type)).toContain("subscribe");
    ws2.reply("subscribe", state([meta("t2")]));
    await flush();
    expect(f.design("d").state?.threads.map((t) => t.id)).toEqual(["t2"]);

    release();
    await vi.advanceTimersByTimeAsync(20);
    expect(ws2.sent.map((m) => m.type)).toContain("unsubscribe");
    expect(f.design("d").state).toBeNull();
  });

  it("keeps design events that arrive while subscribe waits, across a reconnect too", async () => {
    const f = make();
    f.holdDesign("d");
    const ws = FakeSocket.all[0]!;
    ws.greet();
    await flush();
    // The server subscribed us, then sent an event before answering with an older snapshot.
    ws.push({ type: "thread", designId: "d", meta: meta("t1") });
    ws.reply("subscribe", state());
    await flush();
    expect(f.design("d").state?.threads.map((t) => t.id)).toEqual(["t1"]);

    ws.close();
    await vi.advanceTimersByTimeAsync(300);
    const ws2 = FakeSocket.all[1]!;
    ws2.greet();
    await flush();
    ws2.push({ type: "thread", designId: "d", meta: { ...meta("t1"), title: "Named" } });
    ws2.push({ type: "preview", designId: "d", status: "ready", url: "http://p" });
    ws2.reply("subscribe", state([meta("t1")]));
    await flush();
    expect(f.design("d").state?.threads.map((t) => t.title)).toEqual(["Named"]);
    expect(f.design("d").state?.preview).toEqual({ status: "ready", url: "http://p" });
  });

  it("merges a thread's history with live events and streams deltas", async () => {
    const f = make();
    f.holdThread("d", "t1");
    const ws = FakeSocket.all[0]!;
    ws.greet();
    await flush();
    const user = {
      type: "user",
      text: "hi",
      attachments: [],
      by: { kind: "person", id: "u", name: "U" },
      at: 1,
    };
    ws.push({ type: "thread.event", designId: "d", threadId: "t1", event: user });
    ws.reply("thread.history", [user]);
    await flush();
    expect(f.thread("t1").events).toEqual([user]);
    expect(f.thread("t1").loaded).toBe(true);
    ws.push({
      type: "thread.event",
      designId: "d",
      threadId: "t1",
      event: { type: "text.delta", text: "Hel" },
    });
    ws.push({
      type: "thread.event",
      designId: "d",
      threadId: "t1",
      event: { type: "text.delta", text: "lo" },
    });
    expect(f.thread("t1").streaming).toBe("Hello");
    ws.push({
      type: "thread.event",
      designId: "d",
      threadId: "t1",
      event: { type: "text", text: "Hello", at: 2 },
    });
    expect(f.thread("t1").streaming).toBe("");
    expect(f.thread("t1").events).toHaveLength(2);
  });

  it("calls event handlers", async () => {
    const f = make();
    const seen: string[] = [];
    f.on("settings", (e) => seen.push(e.settings.model));
    const ws = FakeSocket.all[0]!;
    ws.greet();
    ws.push({
      type: "settings",
      settings: {
        model: "opus",
        effort: "medium",
        fast: false,
        sendMode: "steer",
        showWorkingSeparately: false,
      },
    });
    expect(seen).toEqual(["opus"]);
  });
});
