import { type Replica, realId } from "../replica";
import type { Node, UserEdit } from "../schema";
import type { DocChange } from "../session";

/** Elements people don't see as layers. */
const HIDDEN_TAGS = new Set(["style", "script", "template", "link", "meta"]);
/** Elements that can't hold other layers. */
const VOID_TAGS = new Set(["img", "input", "br", "hr", "svg", "video", "iframe", "picture"]);
/** Search stops after this many matches. */
const MATCHES = 200;

export type LayerIcon =
  | "artboard"
  | "component"
  | "text"
  | "image"
  | "grid"
  | "column"
  | "row"
  | "button"
  | "box";

/** A layer's icon, from what the document says about it. */
export function iconOf(node: Node): LayerIcon {
  if (node.parent === null) return "artboard";
  if (node.component || node.instanceOf !== undefined) return "component";
  if (node.type === "text") return "text";
  if (node.tag === "img" || node.tag === "svg" || node.tag === "picture") return "image";
  if (node.tag === "button") return "button";
  const display = node.styles.display ?? "";
  if (display.includes("grid")) return "grid";
  if (display.includes("flex")) {
    return (node.styles["flex-direction"] ?? "").startsWith("column") ? "column" : "row";
  }
  return "box";
}

/** What a row shows. The same object until the node changes, so rows can skip rendering. */
export interface RowFacts {
  readonly id: string;
  readonly label: string;
  readonly icon: LayerIcon;
  /** A component or an instance, drawn in the component color. */
  readonly part: boolean;
  /** Inside an instance: shown, but its component owns it. */
  readonly virtual: boolean;
  /** Can take other layers dropped into it. */
  readonly container: boolean;
  /** The children it has rows for. A text-only element reads as its text and has none. */
  readonly kids: ReadonlyArray<string>;
  readonly hidden: boolean;
  readonly locked: boolean;
}

export interface Row {
  readonly facts: RowFacts;
  readonly depth: number;
  readonly open: boolean;
  /** The row's parent as the tree shows it, `null` for an artboard. */
  readonly parent: string | null;
  /** An ancestor is hidden or locked, so the row is too. */
  readonly hiddenBy: boolean;
  readonly lockedBy: boolean;
}

/**
 * The shown page's layers as rows, outside React. It caches what each row
 * shows and drops only what a `DocChange` touched, so a style scrub or a
 * drag on the canvas costs the tree a lookup per visible row, and only the
 * rows whose facts changed render again. Only open rows are walked.
 */
export class LayerModel {
  private readonly facts = new Map<string, RowFacts>();
  /** Each instance's expanded nodes by parent, as drawn. */
  private readonly expanded = new Map<string, Map<string, Node[]>>();
  private open = new Set<string>();
  private page: string | null = null;
  private query = "";
  private flat: ReadonlyArray<Row> = [];
  private stale = true;
  private readonly listeners = new Set<() => void>();
  /** Bumps whenever `rows()` may differ, for `useSyncExternalStore`. */
  version = 0;

  constructor(private readonly replica: Replica) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Drops what `change` made out of date. */
  apply(change: DocChange) {
    if (change.reset) {
      this.facts.clear();
    } else {
      for (const id of change.touched) this.facts.delete(id);
      // What an instance shows comes from its component, wherever that is.
      for (const id of this.facts.keys()) {
        if (id.includes("/") || this.replica.get(id)?.instanceOf !== undefined)
          this.facts.delete(id);
      }
    }
    this.expanded.clear();
    if (!change.reset && !change.structural && !change.pages && change.touched.size === 0) return;
    this.invalidate();
  }

  setPage(page: string | null) {
    if (page === this.page) return;
    this.page = page;
    this.invalidate();
  }

  setQuery(query: string) {
    const next = query.trim().toLowerCase();
    if (next === this.query) return;
    this.query = next;
    this.invalidate();
  }

  get searching(): boolean {
    return this.query !== "";
  }

  isOpen(id: string): boolean {
    return this.open.has(id);
  }

  toggle(id: string, open = !this.open.has(id)) {
    if (open === this.open.has(id)) return;
    if (open) this.open.add(id);
    else this.open.delete(id);
    this.invalidate();
  }

  /** Opens the rows down to each of `ids`. */
  reveal(ids: ReadonlyArray<string>) {
    let opened = false;
    for (const id of ids) {
      for (let node = this.node(id); node?.parent; node = this.node(node.parent)) {
        if (!this.open.has(node.parent)) {
          this.open.add(node.parent);
          opened = true;
        }
      }
    }
    if (opened) this.invalidate();
  }

