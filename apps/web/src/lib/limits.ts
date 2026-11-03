// Limits the server enforces on comments, so the browser stops at the same
// place. limits.test.ts checks them against crates/design/fixtures/limits.json.

/** The longest comment or reply, in characters. */
export const COMMENT_LIMIT = 4000;
/** The longest name a person can comment under, in characters. */
export const NAME_LIMIT = 48;
/** How many elements one comment can point at. */
export const SELECTION_LIMIT = 50;
