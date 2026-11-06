// Limits the server enforces, so the browser stops at the same place.
// limits.test.ts checks them against crates/design/fixtures/limits.json and
// the lobby's against crates/server/fixtures/messages.json.

/** The longest comment or reply, in characters. */
export const COMMENT_LIMIT = 4000;
/** The longest name a person can comment under, in characters. */
export const NAME_LIMIT = 48;
/** How many elements one comment can point at. */
export const SELECTION_LIMIT = 50;

/**
 * How many designs the design list shows: the server's `LOBBY_LIMIT` in
 * `crates/server/src/hub/mod.rs`. The socket starts with this many, newest
 * first, and the page offers a search for the rest.
 */
export const LOBBY_LIMIT = 200;
