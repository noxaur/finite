import type { Frame, HitElement, LayerNode, Loc } from "@finite/protocol";
import { keyOf, type SelectionItem } from "./selection";

/** The ancestors of the `index`th rendered `loc` in a layer tree, nearest first. */
export function pathIn(layers: readonly LayerNode[], loc: Loc, index: number): HitElement[] | null {
  const walk = (nodes: readonly LayerNode[], up: HitElement[]): HitElement[] | null => {
    for (const n of nodes) {
      if (n.loc === loc && n.index === index) return up;
      const found = walk(n.children, [{ loc: n.loc, rev: n.rev, tag: n.tag }, ...up]);
      if (found) return found;
    }
    return null;
  };
  return walk(layers, []);
}

/** A node's children in a layer tree, found by the parent's loc and index; the top level for `null`. */
export function childrenIn(
  layers: readonly LayerNode[],
  parent: { loc: Loc; index: number } | null,
): LayerNode[] | null {
  if (!parent) return [...layers];
  for (const n of layers) {
    if (n.loc === parent.loc && n.index === parent.index) return n.children;
    const found = childrenIn(n.children, parent);
    if (found) return found;
  }
  return null;
}

export type LayerRow = {
  key: string;
  item: SelectionItem;
  name: string;
  depth: number;
  /** `null` when it has no children to open. */
  open: boolean | null;
};

/**
 * The rows the tree shows: each frame, and under an open one the stamped elements its bridge
 * reports, as deep as they're open. A frame's own layers come from `layers[frameId]`.
 */
export function layerRows(
  frames: readonly Pick<Frame, "id" | "name">[],
  layers: Readonly<Record<string, readonly LayerNode[]>>,
  opened: ReadonlySet<string>,
): LayerRow[] {
  const rows: LayerRow[] = [];
  const walk = (frameId: string, nodes: readonly LayerNode[], depth: number) => {
    for (const n of nodes) {
      const item = { frameId, loc: n.loc, index: n.index, name: n.name || n.tag };
      const key = keyOf(item);
      const open = n.children.length === 0 ? null : opened.has(key);
      rows.push({ key, item, name: n.name || n.tag, depth, open });
      if (open) walk(frameId, n.children, depth + 1);
    }
  };
  for (const f of frames) {
    const open = opened.has(f.id);
    rows.push({ key: f.id, item: { frameId: f.id, name: f.name }, name: f.name, depth: 0, open });
    if (open) walk(f.id, layers[f.id] ?? [], 1);
  }
  return rows;
}
