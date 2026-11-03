import type { View } from "@/design/camera";

/** Where someone was in a design: the page they looked at, and the camera's view of each page. */
export interface Place {
  /** The page, or `null` for the first. */
  readonly page: string | null;
  /** The last view of each page they looked at, by page id. */
  readonly views: Readonly<Record<string, View>>;
}

const key = (designId: string) => `finite.place.${designId}`;

/** A saved place, or `null` when `raw` isn't one (missing, or from an older shape). */
export function parsePlace(raw: string | null): Place | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return null;
    const { page, views } = value as { page?: unknown; views?: unknown };
    if (page !== null && typeof page !== "string") return null;
    if (typeof views !== "object" || views === null) return null;
    // Drop a broken view and keep the rest: that page is framed instead.
    const valid: Record<string, View> = {};
    for (const [pageId, view] of Object.entries(views)) {
      const parsed = parseView(view);
      if (parsed) valid[pageId] = parsed;
    }
    return { page, views: valid };
  } catch {
    return null;
  }
}

function parseView(value: unknown): View | null {
  if (typeof value !== "object" || value === null) return null;
  const { x, y, zoom } = value as Partial<Record<keyof View, unknown>>;
  if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(zoom) || zoom <= 0) return null;
  return { x, y, zoom };
}

const isFiniteNumber = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

/**
 * Where this browser last was in `designId`, so a reload or a later visit
 * opens on the same page at the same pixel offset and zoom, and going back
 * to another page shows it as it was left. Local storage
 * can be blocked (private windows), so that reads as no place.
 */
export function loadPlace(designId: string): Place | null {
  try {
    return parsePlace(localStorage.getItem(key(designId)));
  } catch {
    return null;
  }
}

export function savePlace(designId: string, place: Place) {
  try {
    localStorage.setItem(key(designId), JSON.stringify(place));
  } catch {
    // Storage is full or blocked: the next visit frames the artboards instead.
  }
}
