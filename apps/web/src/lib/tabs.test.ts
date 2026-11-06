import { describe, expect, it } from "vite-plus/test";
import {
  changedSince,
  closeTab,
  createTabsStore,
  loadTabs,
  markSeen,
  NO_TABS,
  openTab,
  parseTabs,
  pruneTabs,
  renameTab,
  stepTab,
  TABS_KEY,
  type TabState,
  type TabStorage,
} from "./tabs";

const three: TabState = {
  tabs: [
    { id: "a", name: "A" },
    { id: "b", name: "B" },
    { id: "c", name: "C" },
  ],
  seen: { a: 1, b: 2, c: 3 },
};
const ids = (state: TabState) => state.tabs.map((tab) => tab.id);

/** A storage that keeps one map, like `localStorage`. */
function memory(): TabStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
  };
}

/** A storage that throws, like one a private window blocks. */
const blocked: TabStorage = {
  getItem: () => {
    throw new DOMException("blocked", "SecurityError");
  },
  setItem: () => {
    throw new DOMException("full", "QuotaExceededError");
  },
};

describe("openTab", () => {
  it("adds a new design at the end", () => {
    expect(ids(openTab(three, "d", "D"))).toEqual(["a", "b", "c", "d"]);
  });

  it("focuses an open design where it is, without adding it twice", () => {
    expect(openTab(three, "b")).toBe(three);
    expect(ids(openTab(three, "b", "B"))).toEqual(["a", "b", "c"]);
  });

  it("renames an open design", () => {
    expect(openTab(three, "b", "Pricing").tabs[1]).toEqual({ id: "b", name: "Pricing" });
  });

  it("leaves the name empty until it's known", () => {
    expect(openTab(NO_TABS, "x").tabs).toEqual([{ id: "x", name: "" }]);
  });
});

describe("renameTab", () => {
  it("keeps the same state when nothing changes", () => {
    expect(renameTab(three, "a", "A")).toBe(three);
    expect(renameTab(three, "zzz", "Gone")).toBe(three);
  });
});

describe("closeTab", () => {
  it("goes to the tab on the right when the active one closes", () => {
    const { state, next } = closeTab(three, "b", "b");
    expect(ids(state)).toEqual(["a", "c"]);
    expect(next).toBe("c");
  });

  it("goes to the tab on the left when the last one in the row closes", () => {
    expect(closeTab(three, "c", "c").next).toBe("b");
  });

  it("goes to the designs list when the only tab closes", () => {
    const one = openTab(NO_TABS, "a", "A");
    const { state, next } = closeTab(one, "a", "a");
    expect(state.tabs).toEqual([]);
    expect(next).toBeNull();
  });

  it("stays put when another tab closes", () => {
    const { state, next } = closeTab(three, "a", "c");
    expect(ids(state)).toEqual(["b", "c"]);
    expect(next).toBeUndefined();
  });

  it("forgets when the closed design was seen", () => {
    expect(closeTab(three, "a", null).state.seen).toEqual({ b: 2, c: 3 });
  });

  it("ignores a tab that isn't open", () => {
    expect(closeTab(three, "zzz", "a")).toEqual({ state: three, next: undefined });
  });
});

describe("pruneTabs", () => {
  it("drops deleted designs and keeps the order", () => {
    const state = pruneTabs(three, (id) => id !== "b");
    expect(ids(state)).toEqual(["a", "c"]);
    expect(state.seen).toEqual({ a: 1, c: 3 });
  });

  it("keeps the same state when every design exists", () => {
    expect(pruneTabs(three, () => true)).toBe(three);
  });
});

describe("markSeen and changedSince", () => {
  it("shows a change made after the design was last looked at", () => {
    expect(changedSince(three, "a", 1)).toBe(false);
    expect(changedSince(three, "a", 5)).toBe(true);
    expect(changedSince(markSeen(three, "a", 5), "a", 5)).toBe(false);
  });

  it("never moves back in time", () => {
    expect(markSeen(three, "c", 1)).toBe(three);
  });

  it("doesn't count a design never seen here as changed", () => {
    expect(changedSince(openTab(NO_TABS, "x"), "x", 100)).toBe(false);
  });
});

describe("stepTab", () => {
  it("steps and wraps around the ends", () => {
    expect(stepTab(three, "a", 1)).toBe("b");
    expect(stepTab(three, "c", 1)).toBe("a");
    expect(stepTab(three, "a", -1)).toBe("c");
  });

  it("starts at an end with no active tab", () => {
    expect(stepTab(three, null, 1)).toBe("a");
    expect(stepTab(three, null, -1)).toBe("c");
    expect(stepTab(NO_TABS, null, 1)).toBeNull();
  });
});

describe("parseTabs", () => {
  it("reads a saved state", () => {
    expect(parseTabs(JSON.stringify(three))).toEqual(three);
  });

  it("drops broken and repeated tabs, and seen times of closed ones", () => {
    const raw = JSON.stringify({
      tabs: [{ id: "a", name: "A" }, { id: "" }, { id: 3 }, null, { id: "a" }, { id: "b" }],
      seen: { a: 1, b: "x", gone: 4 },
    });
    expect(parseTabs(raw)).toEqual({
      tabs: [
        { id: "a", name: "A" },
        { id: "b", name: "" },
      ],
      seen: { a: 1 },
    });
  });

  it("reads anything else as nothing", () => {
    for (const raw of [null, "", "{", "null", "[]", '{"tabs":{}}']) {
      expect(parseTabs(raw)).toBeNull();
    }
  });
});

describe("persistence", () => {
  it("saves every change and loads it back", () => {
    const storage = memory();
    const store = createTabsStore(() => storage);
    store.update((s) => openTab(s, "a", "A"));
    store.update((s) => openTab(s, "b", "B"));
    expect(ids(loadTabs(() => storage))).toEqual(["a", "b"]);
    expect(ids(createTabsStore(() => storage).get())).toEqual(["a", "b"]);
  });

  it("tells subscribers, and only about real changes", () => {
    const store = createTabsStore(() => memory());
    let calls = 0;
    store.subscribe(() => calls++);
    store.update((s) => openTab(s, "a", "A"));
    store.update((s) => openTab(s, "a"));
    expect(calls).toBe(1);
  });

  it("falls back to just the current design when storage is blocked", () => {
    const store = createTabsStore(() => blocked);
    expect(store.get()).toEqual(NO_TABS);
    store.update((s) => openTab(s, "current", "Current"));
    expect(store.get().tabs).toEqual([{ id: "current", name: "Current" }]);
  });

  it("falls back to just the current design when the save is broken", () => {
    const storage = memory();
    storage.data.set(TABS_KEY, "{not json");
    const store = createTabsStore(() => storage);
    store.update((s) => openTab(s, "current"));
    expect(ids(store.get())).toEqual(["current"]);
  });

  it("works with no storage at all, as in the server render", () => {
    const store = createTabsStore(() => undefined);
    store.update((s) => openTab(s, "a"));
    expect(ids(store.get())).toEqual(["a"]);
  });
});
