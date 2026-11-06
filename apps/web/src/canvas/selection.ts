import type { Loc, Remap } from "@finite/protocol";
import { useSyncExternalStore } from "react";

/**
 * One selected thing: a frame (no `loc`), or the `index`th rendered instance of the element
 * stamped `loc` inside it. The composer and the ✱ menu read this.
 */
export type SelectionItem = {
  frameId: string;
  loc?: Loc;
  index?: number;
  /** What people call it, for chips in the composer: the frame's name or the element's layer name. */
  name?: string;
};

export const keyOf = (item: SelectionItem): string =>
  item.loc === undefined ? item.frameId : `${item.frameId}|${item.loc}|${item.index ?? 0}`;

export const sameItem = (a: SelectionItem, b: SelectionItem) => keyOf(a) === keyOf(b);

/** A tiny external store: `get` stays the same array until `set` replaces it. */
export interface Store<T> {
  readonly get: () => T;
  readonly set: (value: T) => void;
  readonly subscribe: (fn: () => void) => () => void;
}

export function createStore<T>(initial: T, equal: (a: T, b: T) => boolean = Object.is): Store<T> {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next) {
      if (equal(value, next)) return;
      value = next;
      for (const fn of listeners) fn();
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

const sameList = (a: readonly SelectionItem[], b: readonly SelectionItem[]) =>
  a.length === b.length && a.every((x, i) => sameItem(x, b[i]!));

export const selectionStore: Store<readonly SelectionItem[]> = createStore<
  readonly SelectionItem[]
>([], sameList);

export function useSelection(): readonly SelectionItem[] {
  return useSyncExternalStore(selectionStore.subscribe, selectionStore.get, selectionStore.get);
}

/** The selection after an edit moved locs: each element follows its remapped loc. */
export function remapSelection(items: readonly SelectionItem[], remap: Remap): SelectionItem[] {
  return items.map((item) =>
    item.loc !== undefined && remap[item.loc] !== undefined
      ? { ...item, loc: remap[item.loc]! }
      : item,
  );
}

/** Adds or takes out `item`, as Shift-click does. */
export function toggleItem(items: readonly SelectionItem[], item: SelectionItem): SelectionItem[] {
  return items.some((x) => sameItem(x, item))
    ? items.filter((x) => !sameItem(x, item))
    : [...items, item];
}
