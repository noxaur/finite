import { type ThreadMeta, type ThreadSection, threadSection } from "@finite/protocol";

/** A thread in the prototypes list, with its child threads nested under it. */
export interface ThreadRow {
  readonly meta: ThreadMeta;
  readonly children: ReadonlyArray<ThreadRow>;
}

export type ThreadGroups = Readonly<Record<ThreadSection, ReadonlyArray<ThreadRow>>>;

/** "Until I open it": a snooze with no end, cleared when the thread is opened. */
export const UNTIL_OPENED = 8.64e15;

/** When a thread last needed someone, for sorting: the agent's hand-back, else its last change. */
const recency = (m: ThreadMeta) => Math.max(m.awaitingSince ?? 0, m.updatedAt);

/**
 * The prototypes list: each top-level thread in its section (see `threadSection`), newest first,
 * snoozed ones by when they wake. A child thread sits under its parent whatever its own state,
 * unless its parent is gone. `query` keeps threads whose title has it, with their parents.
 */
export function groupThreads(
  threads: ReadonlyArray<ThreadMeta>,
  now: number,
  showWorkingSeparately: boolean,
  query = "",
): ThreadGroups {
  const ids = new Set(threads.map((t) => t.id));
  const kids = new Map<string, ThreadMeta[]>();
  const roots: ThreadMeta[] = [];
  for (const t of threads) {
    if (t.parentId !== undefined && ids.has(t.parentId) && t.parentId !== t.id) {
      kids.set(t.parentId, [...(kids.get(t.parentId) ?? []), t]);
    } else roots.push(t);
  }
  const q = query.trim().toLowerCase();
  const seen = new Set<string>();
  const build = (meta: ThreadMeta): ThreadRow | null => {
    if (seen.has(meta.id)) return null;
    seen.add(meta.id);
    const children = (kids.get(meta.id) ?? [])
      .sort((a, b) => recency(b) - recency(a))
      .map(build)
      .filter((r): r is ThreadRow => r !== null);
    if (q && !meta.title.toLowerCase().includes(q) && children.length === 0) return null;
    return { meta, children };
  };

  const groups: Record<ThreadSection, ThreadRow[]> = {
    working: [],
    active: [],
    snoozed: [],
    settled: [],
  };
  for (const meta of roots) {
    const row = build(meta);
    if (row) groups[threadSection(meta, now, showWorkingSeparately)].push(row);
  }
  const byRecency = (a: ThreadRow, b: ThreadRow) => recency(b.meta) - recency(a.meta);
  groups.active.sort(byRecency);
  groups.working.sort(byRecency);
  groups.settled.sort((a, b) => (b.meta.settledAt ?? 0) - (a.meta.settledAt ?? 0));
  groups.snoozed.sort((a, b) => (a.meta.snoozedUntil ?? 0) - (b.meta.snoozedUntil ?? 0));
  return groups;
}

export type SnoozeChoice = "hour" | "tomorrow" | "week" | "opened";

export const SNOOZE_CHOICES: ReadonlyArray<readonly [SnoozeChoice, string]> = [
  ["hour", "1 hour"],
  ["tomorrow", "Tomorrow"],
  ["week", "Next week"],
  ["opened", "Until I open it"],
];

/** When a snooze ends: an hour on, 9am tomorrow, 9am next Monday, or never (until opened). */
export function snoozeUntil(choice: SnoozeChoice, now: number): number {
  if (choice === "hour") return now + 3600_000;
  if (choice === "opened") return UNTIL_OPENED;
  const d = new Date(now);
  d.setHours(9, 0, 0, 0);
  if (choice === "tomorrow") d.setDate(d.getDate() + 1);
  else d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7));
  return d.getTime();
}

/** How long until a snooze ends, short: "45m", "3h", "2d", or "" for one until opened. */
export function snoozeLeft(until: number, now: number): string {
  if (until >= UNTIL_OPENED) return "";
  const minutes = Math.max(1, Math.round((until - now) / 60_000));
  if (minutes <= 90) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/** "18m", "5h", "3d", "now": a thread's age at a glance, as in the list. */
export function shortAgo(at: number, now: number): string {
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return days < 7 ? `${days}d` : `${Math.floor(days / 7)}w`;
}