  /** The rows shown now: the open part of the page's tree, or the layers matching the search. */
  rows(): ReadonlyArray<Row> {
    if (!this.stale) return this.flat;
    this.stale = false;
    const rows: Row[] = [];
    const page = this.page;
    const boards =
      page === null ? [] : this.replica.artboards().filter((b) => this.replica.pageOf(b) === page);
    if (this.query) {
      const walk = (id: string) => {
        if (rows.length >= MATCHES) return;
        const facts = this.factsOf(id);
        if (!facts) return;
        if (facts.label.toLowerCase().includes(this.query)) {
          rows.push({
            facts,
            depth: 0,
            open: false,
            parent: null,
            hiddenBy: false,
            lockedBy: false,
          });
        }
        for (const kid of facts.kids) walk(kid);
      };
      for (const board of boards) walk(board.id);
    } else {
      const walk = (
        id: string,
        depth: number,
        parent: string | null,
        hid: boolean,
        lock: boolean,
      ) => {
        const facts = this.factsOf(id);
        if (!facts) return;
        const open = facts.kids.length > 0 && this.open.has(id);
        rows.push({ facts, depth, open, parent, hiddenBy: hid, lockedBy: lock });
        if (!open) return;
        for (const kid of facts.kids) {
          walk(kid, depth + 1, id, hid || facts.hidden, lock || facts.locked);
        }
      };
      for (const board of boards) walk(board.id, 0, null, false, false);
    }
    this.flat = rows;
    return rows;
  }

  /** A node as it's drawn: a real one, or a virtual one inside an instance. */
  node(id: string): Node | undefined {
    const real = this.replica.get(id);
    if (real || !id.includes("/")) return real;
    return this.expansion(realId(id)).get(`node:${id}`)?.[0];
  }

  private factsOf(id: string): RowFacts | undefined {
    const known = this.facts.get(id);
    if (known) return known;
    const node = this.node(id);
    if (!node) return undefined;
    const all = node.type === "element" ? this.childrenOf(node) : [];
    // An element holding only text reads as that text, and has no rows under it.
    const text = all.length === 1 && all[0]!.type === "text" ? (all[0]!.text ?? "").trim() : null;
    const virtual = id.includes("/");
    const instance = node.instanceOf !== undefined;
    const facts: RowFacts = {
      id,
      label: node.name || (node.type === "text" ? node.text?.trim() : text) || node.tag || "Layer",
      icon:
        text !== null && node.parent !== null && !node.component && node.tag !== "button"
          ? "text"
          : iconOf(node),
      part: Boolean(node.component) || instance,
      virtual,
      container: node.type === "element" && !virtual && !instance && !VOID_TAGS.has(node.tag ?? ""),
      kids: text === null ? all.map((n) => n.id) : [],
      hidden: node.attrs[HIDDEN_ATTR] !== undefined,
      locked: node.attrs[LOCKED_ATTR] !== undefined,
    };
    this.facts.set(id, facts);
    return facts;
  }

  /** A node's children as drawn: an instance's come from its component. */
  private childrenOf(node: Node): Node[] {
    const kids =
      node.instanceOf !== undefined || node.id.includes("/")
        ? (this.expansion(realId(node.id)).get(node.id) ?? [])
        : this.replica.children(node.id);
    return kids.filter((n) =>
      n.type === "text" ? Boolean(n.text?.trim()) : !HIDDEN_TAGS.has(n.tag ?? ""),
    );
  }

  /** Instance `root` expanded once per change: its nodes by parent, and each by `node:<id>`. */
  private expansion(root: string): Map<string, Node[]> {
    let byParent = this.expanded.get(root);
    if (byParent) return byParent;
    byParent = new Map();
    for (const n of this.replica.expand(root)) {
      byParent.set(`node:${n.id}`, [n]);
      if (n.parent === null) continue;
      const siblings = byParent.get(n.parent);
      if (siblings) siblings.push(n);
      else byParent.set(n.parent, [n]);
    }
    this.expanded.set(root, byParent);
    return byParent;
  }

  private invalidate() {
    this.stale = true;
    this.version++;
    for (const listener of this.listeners) listener();
  }
}

/** Where dragged layers land, and how the list draws it. */
export interface Drop {
  readonly parent: string | null;
  readonly before: string | null;
  /** The row the line is drawn at, or the row outlined for a drop into it. */
  readonly row: number;
  readonly edge: "before" | "after" | "inside";
  /** The indent the line is drawn at. */
  readonly depth: number;
}

