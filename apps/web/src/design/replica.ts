import type { Node, Op, Snapshot, TokenValues, UserEdit } from "./schema";
import { designModel, type WasmDocument } from "./wasm";

/** What a node is to components, from `components::info` in Rust. */
export interface ComponentInfo {
  /** The instance the node is in, or is. */
  readonly instance: string | null;
  /** The component that instance shows, or the one the node is part of. */
  readonly component: string | null;
  readonly componentName: string | null;
  /** How many instances the component has. */
  readonly instances: number;
}

/** The real node an id stands for: itself, or the instance a virtual id is shown in. */
export function realId(id: string): string {
  const at = id.indexOf("/");
  return at < 0 ? id : id.slice(0, at);
}

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
  /** A token or mode changed; `Replica.tokens` has the new table. */
  | { readonly op: "tokens" }
  /** A page was added, renamed, reordered or removed; `Replica.pages` has the new list. */
  | { readonly op: "page" };

/** The design's tokens: its modes in order, and each token's values by mode id. */
export interface TokenTable {
  readonly modes: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  readonly tokens: Readonly<Record<string, TokenValues>>;
}

/** A page as the viewer lists it. */
export interface PageEntry {
  readonly id: string;
  readonly name: string;
}

/**
 * A prototype's routes and links (`flow::Flow` in Rust). A link is an
 * element's `data-to`, naming an artboard; a route groups the artboards
 * whose `data-route` match, one per width.
 */
export interface Flow {
  readonly routes: ReadonlyArray<{
    readonly path: string;
    readonly explicit: boolean;
    readonly screens: ReadonlyArray<{ readonly artboard: string; readonly width: number | null }>;
  }>;
  readonly links: ReadonlyArray<{
    readonly element: string;
    readonly from: string;
    readonly to: string;
    readonly route: string;
  }>;
  readonly broken: ReadonlyArray<{
    readonly element: string;
    readonly from: string;
    readonly to: string;
    readonly notArtboard: boolean;
  }>;
  readonly badRoutes: ReadonlyArray<{ readonly artboard: string; readonly route: string }>;
}

/** What a call on the tab's own edits did, besides patching the document. */
export interface LocalOutcome {
  /** Why the edits asked for couldn't be planned, like a move inside an instance. */
  readonly error: string | null;
  /** The tab's mutations that no longer plan after a change, so they were dropped. */
  readonly dropped: ReadonlyArray<number>;
  /** Why the gesture's draft no longer plans after a change, like its node being deleted. */
  readonly draftLost: string | null;
}

/** `Outcome` in `crates/wasm/src/replica.rs`. */
interface RawOutcome {
  readonly patches: ReadonlyArray<{ readonly op: Op; readonly touched: Touched }>;
  readonly error?: string;
  readonly dropped?: number[];
  readonly draftLost?: string;
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
  | { readonly op: "css" }
  | { readonly op: "token" }
  | { readonly op: "mode" }
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
 * A person's own edits apply here before the server confirms them: the
 * gesture in progress as a draft, then each sent mutation until its change
 * comes back. The Rust side takes them off before each server change and
 * plans them again on top (`draft`, `propose`, `receive`, `settle`), and
 * says which ops that applied, so the cache follows as it does for changes.
 */
export class Replica {
  readonly nodes = new Map<string, Node>();
  /** Each parent's children (`null` for artboards), for parents that have any. */
  private readonly childIds = new Map<string | null, string[]>();
  /** Where `find` last found an id, so a run of nearby edits doesn't rescan the list. */
  private lastFound = 0;
  private readonly doc: WasmDocument = designModel().newDocument();
  seq = 0;
  /** The design's tokens and modes, which every artboard renders with. */
  tokens: TokenTable = { modes: [], tokens: {} };
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
    // Loading clears the pages, tokens and modes, so set them as the server would.
    this.applyAll([
      ...Object.entries(snapshot.pages ?? {}).map(([id, page]) => ({
        op: "page" as const,
        id,
        page,
      })),
      ...Object.entries(snapshot.modes ?? {}).map(([id, mode]) => ({
        op: "mode" as const,
        id,
        mode,
      })),
      ...Object.entries(snapshot.tokens ?? {}).flatMap(([name, values]) =>
        Object.entries(values).map(([modeId, value]) => ({
          op: "token" as const,
          name,
          modeId,
          value,
        })),
      ),
    ]);
    this.pages = JSON.parse(this.doc.pages()) as PageEntry[];
    this.tokens = JSON.parse(this.doc.tokens()) as TokenTable;
  }

