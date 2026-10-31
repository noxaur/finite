import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { LobbyMessage } from "./schema";
import { ANSWER_WITHIN, connect, PING, PING_EVERY, PONG, type SocketLike } from "./socket";

class FakeSocket implements SocketLike {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  sent: string[] = [];
  closed = false;
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
  }
}

const designs = JSON.stringify({ type: "designs", designs: [], total: 0 });

describe("socket heartbeat", () => {
  let sockets: FakeSocket[];
  let statuses: string[];
  let messages: unknown[];
  let stop: () => void;

  beforeEach(() => {
    vi.useFakeTimers();
    sockets = [];
    statuses = [];
    messages = [];
    stop = connect(
      () => "ws://test/api/designs/ws",
      LobbyMessage,
      { onMessage: (m) => messages.push(m), onStatus: (s) => statuses.push(s) },
      () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    );
    sockets[0]!.onopen?.();
  });

  afterEach(() => {
    stop();
    vi.useRealTimers();
  });

  it("pings, and stays connected while the server answers", () => {
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(PING_EVERY);
      sockets[0]!.onmessage?.({ data: PONG });
    }
    expect(sockets[0]!.sent).toEqual(Array(5).fill(PING));
    expect(sockets).toHaveLength(1);
    expect(statuses).toEqual(["connecting", "open"]);
    // Pongs aren't passed on as messages.
    expect(messages).toEqual([]);
  });

  it("counts any message as an answer", () => {
    vi.advanceTimersByTime(PING_EVERY);
    sockets[0]!.onmessage?.({ data: designs });
    vi.advanceTimersByTime(ANSWER_WITHIN);
    expect(sockets).toHaveLength(1);
    expect(messages).toHaveLength(1);
  });

  it("reconnects when a ping goes unanswered, without waiting for close", () => {
    vi.advanceTimersByTime(PING_EVERY + ANSWER_WITHIN);
    expect(sockets[0]!.closed).toBe(true);
    expect(statuses.at(-1)).toBe("closed");
    // The dead socket can't reach the page anymore.
    expect(sockets[0]!.onmessage).toBeNull();

    vi.advanceTimersByTime(500);
    expect(sockets).toHaveLength(2);
    sockets[1]!.onopen?.();
    expect(statuses.at(-1)).toBe("open");
    // The old socket's ping stopped with it.
    vi.advanceTimersByTime(PING_EVERY);
    expect(sockets[0]!.sent).toEqual([PING]);
    expect(sockets[1]!.sent).toEqual([PING]);
  });
});
