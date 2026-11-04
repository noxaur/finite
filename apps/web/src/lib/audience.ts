import type { Audience, Comment, Presence } from "@/design/schema";

export const ANY_AGENT: Audience = { kind: "agents" };

/** Who a comment is for. Comments from before audiences are for any agent. */
export function audienceOf(comment: Comment): Audience {
  return comment.audience ?? ANY_AGENT;
}

/** "For any agent", "People only" or "For Designer". */
export function audienceLabel(audience: Audience): string {
  switch (audience.kind) {
    case "agents":
      return "For any agent";
    case "people":
      return "People only";
    case "agent":
      return `For ${audience.name}`;
  }
}

export interface KnownAgent {
  readonly id: string;
  readonly name: string;
}

/**
 * Agents a person can direct a comment at: agents that wrote in this
 * design's threads, and agents here now, by name.
 */
export function knownAgents(
  comments: ReadonlyMap<string, Comment>,
  presence: ReadonlyArray<Presence>,
): ReadonlyArray<KnownAgent> {
  const agents = new Map<string, string>();
  for (const comment of comments.values()) {
    for (const { author } of comment.messages) {
      if (author.kind === "agent") agents.set(author.id, author.name);
    }
  }
  // Presence has the newest name, so it goes last.
  for (const p of presence) {
    if (p.actor.startsWith("agent:") || p.actor.startsWith("mcp:")) agents.set(p.actor, p.name);
  }
  return [...agents]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
