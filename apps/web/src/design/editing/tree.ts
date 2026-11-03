import { type Replica, realId } from "../replica";
import type { Node } from "../schema";

/** A node as it's drawn: a real one, or a virtual one inside an instance (`instance/node`). */
export function nodeOf(replica: Replica, id: string): Node | undefined {
  const real = replica.get(id);
  if (real || !id.includes("/")) return real;
  return replica.expand(realId(id)).find((n) => n.id === id);
}

/** `id`, then its parent, and so on up to its artboard. */
export function lineage(replica: Replica, id: string): string[] {
  const out: string[] = [];
  for (let node = nodeOf(replica, id); node;) {
    out.push(node.id);
    node = node.parent === null ? undefined : nodeOf(replica, node.parent);
  }
  return out;
}
