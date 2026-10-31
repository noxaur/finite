import type { DesignSummary } from "@/design/schema";

/**
 * How many designs the design list shows: the server's `LOBBY_LIMIT` in
 * `crates/server/src/hub/mod.rs`. The socket starts with this many, newest
 * first, and the page offers a search for the rest.
 */
export const LOBBY_LIMIT = 200;

/**
 * The list after `design` changed: it moves to the front, and the list keeps
 * at most `LOBBY_LIMIT`. Without the cap, a tab left open on a busy server
 * would add every design anyone touched, each with a thumbnail that fetches
 * its design. `trimmed` says whether one fell off, so the page knows there
 * are more than it shows.
 */
export function mergeLobby(
  current: ReadonlyArray<DesignSummary>,
  design: DesignSummary,
): { designs: ReadonlyArray<DesignSummary>; trimmed: boolean } {
  const designs = [design, ...current.filter((d) => d.id !== design.id)];
  return { designs: designs.slice(0, LOBBY_LIMIT), trimmed: designs.length > LOBBY_LIMIT };
}
