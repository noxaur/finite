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

const userEvent = (text: string, at: number) => ({
  type: "user" as const,
  text,
  attachments: [] as string[],
  by: { kind: "person" as const, id: "u", name: "U" },
  at,
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

  it("doesn't call a request failed when the socket drops after sending it", async () => {
    const f = make();
    f.request("settings.get", {}).catch(() => {});
    const ws = FakeSocket.all[0]!;
    ws.greet();
    await flush();
    const caught = f
      .request("thread.interrupt", { designId: "d", threadId: "t1" })
      .catch((e: unknown) => e);
    await flush();
    expect(ws.sent.at(-1)!.type).toBe("thread.interrupt");
    ws.close();
    const error = (await caught) as FiniteError;
    expect(error).toBeInstanceOf(FiniteError);
    expect(error.message).toMatch(/may have gone through/);
    expect(error.message).not.toMatch(/Try again/);
  });

  it("doesn't call a request failed when its reply comes after the timeout", async () => {
    const f = make();
    f.request("settings.get", {}).catch(() => {});
    const ws = FakeSocket.all[0]!;
    ws.greet();
    await flush();
    const caught = f
      .request("thread.interrupt", { designId: "d", threadId: "t1" })
      .catch((e: unknown) => e);
    await flush();
    await vi.advanceTimersByTimeAsync(1500);
    const error = (await caught) as FiniteError;
    expect(error.message).toMatch(/may still have gone through/);
    expect(error.message).not.toMatch(/Try again/);
    ws.reply("thread.interrupt", {});
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
    const page = (id: string, createdAt: number) => ({
      id,
      kind: "page" as const,
      name: id,
      threadIds: [],
      frames: [],
      texts: [],
      comments: [],
      createdAt,
      updatedAt: createdAt,
    });
    ws.push({ type: "canvas", designId: "d", canvas: page("newer", 2) });
    ws.push({ type: "canvas", designId: "d", canvas: page("older", 1) });
    expect(f.design("d").state?.canvases.map((c) => c.id)).toEqual(["older", "newer"]);

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

  it("fetches a design again when setup turned it into an app, but not when it moved on", async () => {
    const f = make();
    f.holdDesign("d");
    const ws = FakeSocket.all[0]!;
    ws.greet();
    await flush();
    ws.reply("subscribe", state());
    await flush();
    const subscribes = () => ws.sent.filter((m) => m.type === "subscribe").length;
    const before = subscribes();
    ws.push({ type: "setup.done", designId: "d", next: "web" });
    expect(subscribes()).toBe(before);
    ws.push({ type: "setup.done", designId: "d", next: "d" });
    await flush();
    expect(subscribes()).toBe(before + 1);
    ws.reply("subscribe", { ...state(), design: { ...state().design, app: "shop" } });
    await flush();
    expect(f.design("d").state?.design.app).toBe("shop");
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

  it("grows the retry delay when the socket drops before hello", async () => {
    const f = make();
    f.request("settings.get", {}).catch(() => {});
    const ws = FakeSocket.all[0]!;
    ws.open();
    ws.close();
    await vi.advanceTimersByTimeAsync(250);
    expect(FakeSocket.all).toHaveLength(2);
    const ws2 = FakeSocket.all[1]!;
    ws2.open();
    ws2.close();
    await vi.advanceTimersByTimeAsync(250);
    expect(FakeSocket.all).toHaveLength(2);
    expect(f.status()).toBe("closed");
    await vi.advanceTimersByTimeAsync(250);
    expect(FakeSocket.all).toHaveLength(3);
  });

  it("starts the backoff over once hello is accepted", async () => {
    const f = make();
    f.request("settings.get", {}).catch(() => {});
    const ws = FakeSocket.all[0]!;
    ws.open();
    ws.close();
    await vi.advanceTimersByTimeAsync(250);
    const ws2 = FakeSocket.all[1]!;
    ws2.greet();
    await flush();
    ws2.close();
    await vi.advanceTimersByTimeAsync(250);
    expect(FakeSocket.all).toHaveLength(3);
    expect(f.status()).toBe("connecting");
  });

  it("unsubscribes a design released while its subscribe waited", async () => {
    const f = make();
    const release = f.holdDesign("d");
    const ws = FakeSocket.all[0]!;
    release();
    await vi.advanceTimersByTimeAsync(20);
    expect(ws.sent.map((m) => m.type)).not.toContain("unsubscribe");
    ws.greet();
    await flush();
    expect(ws.sent.map((m) => m.type)).toContain("subscribe");
    ws.reply("subscribe", state());
    await flush();
    expect(ws.sent.map((m) => m.type)).toContain("unsubscribe");
    expect(f.design("d").state).toBeNull();
  });

  it("drops partial text when history brings the finished turn", async () => {
    const f = make();
    f.holdThread("d", "t1");
    const ws = FakeSocket.all[0]!;
    ws.greet();
    await flush();
    const user = userEvent("hi", 1);
    ws.reply("thread.history", [user]);
    await flush();
    ws.push({
      type: "thread.event",
      designId: "d",
      threadId: "t1",
      event: { type: "text.delta", text: "Hel" },
    });
    expect(f.thread("t1").streaming).toBe("Hel");

    ws.close();
    await vi.advanceTimersByTimeAsync(300);
    const ws2 = FakeSocket.all[1]!;
    ws2.greet();
    await flush();
    ws2.reply("thread.history", [user, { type: "text", text: "Hello", at: 2 }]);
    await flush();
    expect(f.thread("t1").streaming).toBe("");
    expect(f.thread("t1").events).toEqual([user, { type: "text", text: "Hello", at: 2 }]);
  });

  it("keeps a partial when the turn it belongs to is still running", async () => {
    const f = make();
    f.holdThread("d", "t1");
    const ws = FakeSocket.all[0]!;
    ws.greet();
    await flush();
    const older = userEvent("old", 1);
    const now = userEvent("now", 3);
    ws.push({
      type: "thread.event",
      designId: "d",
      threadId: "t1",
      event: { type: "text.delta", text: "Hel" },
    });
    ws.reply("thread.history", [older, { type: "text", text: "Done", at: 2 }, now]);
    await flush();
    expect(f.thread("t1").streaming).toBe("Hel");
    expect(f.thread("t1").loaded).toBe(true);
  });

  it("keeps streaming that started after the finished text already on screen", async () => {
    const f = make();
    f.holdThread("d", "t1");
    const ws = FakeSocket.all[0]!;
    ws.greet();
    await flush();
    const user = userEvent("hi", 1);
    const text = { type: "text" as const, text: "Hello", at: 2 };
    ws.reply("thread.history", [user, text]);
    await flush();
    ws.push({
      type: "thread.event",
      designId: "d",
      threadId: "t1",
      event: { type: "text.delta", text: "More" },
    });
    expect(f.thread("t1").streaming).toBe("More");

    ws.close();
    await vi.advanceTimersByTimeAsync(300);
    const ws2 = FakeSocket.all[1]!;
    ws2.greet();
    await flush();
    ws2.reply("thread.history", [user, text]);
    await flush();
    expect(f.thread("t1").streaming).toBe("More");
  });

  it("leaves a thread unloaded when its history never arrives", async () => {
    const f = make();
    f.holdThread("d", "t1");
    const ws = FakeSocket.all[0]!;
    ws.greet();
    await flush();
    expect(ws.sent.some((m) => m.type === "thread.history")).toBe(true);
    ws.close();
    await flush();
    expect(f.thread("t1").loaded).toBe(false);
    expect(f.thread("t1").events).toEqual([]);

    await vi.advanceTimersByTimeAsync(300);
    const ws2 = FakeSocket.all[1]!;
    ws2.greet();
    await flush();
    const user = userEvent("hi", 1);
    ws2.reply("thread.history", [user]);
    await flush();
    expect(f.thread("t1").loaded).toBe(true);
    expect(f.thread("t1").events).toEqual([user]);
  });

  it("leaves a thread unloaded when history is refused", async () => {
    const f = make();
    f.holdThread("d", "t1");
    const ws = FakeSocket.all[0]!;
    ws.greet();
    await flush();
    const hist = [...ws.sent].reverse().find((m) => m.type === "thread.history")!;
    ws.push({ type: "reply", rid: hist.rid, ok: false, reason: "No such thread" });
    await flush();
    expect(f.thread("t1").loaded).toBe(false);
    expect(f.thread("t1").events).toEqual([]);
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
