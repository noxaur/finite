import type { Comment } from "@finite/protocol";
import { describe, expect, it } from "vite-plus/test";
import { pinState } from "./pins";

const person = { kind: "person", id: "u", name: "U" } as const;
const agent = { kind: "agent", id: "a", name: "A" } as const;
const comment = (over: Partial<Comment> = {}): Comment => ({
  id: "c",
  anchor: { x: 0, y: 0 },
  author: person,
  text: "hi",
  replies: [],
  createdAt: 1,
  ...over,
});

describe("pinState", () => {
  it("waits on an agent for a comment, and is replied once the agent answers", () => {
    expect(pinState(comment())).toBe("waiting");
    expect(
      pinState(comment({ replies: [{ id: "r", author: agent, text: "ok", createdAt: 2 }] })),
    ).toBe("replied");
  });

  it("shows an annotation as a note that no agent waits on, until it's resolved", () => {
    expect(pinState(comment({ kind: "annotation" }))).toBe("note");
    expect(pinState(comment({ kind: "annotation", resolvedAt: 5 }))).toBe("resolved");
    // Resolve and reopen are the same two states for any comment.
    expect(pinState(comment({ kind: "annotation" }))).toBe("note");
  });
});