/**
 * Where layers dragged over row `index` land, `fraction` of the way down
 * it, with the pointer over indent `level`. A container's top quarter
 * drops before it, its middle into it as the last child, and its bottom
 * quarter after it; other rows split in half. After an open row is before
 * its first child. Below the last child of nested layers, `level` picks
 * which of them it goes after, as in Figma. `null`: it can't go there,
 * like into itself or into an instance, whose component owns its layers.
 */
export function dropAt(
  rows: ReadonlyArray<Row>,
  index: number,
  fraction: number,
  level: number,
  dragged: ReadonlySet<string>,
): Drop | null {
  const row = rows[index];
  if (!row) return null;
  const { facts } = row;
  const zone = facts.container
    ? fraction < 0.25
      ? "before"
      : fraction > 0.75
        ? "after"
        : "inside"
    : fraction < 0.5
      ? "before"
      : "after";
  const byId = new Map(rows.map((r) => [r.facts.id, r]));
  let drop: Drop;
  if (zone === "before") {
    drop = { parent: row.parent, before: facts.id, row: index, edge: "before", depth: row.depth };
  } else if (zone === "inside") {
    drop = { parent: facts.id, before: null, row: index, edge: "inside", depth: row.depth + 1 };
  } else if (row.open) {
    drop = {
      parent: facts.id,
      before: facts.kids[0] ?? null,
      row: index,
      edge: "after",
      depth: row.depth + 1,
    };
  } else {
    // The boundary below this row closes every level down to the next row's.
    const next = rows[index + 1];
    const depth = Math.min(Math.max(level, next?.depth ?? 0), row.depth);
    let at: Row = row;
    while (at.depth > depth && at.parent !== null) at = byId.get(at.parent) ?? at;
    drop = {
      parent: at.parent,
      before: next && next.depth === at.depth ? next.facts.id : null,
      row: index,
      edge: "after",
      depth: at.depth,
    };
  }
  // Never into a dragged layer or what's inside it, nor among an instance's layers.
  for (let id = drop.parent; id !== null; id = byId.get(id)?.parent ?? null) {
    if (dragged.has(id)) return null;
  }
  const parent = drop.parent === null ? undefined : byId.get(drop.parent);
  if (parent && !parent.facts.container) return null;
  return drop;
}

/**
 * The edit that drops `ids` at `drop`. Text can't become an artboard, and
 * an anchor that's being dragged gives way to the next sibling that isn't.
 */
export function dropEdit(
  replica: Replica,
  ids: ReadonlyArray<string>,
  drop: Drop,
): UserEdit | null {
  const moving = new Set(ids);
  if (drop.parent === null && ids.some((id) => replica.get(id)?.type === "text")) return null;
  let before = drop.before;
  if (before !== null && moving.has(before)) {
    before = null;
    for (const sibling of replica.siblingsAfter(drop.before!)) {
      if (!moving.has(sibling.id)) {
        before = sibling.id;
        break;
      }
    }
  }
  return { kind: "place", ids: [...ids], parent: drop.parent, before };
}

/**
 * The layers a drag from `grabbed` moves: the selection when it's in it,
 * else just that row. Only the outermost of nested ones, in the order the
 * rows show them, since `place` keeps the order it's given.
 */
export function draggedLayers(
  rows: ReadonlyArray<Row>,
  grabbed: string,
  selection: ReadonlyArray<string>,
): string[] {
  const picked = new Set(selection.includes(grabbed) ? selection : [grabbed]);
  const byId = new Map(rows.map((r) => [r.facts.id, r]));
  const inPicked = (row: Row) => {
    for (let id = row.parent; id !== null; id = byId.get(id)?.parent ?? null) {
      if (picked.has(id)) return true;
    }
    return false;
  };
  const shown = rows.filter((r) => picked.has(r.facts.id) && !inPicked(r)).map((r) => r.facts.id);
  // A selected layer under a closed row isn't shown, but still moves, last.
  const rest = [...picked].filter((id) => !byId.has(id));
  return [...shown, ...rest].filter((id) => !id.includes("/"));
}

/** The attributes that hide a layer and lock it, as the server and the exports spell them. */
export const HIDDEN_ATTR = "hidden";
export const LOCKED_ATTR = "data-locked";
export type FlagAttr = typeof HIDDEN_ATTR | typeof LOCKED_ATTR;

/** Hides or locks `ids`, or shows or unlocks them when every one already is. */
export function toggleFlag(
  nodeOf: (id: string) => Node | undefined,
  ids: ReadonlyArray<string>,
  attr: FlagAttr,
): UserEdit {
  const all = ids.every((id) => nodeOf(id)?.attrs[attr] !== undefined);
  return { kind: "setAttributes", ids: [...ids], attrs: { [attr]: all ? null : "" } };
}
