import type { ThreadEvent } from "@finite/protocol";

/**
 * A thread's events as the messages panel shows them. The log has a row when a tool call starts
 * and another when it ends; they merge into one at the start's place, with the latest status and
 * summary.
 */
export function chatRows(events: ReadonlyArray<ThreadEvent>): ThreadEvent[] {
  const rows: ThreadEvent[] = [];
  const tools = new Map<string, number>();
  for (const event of events) {
    if (event.type === "result" || event.type === "text.delta") continue;
    if (event.type === "tool") {
      const at = tools.get(event.id);
      if (at !== undefined) {
        const first = rows[at] as Extract<ThreadEvent, { type: "tool" }>;
        rows[at] = { ...first, ...event, summary: event.summary || first.summary, at: first.at };
        continue;
      }
      tools.set(event.id, rows.length);
    }
    rows.push(event);
  }
  return rows;
}
