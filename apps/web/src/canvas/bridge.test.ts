import { BRIDGE_CONNECT, BRIDGE_HELLO, type FrameBridge } from "@finite/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

class FakePort {
  onmessage: ((m: { data: unknown }) => void) | null = null;
  posted: Array<{ type: string; id: number }> = [];
  closed = false;
  postMessage(message: { type: string; id: number }) {
    this.posted.push(message);
  }
  close() {
    this.closed = true;
  }
  /** The document on the other end says it's unloading. */
  leaving() {
    this.onmessage?.({ data: { type: "leaving" } });
  }
  answer(id: number, value: unknown) {
    this.onmessage?.({ data: { type: "reply", id, ok: true, value } });
  }
}

/** A real `connectFrame` on a stand-in iframe, with a stand-in for each channel it opens. */
async function frame() {
  const win = { postMessage: vi.fn() };
  const iframe = Object.assign(new EventTarget(), { contentWindow: win });
  const channels: FakePort[] = [];
  vi.stubGlobal(
    "MessageChannel",
    class {
      port1 = new FakePort();
      port2 = {};
      constructor() {
        channels.push(this.port1);
      }
    },
  );
  const { connectFrame } = await import("./bridge");
  const bridge: FrameBridge = connectFrame(iframe as unknown as HTMLIFrameElement, "f1");
  const hello = () =>
    window.dispatchEvent(
      Object.assign(new Event("message"), { source: win, data: { type: BRIDGE_HELLO } }),
    );
  const load = () => iframe.dispatchEvent(new Event("load"));
  return { bridge, channels, hello, load, win };
}

const settled = async (promise: Promise<unknown>) => {
  const outcome = await Promise.race([
    promise.then(
      (value) => ({ value }),
      (error: Error) => ({ error: error.message }),
    ),
    new Promise((resolve) => setTimeout(() => resolve("pending"), 0)),
  ]);
  return outcome;
};

describe("connectFrame", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal("window", new EventTarget());
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("connects a hello and answers a request made before it", async () => {
    const { bridge, channels, hello, win } = await frame();
    const asked = bridge.hit(1, 2);
    hello();
    expect(win.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: BRIDGE_CONNECT, frameId: "f1" }),
      "*",
      expect.anything(),
    );
    channels[0].answer(channels[0].posted[0].id, null);
    await expect(asked).resolves.toBeNull();
  });

  it("rejects a request still waiting for a hello when the bridge closes", async () => {
    const { bridge } = await frame();
    const asked = bridge.hit(1, 2);
    bridge.close();
    expect(await settled(asked)).toEqual({ error: "The frame is gone" });
  });

  it("times out a request whose hello never comes, and doesn't post it later", async () => {
    vi.useFakeTimers();
    const { bridge, channels, hello } = await frame();
    const asked = bridge.hit(1, 2).catch((error: Error) => error.message);
    await vi.advanceTimersByTimeAsync(5000);
    await expect(asked).resolves.toBe("The frame didn't answer");
    hello();
    expect(channels[0].posted).toEqual([]);
  });

  it("keeps a waiting request through the hello that connects it", async () => {
    vi.useFakeTimers();
    const { bridge, channels, hello } = await frame();
    const asked = bridge.hit(1, 2);
    await vi.advanceTimersByTimeAsync(1000);
    hello();
    channels[0].answer(channels[0].posted[0].id, null);
    await expect(asked).resolves.toBeNull();
  });

  describe("when the document goes away", () => {
    it("holds a new request for the next document's hello", async () => {
      const { bridge, channels, hello, load } = await frame();
      hello();
      load();
      channels[0].leaving();
      const asked = bridge.hit(1, 2);
      expect(channels[0].posted).toEqual([]);
      hello();
      expect(channels[1].posted).toHaveLength(1);
      channels[1].answer(channels[1].posted[0].id, null);
      await expect(asked).resolves.toBeNull();
    });

    it("refuses what was in flight", async () => {
      const { bridge, channels, hello } = await frame();
      hello();
      const asked = bridge.hit(1, 2);
      channels[0].leaving();
      expect(await settled(asked)).toEqual({ error: "The frame reloaded" });
    });

    it("connects a next document that said hello too early", async () => {
      const { channels, hello, load } = await frame();
      hello();
      channels[0].leaving();
      load();
      expect(channels).toHaveLength(2);
    });

    it("connects the next document's hello even if the frame left without saying so", async () => {
      const { bridge, channels, hello, load } = await frame();
      hello();
      load();
      const asked = bridge.hit(1, 2);
      hello();
      expect(channels).toHaveLength(2);
      expect(await settled(asked)).toEqual({ error: "The frame reloaded" });
    });
  });

  describe("when load connects before the document's own hello arrives", () => {
    it("keeps the channel and what's in flight on it", async () => {
      const { bridge, channels, hello, load } = await frame();
      load();
      const asked = bridge.hit(1, 2);
      hello();
      expect(channels).toHaveLength(1);
      channels[0].answer(channels[0].posted[0].id, null);
      await expect(asked).resolves.toBeNull();
    });

    it("still connects the next document's hello after that one is gone", async () => {
      const { channels, hello, load } = await frame();
      load();
      hello();
      channels[0].leaving();
      hello();
      expect(channels).toHaveLength(2);
    });

    it("connects at the next load when that hello came from a page with no bridge", async () => {
      const { bridge, channels, hello, load } = await frame();
      load();
      hello();
      load();
      expect(channels).toHaveLength(2);
      hello();
      expect(channels).toHaveLength(2);
      const asked = bridge.hit(1, 2);
      channels[1].answer(channels[1].posted[0].id, null);
      await expect(asked).resolves.toBeNull();
    });
  });
});
