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

/** The open-state key of a run of same-loc siblings (a `.map()`), shown as one "Card ×3" row. */
export const groupKeyOf = (frameId: string, loc: Loc) => `${frameId}|${loc}|×`;

/**
 * The rows the tree shows: each frame, and under an open one the stamped elements its bridge
 * reports, as deep as they're open. A frame's own layers come from `layers[frameId]`. Siblings
 * rendered from one loc collapse into a single row with their count until it's opened.
 */
export function layerRows(
  frames: readonly Pick<Frame, "id" | "name">[],
  layers: Readonly<Record<string, readonly LayerNode[]>>,
  opened: ReadonlySet<string>,
): LayerRow[] {
  const rows: LayerRow[] = [];
  const node = (frameId: string, n: LayerNode, depth: number, parentFile: string | undefined) => {
    const name = layerName(n, parentFile);
    const item = { frameId, loc: n.loc, index: n.index, name };
    const key = keyOf(item);
    const open = n.children.length === 0 ? null : opened.has(key);
    rows.push({ key, item, name, depth, open });
    if (open) walk(frameId, n.children, depth + 1, fileOf(n.loc));
  };
  const walk = (
    frameId: string,
    nodes: readonly LayerNode[],
    depth: number,
    parentFile: string | undefined,
  ) => {
    for (let i = 0; i < nodes.length;) {
      const first = nodes[i]!;
      let end = i + 1;
      while (end < nodes.length && nodes[end]!.loc === first.loc) end++;
      const run = nodes.slice(i, end);
      i = end;
      if (run.length === 1) {
        node(frameId, first, depth, parentFile);
        continue;
      }
      const key = groupKeyOf(frameId, first.loc);
      const open = opened.has(key);
      const name = layerName(first, parentFile);
      const item = { frameId, loc: first.loc, index: first.index, name };
      rows.push({ key, item, name: `${name} ×${run.length}`, depth, open });
      if (open) for (const n of run) node(frameId, n, depth + 1, parentFile);
    }
  };
  for (const f of frames) {
    const open = opened.has(f.id);
    rows.push({ key: f.id, item: { frameId: f.id, name: f.name }, name: f.name, depth: 0, open });
    if (open) walk(f.id, layers[f.id] ?? [], 1, undefined);
  }
  return rows;
}

/** `src/App.tsx:12:4` → `src/App.tsx`. */
const fileOf = (loc: Loc) => loc.replace(/:\d+:\d+$/, "");

const TAG_NAMES: Readonly<Record<string, string>> = {
  nav: "Nav",
  main: "Main",
  header: "Header",
  footer: "Footer",
  aside: "Sidebar",
  section: "Section",
  article: "Article",
  form: "Form",
  button: "Button",
  a: "Link",
  img: "Image",
  svg: "Icon",
  input: "Input",
  textarea: "Text field",
  select: "Select",
  ul: "List",
  ol: "List",
  li: "Item",
  table: "Table",
  h1: "Heading",
  h2: "Heading",
  h3: "Heading",
  h4: "Heading",
  h5: "Heading",
  h6: "Heading",
  p: "Paragraph",
};

/**
 * What a layer row says. The bridge's name (`data-name`, label or text) when it found one;
 * otherwise the component it's the root of, when it comes from another file than its parent
 * (`Card`); otherwise what its tag means (`Nav`, `Button`), or the bare tag.
 */
export function layerName(n: Pick<LayerNode, "loc" | "tag" | "name">, parentFile?: string): string {
  if (n.name && n.name !== n.tag) return n.name;
  const file = fileOf(n.loc);
  if (file !== parentFile) {
    const parts = file.split("/");
    let base = parts.at(-1)!.replace(/\.[^.]+$/, "");
    if (base === "index" || base === "route" || base === "page") base = parts.at(-2) ?? base;
    if (/^[A-Za-z]/.test(base)) return base[0]!.toUpperCase() + base.slice(1);
  }
  return TAG_NAMES[n.tag] ?? n.tag;
}

/**
 * The layer name of the `index`th rendered `loc`, as its row in the layers panel says it, or
 * null when the tree doesn't have it.
 */
export function layerNameAt(layers: readonly LayerNode[], loc: Loc, index: number): string | null {
  const walk = (nodes: readonly LayerNode[], parentFile: string | undefined): string | null => {
    for (const n of nodes) {
      if (n.loc === loc && n.index === index) return layerName(n, parentFile);
      const found = walk(n.children, fileOf(n.loc));
      if (found !== null) return found;
    }
    return null;
  };
  return walk(layers, undefined);
}
