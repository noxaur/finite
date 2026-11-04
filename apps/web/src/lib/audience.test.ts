import { describe, expect, it } from "vite-plus/test";
import type { Author, Comment } from "@/design/schema";
import { audienceLabel, audienceOf, knownAgents, routeLabel } from "./audience";

const person: Author = { id: "user:ada", name: "Ada", kind: "user" };
const agent: Author = { id: "agent:designer", name: "Designer", kind: "agent" };

function comment(over: Partial<Comment> = {}): Comment {
  return {
    id: "c1",
    artboardId: "board",
    nodeId: null,
    x: 0,
    y: 0,
    resolved: false,
    createdAt: 0,
    messages: [{ author: person, body: "Make it red", at: 0, seq: 0 }],
    rev: 0,
    ...over,
  };
}

describe("audienceOf", () => {
  it("is any agent for comments from before audiences", () => {
    expect(audienceOf(comment())).toEqual({ kind: "agents" });
    expect(audienceLabel(audienceOf(comment()))).toBe("Any agent");
  });

  it("names the agent that took a comment, unless a person picked one", () => {
    expect(routeLabel(comment({ takenBy: agent }))).toBe("With Designer");
    expect(routeLabel(comment({ takenBy: agent, audience: { kind: "people" } }))).toBe(
      "People only",
    );
  });

  it("names the agent a comment is for", () => {
    const directed = comment({ audience: { kind: "agent", id: agent.id, name: agent.name } });
    expect(audienceLabel(audienceOf(directed))).toBe("For Designer");
  });
});

describe("knownAgents", () => {
  it("lists agents from threads, listening and presence once, by name, without people", () => {
    const thread = comment({
      messages: [
        { author: person, body: "Hi", at: 0, seq: 0 },
        { author: agent, body: "Done", at: 1, seq: 1 },
      ],
    });
    const agents = knownAgents(
      new Map([["c1", thread]]),
      [
        { actor: "agent:designer", name: "Designer 2", nodeIds: [], status: null, updatedAt: 0 },
        { actor: "mcp:s1", name: "Claude", nodeIds: [], status: null, updatedAt: 0 },
        { actor: "user:bo", name: "Bo", nodeIds: [], status: null, updatedAt: 0 },
      ],
      [{ actor: "agent:quiet", name: "Quiet" }],
    );
    expect(agents).toEqual([
      { id: "mcp:s1", name: "Claude" },
      { id: "agent:designer", name: "Designer 2" },
      { id: "agent:quiet", name: "Quiet" },
    ]);
  });
});
