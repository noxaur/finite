import { tokenOf } from "./inspect";
import { type ListEntry, parts } from "./lists";

/** One transition, as its four parts in CSS. `duration` and `delay` may be tokens. */
export interface Transition {
  readonly property: string;
  readonly duration: string;
  readonly easing: string;
  readonly delay: string;
}

const EASINGS = new Set([
  "ease",
  "linear",
  "ease-in",
  "ease-out",
  "ease-in-out",
  "step-start",
  "step-end",
]);
const TIME = /^-?\d*\.?\d+m?s$/i;

/**
 * The token a value names, with or without a fallback: `var(--ease-out)`
 * and `var(--ease-out, ease)` are both `--ease-out`.
 */
export function tokenIn(v: string): string | null {
  return (
    tokenOf(v) ?? v.match(/^\s*var\(\s*(--[\w-]+)\s*,[^()]*(\([^()]*\)[^()]*)*\)\s*$/)?.[1] ?? null
  );
}

/** Whether `v` is a timing function: a keyword, a curve, steps, or a token named `--ease…`. */
export function isEasing(
  v: string,
  resolve: (token: string) => string | undefined = () => undefined,
): boolean {
  const token = tokenIn(v);
  if (token) {
    if (token.startsWith("--ease")) return true;
    const value = resolve(token);
    return value !== undefined && !TIME.test(value.trim()) && isEasing(value);
  }
  return EASINGS.has(v.toLowerCase()) || /^(cubic-bezier|steps|linear)\(/i.test(v);
}

/** A time token or literal. */
const isTime = (v: string, resolve: (token: string) => string | undefined) => {
  const token = tokenIn(v);
  return token
    ? TIME.test(resolve(token)?.trim() ?? "") || /^--(d|dur|duration)-/.test(token)
    : TIME.test(v);
};

/**
 * One `transition` entry taken apart: the first time is the duration and
 * the second the delay. `null` for anything else the row can't show, like
 * `allow-discrete` or two properties.
 */
export function parseTransition(
  entry: string,
  resolve: (token: string) => string | undefined = () => undefined,
): Transition | null {
  let property: string | undefined;
  let easing: string | undefined;
  const times: string[] = [];
  for (const p of parts(entry)) {
    if (isTime(p, resolve)) times.push(p);
    else if (isEasing(p, resolve)) {
      if (easing !== undefined) return null;
      easing = p;
    } else if (/^(--)?[a-z][\w-]*$/i.test(p) && p !== "none" && property === undefined)
      property = p;
    else return null;
  }
  if (times.length > 2) return null;
  return {
    property: property ?? "all",
    duration: times[0] ?? "0s",
    easing: easing ?? "ease",
    delay: times[1] ?? "0s",
  };
}

/** A transition as one entry, leaving out what is the default. */
export function transitionText(t: Transition): string {
  return [
    t.property,
    t.duration,
    t.easing === "ease" ? "" : t.easing,
    /^0m?s$/.test(t.delay) ? "" : t.delay,
  ]
    .filter(Boolean)
    .join(" ");
}

/** A time in milliseconds, or `null` for a token. */
export function msOf(time: string): number | null {
  const m = time.trim().match(/^(-?\d*\.?\d+)(m?s)$/i);
  if (!m) return null;
  return Math.round(Number(m[1]) * (m[2]!.toLowerCase() === "s" ? 1000 : 1) * 100) / 100;
}

/** Properties a row shows as one, written as one entry each with the same timing. */
export const GROUPS: Readonly<Record<string, readonly string[]>> = {
  colors: ["color", "background-color", "border-color"],
  transform: ["transform", "translate", "scale", "rotate"],
};

/** A row of the Transitions list: one entry, or a group of them that share their timing. */
export interface TransitionRow {
  /** A property, or a `GROUPS` name. */
  readonly property: string;
  readonly timing: Omit<Transition, "property"> | null;
  /** The entries it stands for, in order. */
  readonly entries: ReadonlyArray<ListEntry>;
  readonly hidden: boolean;
}

/**
 * The list's entries as rows: a run of entries with the same timing that
 * names exactly a group's properties is one row. An entry the row can't
 * show has a `null` timing.
 */
export function transitionRows(
  entries: ReadonlyArray<ListEntry>,
  resolve: (token: string) => string | undefined = () => undefined,
): TransitionRow[] {
  const rows: TransitionRow[] = [];
  const parsed = entries.map((e) => parseTransition(e.css, resolve));
  for (let i = 0; i < entries.length;) {
    const t = parsed[i];
    const group = t && Object.entries(GROUPS).find(([, props]) => props[0] === t.property);
    if (t && group) {
      const [name, props] = group;
      const run = props.map((_, k) => parsed[i + k]);
      const same = run.every(
        (r, k) =>
          r &&
          r.property === props[k] &&
          r.duration === t.duration &&
          r.easing === t.easing &&
          r.delay === t.delay &&
          entries[i + k]!.hidden === entries[i]!.hidden,
      );
      if (same) {
        const { property: _, ...timing } = t;
        rows.push({
          property: name,
          timing,
          entries: entries.slice(i, i + props.length),
          hidden: entries[i]!.hidden,
        });
        i += props.length;
        continue;
      }
    }
    const entry = entries[i]!;
    rows.push({
      property: t?.property ?? "",
      timing: t ? { duration: t.duration, easing: t.easing, delay: t.delay } : null,
      entries: [entry],
      hidden: entry.hidden,
    });
    i++;
  }
  return rows;
}

/** The entries a row with `property` and `timing` writes. */
export function rowEntries(
  property: string,
  timing: Omit<Transition, "property">,
  hidden: boolean,
): ListEntry[] {
  return (GROUPS[property] ?? [property]).map((p) => ({
    css: transitionText({ ...timing, property: p }),
    hidden,
  }));
}

/**
 * What an entry the row can't show still says: its property and its
 * first time, when it names them, for a Custom row to show.
 */
export function partialTransition(entry: string): { property?: string; duration?: string } {
  const all = parts(entry);
  const property = all.find(
    (p) => /^(--)?[a-z][\w-]*$/i.test(p) && !EASINGS.has(p) && !/^(allow-discrete|normal)$/.test(p),
  );
  const duration = all.find((p) => TIME.test(p));
  return {
    ...(property && { property: property.replace(/,$/, "") }),
    ...(duration && { duration }),
  };
}

/** The entry that replaces one the row can't show: what it said, with a named easing. */
export function resetTransition(entry: string): string {
  const { property = "all", duration = "200ms" } = partialTransition(entry);
  return transitionText({ property, duration, easing: "ease", delay: "0s" });
}
