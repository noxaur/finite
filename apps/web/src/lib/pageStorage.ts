import type { PageStorage, StorageChange } from "@/design/renderer";

/** About 5 MB of UTF-16, like a browser's own `localStorage` quota. */
export const PAGE_STORAGE_QUOTA = 2_500_000;

const key = (designId: string) => `finite.pages.${designId}`;

/** The stored map, or an empty one when `raw` isn't one. Values that aren't strings are dropped. */
export function parseStorage(raw: string | null): Record<string, string> {
  if (!raw) return {};
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(value)) if (typeof v === "string") out[k] = v;
    return out;
  } catch {
    return {};
  }
}

/** `map` with `change` applied, or `null` when the result is over the quota. */
export function applyChange(
  map: Readonly<Record<string, string>>,
  change: StorageChange,
): Record<string, string> | null {
  const next: Record<string, string> = change.clear ? {} : { ...map };
  for (const [k, v] of change.set ?? []) {
    if (v === null) delete next[k];
    else next[k] = v;
  }
  let size = 0;
  for (const [k, v] of Object.entries(next)) size += k.length + v.length;
  return size > PAGE_STORAGE_QUOTA ? null : next;
}

/**
 * The `localStorage` that a design's pages share, kept in this browser's
 * own storage under the design's id. Each viewer has their own; it never
 * reaches the server. Private windows and blocked storage just forget it.
 */
export function pageStorage(designId: string): PageStorage {
  let cache: Record<string, string> | null = null;
  const read = () => {
    if (cache) return cache;
    try {
      cache = parseStorage(localStorage.getItem(key(designId)));
    } catch {
      cache = {};
    }
    return cache;
  };
  return {
    read,
    write(change) {
      const next = applyChange(read(), change);
      if (!next) return false;
      cache = next;
      try {
        localStorage.setItem(key(designId), JSON.stringify(next));
      } catch {
        // Full or blocked: the pages keep it until they reload.
      }
      return true;
    },
  };
}
