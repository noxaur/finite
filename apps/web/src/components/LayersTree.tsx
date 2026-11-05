"use client";

import * as stylex from "@stylexjs/stylex";
import { useEffect, useRef, useState } from "react";
import type { Editor } from "@/design/editing/editor";
import { lineage, nodeOf } from "@/design/editing/tree";
import { type Replica, realId } from "@/design/replica";
import type { Node } from "@/design/schema";
import { colors, radii, size, space } from "@/styles/tokens.stylex";
import { Icon, type IconName } from "./Icons";
import { iconOf } from "./Inspector";

/** Elements people don't see as layers. */
const HIDDEN = new Set(["style", "script", "template", "link", "meta"]);
/** Search stops after this many matches. */
const MATCHES = 200;

interface Row {
  readonly node: Node;
  readonly depth: number;
  readonly label: string;
  readonly icon: IconName;
  readonly parent: boolean;
}

/**
 * A node's children as drawn: an instance's come from its component.
 * `expanded` holds each instance expanded once per render, by parent, since
 * every row inside an instance asks for its own children.
 */
function childrenOf(
  replica: Replica,
  node: Node,
  expanded: Map<string, Map<string, Node[]>>,
): Node[] {
  let kids: Node[];
  if (node.instanceOf !== undefined || node.id.includes("/")) {
    const root = realId(node.id);
    let byParent = expanded.get(root);
    if (!byParent) {
      byParent = new Map();
      for (const n of replica.expand(root)) {
        if (n.parent === null) continue;
        const siblings = byParent.get(n.parent);
        if (siblings) siblings.push(n);
        else byParent.set(n.parent, [n]);
      }
      expanded.set(root, byParent);
    }
    kids = byParent.get(node.id) ?? [];
  } else kids = replica.children(node.id);
  return kids.filter((n) => (n.type === "text" ? n.text?.trim() : !HIDDEN.has(n.tag ?? "")));
}

/** What a row shows for `node`, and whether it has rows under it. */
function rowOf(
  replica: Replica,
  node: Node,
  depth: number,
  expanded: Map<string, Map<string, Node[]>>,
): Row & { kids: Node[] } {
  const all = node.type === "element" ? childrenOf(replica, node, expanded) : [];
  // An element holding only text reads as that text, and has no rows under it.
  const text = all.length === 1 && all[0]!.type === "text" ? (all[0]!.text ?? "").trim() : null;
  const kids = text === null ? all : [];
  const label =
    node.name || (node.type === "text" ? node.text?.trim() : text) || node.tag || "Layer";
  const icon = text !== null && node.parent !== null && !node.component ? "text" : iconOf(node);
  return { node, depth, label, icon, parent: kids.length > 0, kids };
}

/**
 * The shown page's artboards and what's in them, as a tree. Only open
 * rows are walked, so a big design costs what's on screen. Clicking a row
 * selects that layer on the canvas (Shift adds it), and selecting on the
 * canvas opens the rows down to it. A query lists the matching layers on
 * the page instead.
 */
