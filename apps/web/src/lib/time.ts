const units: ReadonlyArray<[Intl.RelativeTimeFormatUnit, number]> = [
  ["year", 365 * 24 * 3600_000],
  ["month", 30 * 24 * 3600_000],
  ["day", 24 * 3600_000],
  ["hour", 3600_000],
  ["minute", 60_000],
];

const format = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

/** "3 minutes ago", "yesterday", or "just now" for anything under a minute. */
export function timeAgo(ms: number, now = Date.now()) {
  const elapsed = now - ms;
  for (const [unit, size] of units) {
    if (elapsed >= size) return format.format(-Math.floor(elapsed / size), unit);
  }
  return "just now";
}
