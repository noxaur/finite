import { parts } from "./lists";

/**
 * A grid's columns or rows as a list of tracks, like `1fr 200px auto`.
 * `repeat(3, 1fr)` is three `1fr` tracks. `none` and `auto` have none.
 * `null` when the fields can't take it apart: named lines, `auto-fill`,
 * a `subgrid` or a `var()`.
 */
export function tracksOf(raw: string): string[] | null {
  const v = raw.trim();
  if (v === "" || v === "none" || v === "auto") return [];
  if (/\[|var\(|subgrid|masonry|auto-(fill|fit)/.test(v)) return null;
  const out: string[] = [];
  for (const part of parts(v)) {
    const m = part.match(/^repeat\(\s*(\d+)\s*,(.*)\)$/s);
    if (!m) {
      out.push(part);
      continue;
    }
    const inner = parts(m[2]!);
    const n = parseInt(m[1]!, 10);
    if (inner.length === 0 || n > 100) return null;
    for (let i = 0; i < n; i++) out.push(...inner);
  }
  return out;
}

/**
 * Tracks as the value to write: equal ones as `repeat(n, track)`, others
 * one by one; `null` (take it off) when there are none.
 */
export function tracksValue(tracks: ReadonlyArray<string>): string | null {
  const [first] = tracks;
  if (first === undefined) return null;
  if (tracks.length > 1 && tracks.every((t) => t === first)) {
    return `repeat(${tracks.length}, ${first})`;
  }
  return tracks.join(" ");
}

/**
 * A track as its chip shows it: `200px` as `200`, the equal share
 * `minmax(0, 1fr)` as `1fr`, and a range as `100–1fr`.
 */
export function trackLabel(track: string): string {
  const t = track.trim();
  const range = t.match(/^minmax\(\s*([^,]+?)\s*,\s*([^,]+?)\s*\)$/);
  if (range) {
    const [, min, max] = range;
    if (/^0(px)?$/.test(min!)) return label(max!);
    return `${label(min!)}–${label(max!)}`;
  }
  return label(t);
}

const label = (t: string) => t.replace(/^(-?\d*\.?\d+)px$/, "$1");

/** What typing into a chip sets: a bare number is pixels; empty is `null`. */
export function parseTrack(text: string): string | null {
  const v = text.trim();
  if (v === "") return null;
  return /^\d*\.?\d+$/.test(v) ? `${v}px` : v;
}