export function LayersTree({
  replica,
  editor,
  page,
  query,
  onReveal,
}: {
  replica: Replica;
  editor: Editor;
  page: string;
  query: string;
  /** Brings a layer into view on the canvas. */
  onReveal: (id: string) => void;
  /** Changes with the design, so the rows follow every edit. */
  version: number;
}) {
  const [selection, setSelection] = useState(editor.state.selection);
  useEffect(() => {
    setSelection(editor.state.selection);
    return editor.subscribe(() => setSelection(editor.state.selection));
  }, [editor]);
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const listRef = useRef<HTMLOListElement>(null);

  // Open the rows down to what's selected on the canvas, and scroll to it.
  useEffect(() => {
    const up = selection.flatMap((id) => lineage(replica, id).slice(1));
    if (up.length > 0)
      setOpen((was) => (up.every((id) => was.has(id)) ? was : new Set([...was, ...up])));
    const last = selection[selection.length - 1];
    if (last === undefined) return;
    requestAnimationFrame(() =>
      listRef.current
        ?.querySelector(`[data-layer="${CSS.escape(last)}"]`)
        ?.scrollIntoView({ block: "nearest" }),
    );
  }, [selection, replica]);

  const boards = replica.artboards().filter((b) => replica.pageOf(b) === page);
  const rows: Row[] = [];
  const expanded = new Map<string, Map<string, Node[]>>();
  const needle = query.trim().toLowerCase();
  if (needle) {
    const walk = (node: Node) => {
      if (rows.length >= MATCHES) return;
      const row = rowOf(replica, node, 0, expanded);
      if (row.label.toLowerCase().includes(needle)) rows.push({ ...row, parent: false });
      for (const kid of row.kids) walk(kid);
    };
    boards.forEach(walk);
  } else {
    const walk = (node: Node, depth: number) => {
      const row = rowOf(replica, node, depth, expanded);
      rows.push(row);
      if (open.has(node.id)) for (const kid of row.kids) walk(kid, depth + 1);
    };
    for (const board of boards) walk(board, 0);
  }

  const toggle = (id: string) =>
    setOpen((was) => {
      const next = new Set(was);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const picked = new Set(selection);

  return (
    <ol ref={listRef} aria-label="Layers" {...stylex.props(styles.list)}>
      {rows.length === 0 && (
        <li {...stylex.props(styles.empty)}>
          {needle ? "No layers match." : "No artboards on this page."}
        </li>
      )}
      {rows.map(({ node, depth, label, icon, parent }) => {
        const on = picked.has(node.id);
        return (
          <li
            key={node.id}
            data-layer={node.id}
            aria-selected={on}
            onClick={(e) => {
              const id = node.type === "text" && node.parent !== null ? node.parent : node.id;
              if (!nodeOf(replica, id)) return;
              editor.select(
                e.shiftKey
                  ? picked.has(id)
                    ? selection.filter((s) => s !== id)
                    : [...selection, id]
                  : [id],
              );
            }}
            onDoubleClick={() => onReveal(node.id)}
            title={label}
            {...stylex.props(styles.row, on && styles.rowOn)}
            style={{ paddingLeft: `calc(${depth} * 16px + 8px)` }}
          >
            <button
              type="button"
              tabIndex={-1}
              aria-label={open.has(node.id) ? "Collapse" : "Expand"}
              aria-expanded={parent ? open.has(node.id) : undefined}
              onClick={(e) => {
                e.stopPropagation();
                if (parent) toggle(node.id);
              }}
              {...stylex.props(styles.twisty, !parent && styles.hidden)}
            >
              <span {...stylex.props(styles.chevron, open.has(node.id) && styles.chevronOpen)}>
                <Icon name="next" size={10} />
              </span>
            </button>
            <span
              {...stylex.props(
                styles.icon,
                (node.component || node.instanceOf !== undefined) && styles.part,
                on && styles.iconOn,
              )}
            >
              <Icon name={icon} size={14} />
            </span>
            <span {...stylex.props(styles.name)}>{label}</span>
          </li>
        );
      })}
    </ol>
  );
}

const styles = stylex.create({
  list: {
    display: "flex",
    flexDirection: "column",
    gap: space.px,
    minHeight: 0,
    margin: 0,
    padding: 0,
    paddingBottom: space.sm,
    overflowY: "auto",
    listStyle: "none",
  },
  empty: { paddingInline: space.ms, color: colors.muted, fontSize: 12 },
  row: {
    display: "flex",
    alignItems: "center",
    gap: space.xs,
    flexShrink: 0,
    height: size.sm,
    paddingRight: space.ms,
    backgroundColor: { default: "transparent", ":hover": colors.bg },
    color: colors.text,
    cursor: "var(--cursor-pointer, pointer)",
    userSelect: "none",
  },
  rowOn: {
    backgroundColor: { default: colors.brandWash, ":hover": colors.brandWash },
    color: colors.brandText,
  },
  twisty: {
    display: "grid",
    placeItems: "center",
    width: 14,
    height: 14,
    flexShrink: 0,
    padding: 0,
    borderWidth: 0,
    borderRadius: radii.xs,
    backgroundColor: "transparent",
    color: { default: colors.faint, ":hover": colors.text },
    cursor: "var(--cursor-pointer, pointer)",
  },
  hidden: { visibility: "hidden" },
  chevron: { display: "flex", transition: "transform 200ms cubic-bezier(.23, 1, .32, 1)" },
  chevronOpen: { transform: "rotate(90deg)" },
  icon: { display: "flex", flexShrink: 0, color: colors.faint },
  part: { color: colors.component },
  iconOn: { color: colors.brandText },
  name: {
    flexGrow: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
});
