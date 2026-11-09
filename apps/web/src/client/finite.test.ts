import { type DesignState, REPLY_KEPT_MS, type ThreadMeta } from "@finite/protocol";
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
  greet(memory = "m") {
    this.open();
    this.reply("hello", { version: 1, user: { id: "u", name: "U" }, memory });
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
    ws.reply("hello", { version: 1, user: { id: "u", name: "U" }, memory: "m" });
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

  /** An open client with one state-changing request on the wire. */
  async function sentInterrupt() {
    const f = make();
    f.request("settings.get", {}).catch(() => {});
    const ws = FakeSocket.all[0]!;
    ws.greet();
    await flush();
    const result = f.request("thread.interrupt", { designId: "d", threadId: "t1" });
    const caught = result.catch((e: unknown) => e as FiniteError);
    await flush();
    return { f, ws, result, caught, frame: ws.sent.at(-1)! };
  }

  const reconnect = async (memory = "m") => {
    await vi.advanceTimersByTimeAsync(300);
    const ws = FakeSocket.all.at(-1)!;
    ws.greet(memory);
    await flush();
    return ws;
  };

  it("asks again with the same id after a reconnect and settles with the answer", async () => {
    const { ws, result, frame } = await sentInterrupt();
    expect(frame.once).toBe(true);
    ws.close();
    const ws2 = await reconnect();
    const again = ws2.sent.find((m) => m.type === "thread.interrupt")!;
    expect(again).toEqual(frame);
    ws2.push({ type: "reply", rid: again.rid, ok: true, value: null });
    await expect(result).resolves.toBeNull();
  });

  it("gives the server's refusal after a reconnect, not a guess", async () => {
    const { ws, caught, frame } = await sentInterrupt();
    ws.close();
    const ws2 = await reconnect();
    ws2.push({ type: "reply", rid: frame.rid, ok: false, reason: "No such thread" });
    expect(((await caught) as FiniteError).message).toBe("No such thread");
  });

  it("asks again before it sends what queued while the socket was down", async () => {
    const { f, ws } = await sentInterrupt();
    ws.close();
    f.request("thread.settle", { designId: "d", threadId: "t1", settled: true }).catch(() => {});
    const ws2 = await reconnect();
    expect(ws2.sent.map((m) => m.type)).toEqual(["hello", "thread.interrupt", "thread.settle"]);
  });

  it("says the outcome is unknown, and doesn't ask again, when the server's memory changed", async () => {
    const { ws, caught } = await sentInterrupt();
    ws.close();
    const ws2 = await reconnect("after-a-restart");
    const error = (await caught) as FiniteError;
    expect(error).toBeInstanceOf(FiniteError);
    expect(error.message).toMatch(/may have gone through/);
    expect(ws2.sent.map((m) => m.type)).not.toContain("thread.interrupt");
  });

  it("still sends a request that never left when the server restarted", async () => {
    const { f, ws } = await sentInterrupt();
    ws.close();
    f.request("thread.settle", { designId: "d", threadId: "t1", settled: true }).catch(() => {});
    const ws2 = await reconnect("after-a-restart");
    expect(ws2.sent.map((m) => m.type)).toContain("thread.settle");
  });

  it("says the outcome is unknown after a disconnect longer than the server remembers", async () => {
    const { ws, caught } = await sentInterrupt();
    ws.close();
    await vi.advanceTimersByTimeAsync(REPLY_KEPT_MS);
    const ws2 = FakeSocket.all.at(-1)!;
    ws2.greet();
    await flush();
    expect(((await caught) as FiniteError).message).toMatch(/may have gone through/);
    expect(ws2.sent.map((m) => m.type)).not.toContain("thread.interrupt");
  });

  it("asks again when the reply is late, and takes the late reply", async () => {
    const { ws, result, frame } = await sentInterrupt();
    await vi.advanceTimersByTimeAsync(1500);
    expect(ws.sent.filter((m) => m.rid === frame.rid)).toHaveLength(2);
    ws.push({ type: "reply", rid: frame.rid, ok: true, value: null });
    await expect(result).resolves.toBeNull();
  });

  it("keeps waiting while the server says it's still running, up to a limit", async () => {
    const { ws, caught, frame } = await sentInterrupt();
    let settled = false;
    void caught.then(() => (settled = true));
    // Each overdue round asks; the server's `running` means the socket is fine.
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(1000);
      ws.push({ type: "running", rid: frame.rid });
    }
    expect(settled).toBe(false);
    expect(FakeSocket.all).toHaveLength(1);
    for (let waited = 0; !settled && waited < REPLY_KEPT_MS; waited += 1000) {
      await vi.advanceTimersByTimeAsync(1000);
      ws.push({ type: "running", rid: frame.rid });
    }
    expect(FakeSocket.all).toHaveLength(1);
    expect(((await caught) as FiniteError).message).toMatch(/may still have gone through/);
  });

  it("reconnects when the socket stays silent after asking again", async () => {
    const { ws, result, frame } = await sentInterrupt();
    await vi.advanceTimersByTimeAsync(2100);
    expect(ws.readyState).toBe(3);
    const ws2 = await reconnect();
    ws2.push({ type: "reply", rid: frame.rid, ok: true, value: null });
    await expect(result).resolves.toBeNull();
  });

  it("rejects a read when the socket drops, because it can simply be asked again", async () => {
    const f = make();
    f.request("settings.get", {}).catch(() => {});
    const ws = FakeSocket.all[0]!;
    ws.greet();
    await flush();
    const caught = f.request("tokens.get", { designId: "d" }).catch((e: unknown) => e);
    await flush();
    expect(ws.sent.at(-1)!.once).toBeUndefined();
    ws.close();
    const error = (await caught) as FiniteError;
    expect(error).toBeInstanceOf(FiniteError);
    expect(error.message).not.toMatch(/gone through/);
  });

  it("uses ids a later page load won't repeat", async () => {
    const rid = async () => {
      const f = make();
      void f.request("settings.get", {}).catch(() => {});
      const ws = FakeSocket.all.at(-1)!;
      ws.greet();
      await flush();
      return ws.sent.at(-1)!.rid;
    };
    expect(await rid()).not.toBe(await rid());
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
