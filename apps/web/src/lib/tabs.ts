/**
 * The designs open as tabs in this browser, in the tab bar's order. The
 * route says which one is active; this only keeps the list, and when each
 * design was last looked at, so a tab can say an agent changed it since.
 *
 * The functions here are pure. `tabsStore` holds the live state for React
 * and saves it to local storage on every change.
 */

export interface Tab {
  readonly id: string;
  /** The design's name, or "" until it's known. */
  readonly name: string;
}

export interface TabState {
  readonly tabs: ReadonlyArray<Tab>;
  /** Each open design's `updatedAt` when it was last the active tab, by id. */
  readonly seen: Readonly<Record<string, number>>;
}

export const NO_TABS: TabState = { tabs: [], seen: {} };

/** Opens `id` at the end, or keeps it where it is. A `name` renames it. */
export function openTab(state: TabState, id: string, name?: string): TabState {
  if (state.tabs.some((tab) => tab.id === id)) {
    return name === undefined ? state : renameTab(state, id, name);
  }
  return { ...state, tabs: [...state.tabs, { id, name: name ?? "" }] };
}

export function renameTab(state: TabState, id: string, name: string): TabState {
  const tab = state.tabs.find((t) => t.id === id);
  if (!tab || tab.name === name) return state;
  return { ...state, tabs: state.tabs.map((t) => (t.id === id ? { ...t, name } : t)) };
}

/**
 * Closes `id`. `next` is where to go when it was the active one: the tab to
 * its right, else the one to its left, or `null` for the designs list when
 * it was the last. It's `undefined` when the active tab stays.
 */
export function closeTab(
  state: TabState,
  id: string,
  active: string | null,
): { readonly state: TabState; readonly next: string | null | undefined } {
  const at = state.tabs.findIndex((tab) => tab.id === id);
  if (at === -1) return { state, next: undefined };
  const tabs = state.tabs.filter((tab) => tab.id !== id);
  const { [id]: _, ...seen } = state.seen;
  const next = id !== active ? undefined : ((tabs[at] ?? tabs[at - 1])?.id ?? null);
  return { state: { tabs, seen }, next };
}

/** Drops the tabs of designs that are gone. */
export function pruneTabs(state: TabState, exists: (id: string) => boolean): TabState {
  if (state.tabs.every((tab) => exists(tab.id))) return state;
  const tabs = state.tabs.filter((tab) => exists(tab.id));
  const seen: Record<string, number> = {};
  for (const tab of tabs) if (tab.id in state.seen) seen[tab.id] = state.seen[tab.id];
  return { tabs, seen };
}

/** Records that `id` was looked at when its last change was at `updatedAt`. */
export function markSeen(state: TabState, id: string, updatedAt: number): TabState {
  if ((state.seen[id] ?? -Infinity) >= updatedAt) return state;
  return { ...state, seen: { ...state.seen, [id]: updatedAt } };
}

/**
 * Whether `id` changed after it was last looked at. A tab never seen in this
 * browser, say one restored from an older save, doesn't count as changed.
 */
export function changedSince(state: TabState, id: string, updatedAt: number): boolean {
  const seen = state.seen[id];
  return seen !== undefined && updatedAt > seen;
}

/**
 * The tab `by` steps from `active`, wrapping around the ends. With no active
 * tab, stepping forward starts at the first and back at the last.
 */
export function stepTab(state: TabState, active: string | null, by: 1 | -1): string | null {
  const { tabs } = state;
  if (tabs.length === 0) return null;
  const at = tabs.findIndex((tab) => tab.id === active);
  if (at === -1) return (by === 1 ? tabs[0] : tabs[tabs.length - 1]).id;
  return tabs[(at + by + tabs.length) % tabs.length].id;
}

/** A saved state, or `null` when `raw` isn't one. Broken tabs are dropped. */
export function parseTabs(raw: string | null): TabState | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return null;
    const { tabs, seen } = value as { tabs?: unknown; seen?: unknown };
    if (!Array.isArray(tabs)) return null;
    const valid: Tab[] = [];
    for (const tab of tabs) {
      if (typeof tab !== "object" || tab === null) continue;
      const { id, name } = tab as { id?: unknown; name?: unknown };
      if (typeof id !== "string" || !id || valid.some((t) => t.id === id)) continue;
      valid.push({ id, name: typeof name === "string" ? name : "" });
    }
    const seenValid: Record<string, number> = {};
    if (typeof seen === "object" && seen !== null) {
      for (const [id, at] of Object.entries(seen)) {
        if (typeof at === "number" && Number.isFinite(at) && valid.some((t) => t.id === id)) {
          seenValid[id] = at;
        }
      }
    }
    return { tabs: valid, seen: seenValid };
  } catch {
    return null;
  }
}

export const TABS_KEY = "finite.tabs";

/** The minimal storage these need: `localStorage`, or a stand-in in tests. */
export type TabStorage = Pick<Storage, "getItem" | "setItem">;

/**
 * The saved tabs, or none. Storage can be blocked (private windows, a full
 * quota), so that reads as no tabs, and opening the current design leaves
 * just its tab.
 */
export function loadTabs(storage: () => TabStorage | undefined): TabState {
  try {
    return parseTabs(storage()?.getItem(TABS_KEY) ?? null) ?? NO_TABS;
  } catch {
    return NO_TABS;
  }
}

export function saveTabs(storage: () => TabStorage | undefined, state: TabState): void {
  try {
    storage()?.setItem(TABS_KEY, JSON.stringify(state));
  } catch {
    // Blocked or full: the tabs last for this page only.
  }
}

/** A store for `useSyncExternalStore`: it loads once, on first read, and saves on every change. */
export function createTabsStore(storage: () => TabStorage | undefined) {
  let state: TabState | null = null;
  const listeners = new Set<() => void>();
  const get = () => (state ??= loadTabs(storage));
  return {
    get,
    /** The state before anything loads: for the server render and hydration. */
    getServer: () => NO_TABS,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    update: (change: (state: TabState) => TabState) => {
      const before = get();
      const after = change(before);
      if (after === before) return;
      state = after;
      saveTabs(storage, after);
      for (const listener of listeners) listener();
    },
  };
}

const browserStorage = () => (typeof window === "undefined" ? undefined : window.localStorage);

/** This page's tabs. */
export const tabsStore = createTabsStore(browserStorage);
