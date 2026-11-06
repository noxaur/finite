import type { ThreadMeta } from "@finite/protocol";
import { describe, expect, it } from "vite-plus/test";
import { effortFor, explorePrompt, sendModeFor } from "./composer";
import { groupThreads, shortAgo, snoozeLeft, snoozeUntil, UNTIL_OPENED } from "./threads";

const NOW = new Date(2026, 10, 6, 15, 0).getTime(); // a Friday

const t = (id: string, over: Partial<ThreadMeta> = {}): ThreadMeta => ({
  id,
  title: id,
  canvasIds: [],
  running: false,
  model: "m",
  fast: false,
  queued: [],
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

const ids = (rows: ReadonlyArray<{ meta: ThreadMeta }>) => rows.map((r) => r.meta.id);

describe("groupThreads", () => {
  const threads = [
    t("old", { awaitingSince: 10 }),
    t("new", { awaitingSince: 50 }),
    t("busy", { running: true, updatedAt: 40 }),
    t("later", { snoozedUntil: NOW + 7200_000 }),
    t("soon", { snoozedUntil: NOW + 600_000 }),
    t("woke", { snoozedUntil: NOW - 1, updatedAt: 30 }),
    t("done", { settledAt: 5 }),
    t("child", { parentId: "new", settledAt: 9 }),
    t("orphan", { parentId: "gone", updatedAt: 20 }),
  ];

  it("puts each top-level thread in its section, newest first", () => {
    const g = groupThreads(threads, NOW, true);
    expect(ids(g.active)).toEqual(["new", "woke", "orphan", "old"]);
    expect(ids(g.working)).toEqual(["busy"]);
    expect(ids(g.snoozed)).toEqual(["soon", "later"]);
    expect(ids(g.settled)).toEqual(["done"]);
  });

  it("keeps running threads in Active when Working isn't shown separately", () => {
    const g = groupThreads(threads, NOW, false);
    expect(g.working).toEqual([]);
    expect(ids(g.active)).toContain("busy");
  });

  it("nests child threads under their parent", () => {
    const g = groupThreads(threads, NOW, true);
    expect(ids(g.active[0]!.children)).toEqual(["child"]);
  });

  it("filters by title and keeps the parents of matches", () => {
    const g = groupThreads(threads, NOW, true, "CHI");
    expect(ids(g.active)).toEqual(["new"]);
    expect(ids(g.active[0]!.children)).toEqual(["child"]);
    expect(g.settled).toEqual([]);
  });
});

describe("snooze", () => {
  it("ends an hour on, at 9 tomorrow, at 9 next Monday, or never", () => {
    expect(snoozeUntil("hour", NOW)).toBe(NOW + 3600_000);
    expect(new Date(snoozeUntil("tomorrow", NOW)).toString()).toContain("Sat Nov 07 2026 09:00");
    expect(new Date(snoozeUntil("week", NOW)).toString()).toContain("Mon Nov 09 2026 09:00");
    expect(snoozeUntil("opened", NOW)).toBe(UNTIL_OPENED);
  });

  it("says what's left, short", () => {
    expect(snoozeLeft(NOW + 3600_000, NOW)).toBe("60m");
    expect(snoozeLeft(NOW + 5 * 3600_000, NOW)).toBe("5h");
    expect(snoozeLeft(NOW + 3 * 86400_000, NOW)).toBe("3d");
    expect(snoozeLeft(UNTIL_OPENED, NOW)).toBe("");
    expect(shortAgo(NOW - 18 * 60_000, NOW)).toBe("18m");
  });
});

describe("composer send mode", () => {
  it("starts a turn when idle, whatever the keys", () => {
    expect(sendModeFor(false, "queue", false)).toBe("steer");
    expect(sendModeFor(false, "queue", true)).toBe("steer");
  });

  it("uses the default while running, and ⌥ the other one", () => {
    expect(sendModeFor(true, "steer", false)).toBe("steer");
    expect(sendModeFor(true, "steer", true)).toBe("queue");
    expect(sendModeFor(true, "queue", false)).toBe("queue");
    expect(sendModeFor(true, "queue", true)).toBe("steer");
  });

  it("composes the explore prompt", () => {
    expect(explorePrompt("layout", 3, "Pricing card")).toBe(
      "Explore 3 layout directions for Pricing card",
    );
    expect(explorePrompt("surprise", 1, "Hero")).toBe("Explore 1 surprising direction for Hero");
    expect(explorePrompt("custom", 2, "Nav", "darker")).toBe("Explore 2 darker directions for Nav");
  });

  it("picks an effort the model takes", () => {
    const models = [
      {
        value: "a",
        displayName: "A",
        description: "",
        supportedEffortLevels: ["low" as const, "medium" as const],
      },
      { value: "b", displayName: "B", description: "" },
    ];
    expect(effortFor(models, "a", "max")).toBe("medium");
    expect(effortFor(models, "a", "low")).toBe("low");
    expect(effortFor(models, "b", "high")).toBe("high");
  });
});
