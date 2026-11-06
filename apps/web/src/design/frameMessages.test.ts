import { describe, expect, it } from "vite-plus/test";
import { decodeFrameMessage, decodeHello } from "./frameMessages";

describe("decodeFrameMessage", () => {
  it("keeps well-formed messages", () => {
    expect(decodeFrameMessage({ type: "goto", href: "#finite-artboard=b" })).toEqual({
      type: "goto",
      href: "#finite-artboard=b",
    });
    expect(decodeFrameMessage({ type: "key", key: "ArrowLeft", phase: "up", meta: true })).toEqual({
      type: "key",
      key: "ArrowLeft",
      phase: "up",
      meta: true,
      repeat: false,
    });
    expect(decodeFrameMessage({ type: "pan", extra: 1 })).toEqual({ type: "pan" });
  });

  it("drops what the page's own scripts could post wrong", () => {
    for (const bad of [
      null,
      "goto",
      { type: "nope" },
      { type: "goto", href: 1 },
      { type: "network", host: "x".repeat(254) },
      { type: "rect" },
      { type: "storage", set: [["k", 1]] },
      { type: "storage", set: [[1, "v"]] },
    ]) {
      expect(decodeFrameMessage(bad)).toBeNull();
    }
  });

  it("reads numbers that aren't finite as 0 and sizes that aren't boxes as null", () => {
    expect(decodeFrameMessage({ type: "size", width: Infinity, height: "9" })).toEqual({
      type: "size",
      width: 0,
      height: 0,
    });
    expect(
      decodeFrameMessage({ type: "rect", id: "a", rect: { x: 1, y: 2, width: 3, height: NaN } }),
    ).toEqual({ type: "rect", id: "a", rect: null });
    expect(
      decodeFrameMessage({
        type: "rect",
        id: "a",
        rect: { x: 1, y: 2, width: 3, height: 4, outset: { top: -5, left: 2 } },
      }),
    ).toEqual({
      type: "rect",
      id: "a",
      rect: { x: 1, y: 2, width: 3, height: 4, outset: { top: 0, right: 0, bottom: 0, left: 2 } },
    });
  });
});

describe("decodeHello", () => {
  it("reads the nonce", () => {
    expect(decodeHello({ finite: { type: "hello", nonce: "n" } })).toBe("n");
    expect(decodeHello({ finite: { type: "init", nonce: "n" } })).toBeNull();
    expect(decodeHello({ finite: { type: "hello" } })).toBeNull();
    expect(decodeHello(null)).toBeNull();
  });
});
