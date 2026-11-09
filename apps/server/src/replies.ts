import { randomUUID } from "node:crypto";
import { REPLY_KEPT_MS, type Reply, type ServerMessage } from "@finite/protocol";

const MAX_KEPT = 1000;

type Asker = { send(message: ServerMessage): void };

/**
 * The replies to recent `once` requests, which is what makes asking again safe. A request id is
 * new, running or answered. Replies leave after {@link REPLY_KEPT_MS}, and sooner if there are
 * too many; a running request is never forgotten.
 */
export function createReplyMemory(now: () => number = Date.now, maxKept = MAX_KEPT) {
  const running = new Map<string, Set<Asker>>();
  // In the order they finished, so the oldest is first.
  const kept = new Map<string, { reply: Reply; at: number }>();
  let name = randomUUID();

  function dropExpired() {
    for (const [rid, { at }] of kept) {
      if (now() - at < REPLY_KEPT_MS) return;
      kept.delete(rid);
    }
  }

  return {
    name: () => name,

    /** The stored reply, `"running"`, or nothing when the caller should run it now. */
    ask(rid: string, asker: Asker): Reply | "running" | undefined {
      dropExpired();
      const done = kept.get(rid);
      if (done) return done.reply;
      const askers = running.get(rid);
      if (askers) {
        askers.add(asker);
        return "running";
      }
      running.set(rid, new Set([asker]));
      return undefined;
    },

    /** Stores the reply and sends it to everyone who asked while it ran. */
    finish(rid: string, reply: Reply) {
      const askers = running.get(rid);
      running.delete(rid);
      kept.set(rid, { reply, at: now() });
      dropExpired();
      if (kept.size > maxKept) {
        kept.delete(kept.keys().next().value!);
        // Age is safe (the page stops asking first), but this reply was forgotten early.
        name = randomUUID();
      }
      for (const asker of askers ?? []) asker.send(reply);
    },
  };
}
