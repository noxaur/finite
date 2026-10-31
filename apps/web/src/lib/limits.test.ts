import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { COMMENT_LIMIT, NAME_LIMIT } from "./limits";

// Recorded from the Rust constants by crates/design/tests/limits.rs.
const fixture = JSON.parse(
  readFileSync(new URL("../../../../crates/design/fixtures/limits.json", import.meta.url), "utf8"),
) as { readonly commentBody: number; readonly authorName: number };

describe("limits", () => {
  it("match the server's", () => {
    expect({ commentBody: COMMENT_LIMIT, authorName: NAME_LIMIT }).toEqual({
      commentBody: fixture.commentBody,
      authorName: fixture.authorName,
    });
  });
});