  /** The id of the page an artboard is on: its own page if that exists, else the first page. */
  pageOf(board: Node): string {
    const { page } = board;
    return page !== undefined && this.pages.some((p) => p.id === page) ? page : this.pages[0]!.id;
  }

  /** The id of the mode an artboard renders in: its own mode if that exists, else the first mode. */
  modeOf(board: Node): string {
    const { mode } = board;
    const { modes } = this.tokens;
    return mode !== undefined && modes.some((m) => m.id === mode) ? mode : (modes[0]?.id ?? "");
  }

  /** Artboard `id`'s tokens in its mode, as a `<style>`'s text; empty without tokens. */
  tokenStyle(id: string, shadow: boolean): string {
    return this.doc.tokenStyle(id, shadow);
  }

  /** The design's routes, links and broken links. */
  flow(): Flow {
    return JSON.parse(this.doc.flow()) as Flow;
  }

  /**
   * The artboard a link to `to` opens from a screen `width` pixels wide: the
   * one on `to`'s route closest to that width. `undefined` when `to` isn't an artboard.
   */
  flowTarget(to: string, width: number | null): string | undefined {
    return this.doc.flowTarget(to, width) || undefined;
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

  /**
   * The artboard containing `id` (or `id` itself, if it is one). A node
   * inside an instance (`instance/node`) is on its instance's artboard.
   */
  artboardOf(id: string): Node | undefined {
    let node = this.nodes.get(realId(id));
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

  /**
   * Instance `id` as it renders: its root, with its component's tag and
   * styles and its overrides applied, then what's inside it, parents
   * first. Nodes inside have virtual ids (`instance/node`). Empty if `id`
   * isn't an instance.
   */
  expand(id: string): Node[] {
    return JSON.parse(this.doc.expand(id)) as Node[];
  }

  /** The instances whose content changed since the last call, to draw again. */
  takeDirty(): string[] {
    return JSON.parse(this.doc.takeDirty()) as string[];
  }

  /** The instance a node is shown in and its component, or the component it's part of. */
  componentInfo(id: string): ComponentInfo | null {
    return JSON.parse(this.doc.componentInfo(id)) as ComponentInfo | null;
  }

  /** Whether the tab has a draft, or mutations the server hasn't answered. */
  get hasLocal(): boolean {
    return this.doc.hasLocal();
  }

  /** Names the tab in its stamps, so new nodes get the ids the server will give them. */
  setClient(client: string) {
    this.doc.setClient(client);
  }

  /**
   * Replaces the gesture's draft with `edits`, planned as the server would,
   * or clears it. `seed` is the mutation id it will be sent as.
   */
  draft(
    seed: number,
    edits: ReadonlyArray<UserEdit> | null,
    each?: (applied: Applied) => void,
  ): LocalOutcome {
    return this.follows(this.doc.draft(seed, JSON.stringify(edits)), each);
  }

  /** Makes `edits` the tab's mutation `mid`. When they're the draft's, nothing changes on screen. */
  propose(
    mid: number,
    edits: ReadonlyArray<UserEdit>,
    each?: (applied: Applied) => void,
  ): LocalOutcome {
    return this.follows(this.doc.propose(mid, JSON.stringify(edits)), each);
  }

  /**
   * Applies a server change. `mine` is its mutation id when this tab sent
   * it. Without edits of its own, this is `applyAll`.
   */
  receive(
    ops: ReadonlyArray<Op>,
    mine: number | null,
    each?: (applied: Applied) => void,
  ): LocalOutcome {
    if (!this.hasLocal) {
      this.applyAll(ops, each);
      return { error: null, dropped: [], draftLost: null };
    }
    return this.follows(this.doc.receive(JSON.stringify(ops), mine ?? 0), each);
  }

  /** Drops mutation `mid`, which the server answered without a change. */
  settle(mid: number, each?: (applied: Applied) => void): LocalOutcome {
    return this.follows(this.doc.settle(mid), each);
  }

  /** Brings the cache up to date with what a local-layer call applied. */
  private follows(json: string, each?: (applied: Applied) => void): LocalOutcome {
    const outcome = JSON.parse(json) as RawOutcome;
    for (const { op, touched } of outcome.patches) {
      const applied = this.follow(op, touched);
      if (applied) each?.(applied);
    }
    return {
      error: outcome.error ?? null,
      dropped: outcome.dropped ?? [],
      draftLost: outcome.draftLost ?? null,
    };
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
      // The old shared CSS draws nothing, but refreshing the tokens is harmless.
      case "css":
      case "token":
      case "mode":
        this.tokens = JSON.parse(this.doc.tokens()) as TokenTable;
        return { op: "tokens" };
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
