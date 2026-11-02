import type { Node, Op, Snapshot } from "./schema";
import { designModel, type WasmDocument } from "./wasm";

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
  | { readonly op: "move"; readonly node: Node; readonly from: string | null }
  | { readonly op: "css"; readonly css: string | null }
  /** A page was added, renamed, reordered or removed; `Replica.pages` has the new list. */
  | { readonly op: "page" };

/** A page as the viewer lists it. */
export interface PageEntry {
  readonly id: string;
  readonly name: string;
}

/** What the Rust `Replica` in `crates/wasm` says an op touched (`null`: it didn't apply). */
type Touched =
  | { readonly op: "create"; readonly before: string | null }
  | { readonly op: "delete"; readonly parent: string | null; readonly removed: string[] }
  | { readonly op: "set"; readonly node: Node }
  | {
      readonly op: "move";
      readonly node: Node;
      readonly from: string | null;
      readonly before: string | null;
    }
  | { readonly op: "css"; readonly css: string | null }
  | { readonly op: "page" }
  | null;

/**
 * A client-side copy of a design's node tree. The document itself lives in
 * WebAssembly: `crates/wasm` runs the server's own `Document::apply`, so
 * every op follows the same rules as on the server.
 *
 * Next to it, this class keeps a read cache for the renderer: each node by
 * id, and each parent's children ids in sibling order. It changes the cache
 * only as the Rust side reports: loading returns the sibling order, and a
 * create or move says which sibling the node now sits before. So the cache
 * never compares indexes itself.
 *
 * A whole change crosses into WebAssembly in one call (`applyAll`). The
 * cache then catches up one op at a time, so a caller that patches the DOM
 * after each op reads the tree as it was right after that op.
 *
 * When users can edit, local ops will apply here first (optimistically) and be
 * rebased on the server's changes.
 */
export class Replica {
  readonly nodes = new Map<string, Node>();
  /** Each parent's children (`null` for artboards), for parents that have any. */
  private readonly childIds = new Map<string | null, string[]>();
  /** Where `find` last found an id, so a run of nearby edits doesn't rescan the list. */
  private lastFound = 0;
  private readonly doc: WasmDocument = designModel().newDocument();
  seq = 0;
  /** The design's shared CSS, which every artboard renders with. */
  css: string | null = null;
  /** The pages in order, never empty: a design without pages has its implicit first page. */
  pages: ReadonlyArray<PageEntry> = [];

  load(snapshot: Snapshot) {
    const order = JSON.parse(this.doc.load(JSON.stringify(snapshot.nodes))) as ReadonlyArray<
      [string | null, string[]]
    >;
    this.nodes.clear();
    this.childIds.clear();
    for (const node of snapshot.nodes) this.nodes.set(node.id, node);
    for (const [parent, ids] of order) this.childIds.set(parent, ids);
    this.seq = snapshot.seq;
    // Loading clears the stylesheet and pages, so set them as the server would.
    this.css = null;
    this.applyAll([
      { op: "css", css: snapshot.css ?? null },
      ...Object.entries(snapshot.pages ?? {}).map(([id, page]) => ({
        op: "page" as const,
        id,
        page,
      })),
    ]);
    this.pages = JSON.parse(this.doc.pages()) as PageEntry[];
  }

  /** The id of the page an artboard is on: its own page if that exists, else the first page. */
  pageOf(board: Node): string {
    const { page } = board;
    return page !== undefined && this.pages.some((p) => p.id === page) ? page : this.pages[0]!.id;
  }

  /** Frees the WebAssembly side. The replica can't be used afterwards. */
  free() {
    this.doc.free();
  }

  get(id: string): Node | undefined {
    return this.nodes.get(id);
  }

  /** Children in sibling order, or the artboards for `null`. */
  children(parent: string | null): Node[] {
    return (this.childIds.get(parent) ?? []).map((id) => this.nodes.get(id)!);
  }

