import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { COMMENT_LIMIT, LOBBY_LIMIT, NAME_LIMIT, SELECTION_LIMIT } from "./limits";

const read = (path: string) =>
  JSON.parse(
    readFileSync(new URL(`../../../../crates/${path}`, import.meta.url), "utf8"),
  ) as unknown;

// Recorded from the Rust constants by crates/design/tests/limits.rs.
const limits = read("design/fixtures/limits.json") as {
  readonly commentBody: number;
  readonly authorName: number;
  readonly commentSelection: number;
};
// Recorded by crates/server/tests/wire.rs.
const { lobbyLimit } = read("server/fixtures/messages.json") as { readonly lobbyLimit: number };

describe("limits", () => {
  it("match the server's", () => {
    expect({
      commentBody: COMMENT_LIMIT,
      authorName: NAME_LIMIT,
      commentSelection: SELECTION_LIMIT,
      lobbyLimit: LOBBY_LIMIT,
    }).toEqual({
      commentBody: limits.commentBody,
      authorName: limits.authorName,
      commentSelection: limits.commentSelection,
      lobbyLimit,
    });
  });
});
