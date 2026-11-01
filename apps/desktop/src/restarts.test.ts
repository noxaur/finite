import { describe, expect, it } from "vite-plus/test";
import { afterStop, MAX_STOPS, WINDOW_MS } from "./restarts.js";

describe("afterStop", () => {
  it("restarts until the server stops three times in a minute", () => {
    let stops: number[] = [];
    const results: boolean[] = [];
    for (let i = 0; i < MAX_STOPS; i++) {
      const next = afterStop(stops, i * 1_000);
      results.push(next.restart);
      stops = next.stops;
    }
    expect(results).toEqual([true, true, false]);
  });

  it("forgets stops older than the window", () => {
    const first = afterStop([], 0);
    const second = afterStop(first.stops, 1_000);
    // A minute after the first two, the third stop is the only recent one.
    const third = afterStop(second.stops, 1_000 + WINDOW_MS);
    expect(third.restart).toBe(true);
    expect(third.stops).toEqual([1_000 + WINDOW_MS]);
  });
});
