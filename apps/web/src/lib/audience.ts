import type { Audience, Comment, Listener, Presence } from "@/design/schema";

export const ANY_AGENT: Audience = { kind: "agents" };

/** Who a comment is for. Comments from before audiences are for any agent. */
export function audienceOf(comment: Comment): Audience {
  return comment.audience ?? ANY_AGENT;
}

/** "Any agent", "People only" or "For Designer". */
export function audienceLabel(audience: Audience): string {
  switch (audience.kind) {
    case "agents":
      return "Any agent";
    case "people":
      return "People only";
    case "agent":
      return `For ${audience.name}`;
  }
}

/**
 * Where a comment went: "With Designer" for the agent that took it, after
 * the person's pick if they made one. The agent that took it keeps it while
 * it listens, even when a person picked another agent that was away.
 */
export function routeLabel(comment: Comment): string {
  const audience = audienceOf(comment);
  const taken = comment.takenBy;
  if (audience.kind === "people" || !taken) return audienceLabel(audience);
  if (audience.kind === "agents") return `With ${taken.name}`;
  return taken.id === audience.id
    ? audienceLabel(audience)
    : `For ${audience.name}, with ${taken.name}`;
}

export interface KnownAgent {
  readonly id: string;
  readonly name: string;
}

/**
 * Agents a person can send a comment to: agents that wrote in this design's
 * threads, agents listening for comments, and agents here now, by name.
 */
export function knownAgents(
  comments: ReadonlyMap<string, Comment>,
  presence: ReadonlyArray<Presence>,
  listening: ReadonlyArray<Listener>,
): ReadonlyArray<KnownAgent> {
  const agents = new Map<string, string>();
  for (const comment of comments.values()) {
    for (const { author } of comment.messages) {
      if (author.kind === "agent") agents.set(author.id, author.name);
    }
  }
  for (const l of listening) agents.set(l.actor, l.name);
  // Presence has the newest name, so it goes last.
  for (const p of presence) {
    if (p.actor.startsWith("agent:") || p.actor.startsWith("mcp:")) agents.set(p.actor, p.name);
  }
  return [...agents]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
