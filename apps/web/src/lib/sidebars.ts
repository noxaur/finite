/**
 * Whether the canvas shows its sidebars, or hides them for more room (hide
 * mode). It's one setting for the whole browser, not one per design, kept in
 * `localStorage`. Private windows and blocked storage just show the sidebars.
 */
const KEY = "finite.sidebars";
const HIDDEN = "hidden";

type Reads = Pick<Storage, "getItem">;
type Writes = Pick<Storage, "setItem" | "removeItem">;

/** Whether a stored value says the sidebars are shown. Anything but "hidden" shows them. */
export function parseSidebarsOpen(raw: string | null): boolean {
  return raw !== HIDDEN;
}

/** Whether this browser last showed the sidebars. `storage` defaults to `localStorage`. */
export function loadSidebarsOpen(storage?: Reads): boolean {
  try {
    return parseSidebarsOpen((storage ?? localStorage).getItem(KEY));
  } catch {
    return true;
  }
}

/** Remembers whether the sidebars are shown. Showing them, the default, clears the key. */
export function saveSidebarsOpen(open: boolean, storage?: Writes): void {
  try {
    const s = storage ?? localStorage;
    if (open) s.removeItem(KEY);
    else s.setItem(KEY, HIDDEN);
  } catch {
    // Storage can be blocked or full; the setting just isn't remembered.
  }
}