  /** The siblings after `id`, in order. */
  *siblingsAfter(id: string): Generator<Node> {
    const node = this.nodes.get(id);
    const siblings = node && this.childIds.get(node.parent);
    if (!siblings) return;
    for (let i = this.find(siblings, id) + 1; i < siblings.length; i++) {
      yield this.nodes.get(siblings[i]!)!;
    }
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

  /** `id` and its descendants, parents first. */
  subtree(id: string): string[] {
    if (!this.nodes.has(id)) return [];
    const out: string[] = [];
    const stack = [id];
    while (stack.length > 0) {
      const next = stack.pop()!;
      out.push(next);
      for (const child of this.children(next)) stack.push(child.id);
    }
    return out;
  }

  /** The subtree at `id` as HTML, as screenshots render it. With `ids`, elements carry `data-finite-id`. */
  exportHtml(id: string, ids = false): string {
    return this.doc.exportHtml(id, ids);
  }

  /** Applies one op. Returns `null` when it doesn't apply, as on the server. */
  apply(op: Op): Applied | null {
    return this.applyAll([op])[0] ?? null;
  }

  /**
   * Applies `ops` in order in one call into WebAssembly, then brings the
   * cache up to date op by op. `each` runs after each op that applied, with
   * the cache as it was right then. Returns what each op touched.
   */
  applyAll(ops: ReadonlyArray<Op>, each?: (applied: Applied) => void): Array<Applied | null> {
    if (ops.length === 0) return [];
    const touched = JSON.parse(this.doc.apply(JSON.stringify(ops))) as ReadonlyArray<Touched>;
    return ops.map((op, i) => {
      const applied = this.follow(op, touched[i] ?? null);
      if (applied) each?.(applied);
      return applied;
    });
  }

  /** Updates the cache for one op the Rust side applied. */
  private follow(op: Op, touched: Touched): Applied | null {
    if (touched === null) return null;
    if (touched.op !== op.op) throw new Error(`finite.wasm answered ${touched.op} for ${op.op}`);
    switch (touched.op) {
      case "create": {
        // The op's node is what Rust inserted.
        const { node } = op as Extract<Op, { op: "create" }>;
        this.nodes.set(node.id, node);
        this.link(node, touched.before);
        return { op: "create", node };
      }
      case "delete": {
        const [root] = touched.removed;
        if (root !== undefined) this.unlink(root);
        for (const id of touched.removed) {
          this.nodes.delete(id);
          this.childIds.delete(id);
        }
        return { op: "delete", parent: touched.parent, removed: touched.removed };
      }
      case "set":
        this.nodes.set(touched.node.id, touched.node);
        return { op: "set", node: touched.node, key: (op as Extract<Op, { op: "set" }>).key };
      case "move":
        this.unlink(touched.node.id);
        this.nodes.set(touched.node.id, touched.node);
        this.link(touched.node, touched.before);
        return { op: "move", node: touched.node, from: touched.from };
      case "css":
        this.css = touched.css;
        return { op: "css", css: touched.css };
      case "page":
        this.pages = JSON.parse(this.doc.pages()) as PageEntry[];
        return { op: "page" };
    }
  }

  /** Puts `node` among its siblings, before `before` or last. */
  private link(node: Node, before: string | null) {
    let siblings = this.childIds.get(node.parent);
    if (!siblings) this.childIds.set(node.parent, (siblings = []));
    const at = before === null ? siblings.length : this.find(siblings, before);
    siblings.splice(at < 0 ? siblings.length : at, 0, node.id);
    this.lastFound = at < 0 ? siblings.length - 1 : at;
  }

  /** Takes `id` out of its siblings. */
  private unlink(id: string) {
    const node = this.nodes.get(id);
    const siblings = node && this.childIds.get(node.parent);
    if (!siblings) return;
    const at = this.find(siblings, id);
    if (at >= 0) siblings.splice(at, 1);
    if (siblings.length === 0) this.childIds.delete(node.parent);
  }

  /**
   * Where `id` is in `siblings`, or -1. Writes and deletes tend to work
   * through siblings in order, so it searches forward from the last hit
   * first: writing thousands of siblings doesn't scan the list each time.
   */
  private find(siblings: ReadonlyArray<string>, id: string): number {
    let at = siblings.indexOf(id, Math.max(0, this.lastFound - 1));
    if (at < 0) at = siblings.indexOf(id);
    if (at >= 0) this.lastFound = at;
    return at;
  }
}
