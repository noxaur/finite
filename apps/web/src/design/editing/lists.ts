/** `value` split at spaces outside brackets: `1px solid rgb(0 0 0)` has three parts. */
export function parts(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let part = "";
  for (const c of value.trim()) {
    if (c === "(") depth++;
    else if (c === ")" && depth > 0) depth--;
    if (/\s/.test(c) && depth === 0) {
      if (part) out.push(part);
      part = "";
    } else part += c;
  }
  if (part) out.push(part);
  return out;
}

/** `value` split at commas outside brackets. */
export function commas(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "," && depth === 0) {
      out.push(value.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(value.slice(start).trim());
  return out;
}

/** Properties whose value is a list of entries, and how the entries are separated. */
const SPACED = new Set(["filter", "backdrop-filter"]);

/** The custom property that keeps a list's hidden entries, aligned by index. */
export const STASH_PREFIX = "--finite-off-";
export const stashOf = (prop: string) => `${STASH_PREFIX}${prop}`;

/** `prop`'s entries: split at top-level commas, or at spaces for filters. `none` has none. */
export function splitList(prop: string, value: string | undefined): string[] {
  const v = value?.trim() ?? "";
  if (v === "" || v === "none") return [];
  return SPACED.has(prop) ? parts(v) : commas(v);
}

/** The functions a filter entry can be, and the amount that leaves the layer as it is. */
const IDENTITY: Readonly<Record<string, string>> = {
  blur: "0",
  brightness: "1",
  contrast: "1",
  saturate: "1",
  opacity: "1",
  grayscale: "0",
  invert: "0",
  sepia: "0",
  "hue-rotate": "0deg",
  "drop-shadow": "0 0 0 transparent",
};

/** The entry that stands in for a hidden one at the same index, so the others keep their places. */
export function placeholderOf(prop: string, entry: string): string {
  switch (prop) {
    case "box-shadow":
      return "0 0 0 0 transparent";
    case "text-shadow":
      return "0 0 0 transparent";
    case "background-image":
      return "linear-gradient(transparent, transparent)";
    // A custom property nothing reads, so it animates nothing and overrides no other entry.
    case "transition":
      return "--finite-off 0s";
    default: {
      const fn = entry.match(/^([\w-]+)\(/)?.[1] ?? "opacity";
      return `${fn}(${IDENTITY[fn] ?? "1"})`;
    }
  }
}

/** One entry of a list: its CSS, and whether the eye hides it. */
export interface ListEntry {
  readonly css: string;
  readonly hidden: boolean;
}

/**
 * The entries of `value`, `prop`'s list, with the hidden ones read back from
 * the stash: an entry that's the placeholder for the stash's entry at the
 * same index is that entry, hidden.
 */
export function readList(
  styles: Readonly<Record<string, string>>,
  prop: string,
  value: string | undefined = styles[prop],
): ListEntry[] {
  const stash = commas(styles[stashOf(prop)] ?? "");
  return splitList(prop, value).map((css, i) => {
    const off = stash[i];
    return off && off !== "none" && placeholderOf(prop, off) === css
      ? { css: off, hidden: true }
      : { css, hidden: false };
  });
}

/**
 * The styles that make `prop` hold `entries`: hidden ones as placeholders,
 * with the originals in the stash, which goes once nothing is hidden. With
 * no entries, `prop` is set to `empty`: `null` takes it off, `none` covers
 * what a class draws.
 */
export function writeList(
  styles: Readonly<Record<string, string>>,
  prop: string,
  entries: ReadonlyArray<ListEntry>,
  empty: string | null = null,
): Record<string, string | null> {
  const stash = stashOf(prop);
  const out: Record<string, string | null> = {};
  out[prop] =
    entries.length === 0
      ? empty
      : entries
          .map((e) => (e.hidden ? placeholderOf(prop, e.css) : e.css))
          .join(SPACED.has(prop) ? " " : ", ");
  if (entries.some((e) => e.hidden)) {
    out[stash] = entries.map((e) => (e.hidden ? e.css : "none")).join(", ");
  } else if (styles[stash] !== undefined) out[stash] = null;
  return out;
}

/** `entries` with the one at `from` moved to `to`. */
export function moveEntry<T>(entries: ReadonlyArray<T>, from: number, to: number): T[] {
  const out = [...entries];
  const [moved] = out.splice(from, 1);
  if (moved !== undefined) out.splice(Math.max(0, Math.min(to, out.length)), 0, moved);
  return out;
}
