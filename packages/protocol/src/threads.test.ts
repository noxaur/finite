import { describe, expect, it } from "vite-plus/test";
import { threadSection } from "./index.ts";

const now = 1_000;

describe("threadSection", () => {
  it("puts running threads in Working only when shown separately", () => {
    expect(threadSection({ running: true }, now, true)).toBe("working");
    expect(threadSection({ running: true }, now, false)).toBe("active");
    expect(threadSection({ running: true, snoozedUntil: now + 1 }, now, true)).toBe("working");
  });

  it("snoozes until the time passes", () => {
    expect(threadSection({ running: false, snoozedUntil: now + 1 }, now, true)).toBe("snoozed");
    expect(threadSection({ running: false, snoozedUntil: now }, now, true)).toBe("active");
  });

  it("settles, unless still snoozed", () => {
    expect(threadSection({ running: false, settledAt: 5 }, now, false)).toBe("settled");
    expect(threadSection({ running: false, settledAt: 5, snoozedUntil: now + 1 }, now, false)).toBe(
      "snoozed",
    );
  });

  it("defaults to Active", () => {
    expect(threadSection({ running: false }, now, false)).toBe("active");
  });
});
