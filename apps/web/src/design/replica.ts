import type { Node, Op, Snapshot } from "./schema";

/** What applying an op touched, for the renderer to patch the DOM. */
export type Applied =
  | { readonly op: "create"; readonly node: Node }
  | {
      readonly op: "delete";
      /** The deleted node's parent, or `null` if it was an artboard. */
      readonly parent: string | null;
      readonly removed: ReadonlyArray<string>;
    }
  | { readonly op: "set"; readonly node: Node; readonly key: string }
  | { readonly op: "move"; readonly node: Node; readonly from: string | null };

const byIndex = (a: Node, b: Node) =>
  a.index < b.index ? -1 : a.index > b.index ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/**
 * A client-side copy of a design's node tree. It applies the server's ops in
 * `seq` order with the same rules as `crates/design/src/document.rs`, so it
 * always matches the server's document.
 *
 * When users can edit, local ops will apply here first (optimistically) and be
 * rebased on the server's changes.
 */
export class Replica {
  readonly nodes = new Map<string, Node>();
  private readonly childIds = new Map<string | null, Set<string>>();
  seq = 0;

  load(snapshot: Snapshot) {
    this.nodes.clear();
    this.childIds.clear();
    for (const node of snapshot.nodes) this.insert(node);
    this.seq = snapshot.seq;
  }

  get(id: string): Node | undefined {
    return this.nodes.get(id);
  }

  /** Children in sibling order, or the artboards for `null`. */
  children(parent: string | null): Node[] {
    const ids = this.childIds.get(parent);
    if (!ids) return [];
    const nodes: Node[] = [];
    for (const id of ids) {
      const node = this.nodes.get(id);
      if (node) nodes.push(node);
    }
    return nodes.sort(byIndex);
  }

  artboards(): Node[] {
    return this.children(null);
  }

  /** The artboard containing `id` (or `id` itself, if it is one). */
  artboardOf(id: string): Node | undefined {
    let node = this.nodes.get(id);
    while (node?.parent) node = this.nodes.get(node.parent);
    return node;
  }

  /** Applies one op. Returns `null` when it doesn't apply, as on the server. */
  apply(op: Op): Applied | null {
    switch (op.op) {
      case "create": {
        if (this.nodes.has(op.node.id) || !this.canParent(op.node.parent)) return null;
        this.insert(op.node);
        return { op: "create", node: op.node };
      }
      case "delete": {
        const parent = this.nodes.get(op.id)?.parent ?? null;
        const removed = this.subtree(op.id);
        if (removed.length === 0) return null;
        for (const id of removed) this.remove(id);
        return { op: "delete", parent, removed };
      }
      case "set": {
        const node = this.nodes.get(op.id);
        if (!node) return null;
        const next = withProp(node, op.key, op.value);
        if (!next) return null;
        this.nodes.set(node.id, next);
        return { op: "set", node: next, key: op.key };
      }
      case "move": {
        const node = this.nodes.get(op.id);
        if (!node || !this.canParent(op.parent)) return null;
        if (op.parent === op.id || (op.parent && this.isAncestor(op.id, op.parent))) return null;
        const from = node.parent;
        this.remove(node.id);
        const moved = { ...node, parent: op.parent, index: op.index };
        this.insert(moved);
        return { op: "move", node: moved, from };
      }
    }
  }

  /** `id` and its descendants, parents first. */
  subtree(id: string): string[] {
    if (!this.nodes.has(id)) return [];
    const out: string[] = [];
    const stack = [id];
    while (stack.length > 0) {
      const next = stack.pop()!;
      out.push(next);
      for (const child of this.childIds.get(next) ?? []) stack.push(child);
    }
    return out;
  }

  private canParent(parent: string | null) {
    return parent === null || this.nodes.get(parent)?.type === "element";
  }

  private isAncestor(ancestor: string, id: string) {
    let current = this.nodes.get(id)?.parent ?? null;
    while (current !== null) {
      if (current === ancestor) return true;
      current = this.nodes.get(current)?.parent ?? null;
    }
    return false;
  }

  private insert(node: Node) {
    this.nodes.set(node.id, node);
    let siblings = this.childIds.get(node.parent);
    if (!siblings) this.childIds.set(node.parent, (siblings = new Set()));
    siblings.add(node.id);
  }

  private remove(id: string) {
    const node = this.nodes.get(id);
    if (!node) return;
    this.nodes.delete(id);
    this.childIds.get(node.parent)?.delete(id);
  }
}

/** A copy of `node` with one property changed, or `null` if it already had that value. */
function withProp(node: Node, key: string, raw: string | number | null): Node | null {
  const str = typeof raw === "string" ? raw : null;
  const num = typeof raw === "number" ? raw : null;
  const record = (map: Readonly<Record<string, string>>, name: string) => {
    if ((map[name] ?? null) === str) return null;
    const next = { ...map };
    if (str === null) delete next[name];
    else next[name] = str;
    return next;
  };
  switch (key) {
    case "name":
      return node.name === str ? null : { ...node, name: str };
    case "text":
      return node.text === str ? null : { ...node, text: str };
    case "x":
      return node.x === num ? null : { ...node, x: num };
    case "y":
      return node.y === num ? null : { ...node, y: num };
  }
  if (key.startsWith("style:")) {
    const styles = record(node.styles, key.slice(6));
    return styles && { ...node, styles };
  }
  if (key.startsWith("attr:")) {
    const attrs = record(node.attrs, key.slice(5));
    return attrs && { ...node, attrs };
  }
  return null;
}
