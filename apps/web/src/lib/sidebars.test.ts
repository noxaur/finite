import { describe, expect, it } from "vite-plus/test";
import { loadSidebarsOpen, parseSidebarsOpen, saveSidebarsOpen } from "./sidebars";

function memory() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

const blocked = {
  getItem: (): string | null => {
    throw new DOMException("blocked", "SecurityError");
  },
  setItem: () => {
    throw new DOMException("full", "QuotaExceededError");
  },
  removeItem: () => {
    throw new DOMException("blocked", "SecurityError");
  },
};

describe("sidebars setting", () => {
  it("shows the sidebars unless they were hidden", () => {
    expect(parseSidebarsOpen(null)).toBe(true);
    expect(parseSidebarsOpen("hidden")).toBe(false);
    expect(parseSidebarsOpen("something else")).toBe(true);
  });

  it("remembers hide mode, and forgets it when the sidebars come back", () => {
    const storage = memory();
    expect(loadSidebarsOpen(storage)).toBe(true);
    saveSidebarsOpen(false, storage);
    expect(loadSidebarsOpen(storage)).toBe(false);
    saveSidebarsOpen(true, storage);
    expect(loadSidebarsOpen(storage)).toBe(true);
    expect(storage.map.size).toBe(0);
  });

  it("shows the sidebars and doesn't throw when storage is blocked", () => {
    expect(loadSidebarsOpen(blocked)).toBe(true);
    expect(() => saveSidebarsOpen(false, blocked)).not.toThrow();
  });
});
