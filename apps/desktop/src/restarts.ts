/**
 * When to restart the server after it stops on its own, the way a process
 * supervisor like systemd does (`Restart=` with a rate limit): restart it,
 * unless it has already stopped `MAX_STOPS` times within `WINDOW_MS`. Then
 * something is wrong that a restart won't fix, and the app says so and quits.
 */
export const MAX_STOPS = 3;
export const WINDOW_MS = 60_000;

/** Records a stop at `now`. Returns whether to restart, and the stops to remember. */
export function afterStop(
  stops: ReadonlyArray<number>,
  now: number,
): { restart: boolean; stops: number[] } {
  const recent = [...stops.filter((at) => now - at < WINDOW_MS), now];
  return { restart: recent.length < MAX_STOPS, stops: recent };
}
