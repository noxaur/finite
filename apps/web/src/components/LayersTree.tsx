"use client";

import * as stylex from "@stylexjs/stylex";
import {
  memo,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { Editor, PanelRun } from "@/design/editing/editor";
import {
  type Drop,
  draggedLayers,
  dropAt,
  dropEdit,
  type LayerModel,
  type Row,
  type RowFacts,
  toggleFlag,
} from "@/design/editing/layers";
import type { Replica } from "@/design/replica";
import type { UserEdit } from "@/design/schema";
import { colors, radii, shadows, size, space } from "@/styles/tokens.stylex";
import { IconButton } from "./Button";
import { Icon } from "./Icons";

/** Each row's pitch: its height (`size.sm`) and the 3px gap under it, so the list can draw only the rows in view. */
const ROW = 30;
/** Each level's indent. */
const INDENT = 12;
/** How far rows sit in from the panel's sides, so their fill reads as a rounded row. */
const INSET = 6;
/** A row's left padding, inside its inset: its chevron lines up with the section labels. */
const PAD = 3;
/** Rows drawn above and below the ones in view, so a fast scroll doesn't flash. */
const OVERSCAN = 8;
/** How long a drag rests on a closed row before it opens. */
const EXPAND_MS = 500;
/** How close to the list's top or bottom a drag scrolls it. */
const EDGE = 24;

/** Where a drag over the layers drops, drawn in the list. */
type Indicator =
  | (Drop & { readonly kind: "slot" })
  | { readonly kind: "page"; readonly page: string };

/**
 * The shown page's layers, as the Layers panel in Figma: click to select
 * (Shift for a range, ⌘ to add or take one), drag to reorder or move into
 * another layer, double-click a name to rename it, and hide or lock a
 * layer from its row. Rows follow every edit as it's made, the canvas's
 * drafts included, and only rows that changed draw again.
 */
export function LayersTree({
  model,
  replica,
  editor,
  page,
  query,
  onReveal,
  onPageAt,
  onDropPage,
}: {
  model: LayerModel;
  replica: Replica;
  editor: Editor;
  page: string;
  query: string;
  /** Brings a layer into view on the canvas. */
  onReveal: (id: string) => void;
  /** The page whose row is under a page point, for dropping artboards on it. */
  onPageAt: (x: number, y: number) => string | null;
  /** Shows which page a drag would move artboards to. */
  onDropPage: (page: string | null) => void;
}) {
  model.setPage(page);
  model.setQuery(query);
  useSyncExternalStore(
    (l) => model.subscribe(l),
    () => model.version,
    () => model.version,
  );
  const rows = model.rows();
  const state = useSyncExternalStore(
    (l) => editor.subscribe(l),
    () => editor.state,
    () => editor.state,
  );
  const { selection, hover, target } = state;
  const listRef = useRef<HTMLOListElement>(null);
  const [view, setView] = useState({ top: 0, height: 600 });
  const [indicator, setIndicator] = useState<Indicator | null>(null);
  const [dragging, setDragging] = useState<ReadonlySet<string> | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  /** Where a Shift-click range starts. */
  const anchor = useRef<string | null>(null);

  // Open the rows down to what's selected on the canvas, and scroll to the last of it.
  const last = selection[selection.length - 1];
  useEffect(() => {
    model.reveal(selection);
  }, [model, selection]);
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list || last === undefined) return;
    const at = model.rows().findIndex((r) => r.facts.id === last);
    if (at < 0) return;
    const top = at * ROW;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (top + ROW > list.scrollTop + list.clientHeight)
      list.scrollTop = top + ROW - list.clientHeight;
  }, [model, last]);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const measure = () => setView({ top: list.scrollTop, height: list.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    return () => observer.disconnect();
  }, []);

  const dropPage = indicator?.kind === "page" ? indicator.page : null;
  useEffect(() => onDropPage(dropPage), [onDropPage, dropPage]);

  const picked = new Set(selection);
  const first = Math.max(0, Math.floor(view.top / ROW) - OVERSCAN);
  const end = Math.min(rows.length, Math.ceil((view.top + view.height) / ROW) + OVERSCAN);

  /** Picks a row the way a click does, before a drag from it starts. */
  const pick = (id: string, e: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }) => {
    if (e.shiftKey && anchor.current !== null) {
      const from = rows.findIndex((r) => r.facts.id === anchor.current);
      const to = rows.findIndex((r) => r.facts.id === id);
      if (from >= 0 && to >= 0) {
        const [a, b] = from < to ? [from, to] : [to, from];
        const range = rows.slice(a, b + 1).map((r) => r.facts.id);
        editor.select([...new Set([...selection, ...range])]);
        return;
      }
    }
    anchor.current = id;
    if (e.metaKey || e.ctrlKey || e.shiftKey) {
      editor.select(picked.has(id) ? selection.filter((s) => s !== id) : [...selection, id]);
    } else if (!picked.has(id)) editor.select([id]);
  };

  const onRowDown = (e: ReactPointerEvent, row: Row) => {
    if (e.button !== 0 || renaming !== null) return;
    const { id } = row.facts;

    const wasPicked = picked.has(id);
    const plain = !e.shiftKey && !e.metaKey && !e.ctrlKey;
    pick(id, e);
    listRef.current?.focus({ preventScroll: true });
    const list = listRef.current;
    if (!list || model.searching || !plain) return;
    const ids = draggedLayers(model.rows(), id, wasPicked ? selection : [id]);
    editor.drive(e.nativeEvent, list, layerDrag(list, ids, wasPicked, id));
  };

  /** The drag from a row: a line where it drops, and one `place` on release. */
  const layerDrag = (
    list: HTMLOListElement,
    ids: ReadonlyArray<string>,
    wasPicked: boolean,
    grabbed: string,
  ): PanelRun => {
    let moved = false;
    let shown: Indicator | null = null;
    let expand: { id: string; timer: ReturnType<typeof setTimeout> } | null = null;
    let scroll = 0;
    let pointer = { x: 0, y: 0 };
    const dragged = new Set(ids);
    const stopExpand = () => {
      if (expand) clearTimeout(expand.timer);
      expand = null;
    };
    const locate = (): { edits: UserEdit[] | null; indicator: Indicator | null } => {
      const page = onPageAt(pointer.x, pointer.y);
      if (page !== null) {
        const boards = ids.filter((id) => replica.get(id)?.parent === null);
        return boards.length === ids.length && boards.length > 0
          ? {
              edits: [{ kind: "moveToPage", ids: [...ids], page }],
              indicator: { kind: "page", page },
            }
          : { edits: null, indicator: null };
      }
      const box = list.getBoundingClientRect();
      const y = pointer.y - box.top + list.scrollTop;
      const all = model.rows();
      const index = Math.min(Math.max(Math.floor(y / ROW), 0), all.length - 1);
      const fraction = y < 0 ? 0 : y >= all.length * ROW ? 1 : (y - index * ROW) / ROW;
      const level = Math.round((pointer.x - box.left - INSET - PAD) / INDENT);
      const drop = dropAt(all, index, fraction, level, dragged);
      const row = all[index];
      // Resting in the middle of a closed row opens it.
      if (drop?.edge === "inside" && row && row.facts.kids.length > 0 && !row.open) {
        if (expand?.id !== row.facts.id) {
          stopExpand();
          const id = row.facts.id;
          expand = { id, timer: setTimeout(() => model.toggle(id, true), EXPAND_MS) };
        }
      } else stopExpand();
      const edit = drop && dropEdit(replica, ids, drop);
      return edit && drop
        ? { edits: [edit], indicator: { ...drop, kind: "slot" } }
        : { edits: null, indicator: null };
    };
    const tick = () => {
      const box = list.getBoundingClientRect();
      const speed =
        pointer.y < box.top + EDGE
          ? -(box.top + EDGE - pointer.y)
          : pointer.y > box.bottom - EDGE
            ? pointer.y - (box.bottom - EDGE)
            : 0;
      if (speed !== 0) {
        list.scrollTop += speed / 2;
        const next = locate();
        shown = next.indicator;
        setIndicator(shown);
      }
      scroll = requestAnimationFrame(tick);
    };
    return {
      live: false,
      move: (p) => {
        pointer = p;
        if (!moved) {
          moved = true;
          setDragging(dragged);
          scroll = requestAnimationFrame(tick);
        }
        const next = locate();
        shown = next.indicator;
        setIndicator(shown);
        return next.edits;
      },
      target: () => (shown?.kind === "slot" ? shown.parent : null),
      end: (committed) => {
        stopExpand();
        cancelAnimationFrame(scroll);
        setIndicator(null);
        setDragging(null);
        // A plain click on a row in a bigger selection selects just it, as in Figma.
        if (!moved && wasPicked && !committed) editor.select([grabbed]);
        if (committed && shown?.kind === "slot" && shown.parent) model.toggle(shown.parent, true);
      },
    };
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (renaming !== null) return;
    const at = rows.findIndex((r) => r.facts.id === last);
    const row = rows[at];
    const go = (index: number) => {
      const next = rows[index];
      if (!next) return;
      const id = next.facts.id;
      if (e.shiftKey) editor.select([...selection.filter((s) => s !== id), id]);
      else editor.select([id]);
      anchor.current = id;
    };
    switch (e.key) {
      case "ArrowDown":
        go(at < 0 ? 0 : at + 1);
        break;
      case "ArrowUp":
        go(at < 0 ? rows.length - 1 : at - 1);
        break;
      case "ArrowRight":
        if (!row) return;
        if (row.facts.kids.length > 0 && !row.open) model.toggle(row.facts.id, true);
        else if (row.open) go(at + 1);
        break;
      case "ArrowLeft":
        if (!row) return;
        if (row.open) model.toggle(row.facts.id, false);
        else if (row.parent !== null) editor.select([row.parent]);
        break;
      case "Enter":
        if (!row || !canRename(row.facts, replica)) return;
        setRenaming(row.facts.id);
        break;
      default:
        return;
    }
    // The canvas would nudge the selection with these keys.
    e.preventDefault();
    e.stopPropagation();
  };

  const flag = (row: Row, attr: "hidden" | "data-locked") => {
    const ids = picked.has(row.facts.id) ? selection : [row.facts.id];
    void editor.commit([toggleFlag((id) => model.node(id), ids, attr)]);
  };

  // Rows get the same handlers every render, which call the latest ones, so they can skip rendering.
  const latest = useRef({ onRowDown, flag, setRenaming, onReveal });
  latest.current = { onRowDown, flag, setRenaming, onReveal };
  const [actions] = useState<RowActions>(() => ({
    down: (e, row) => latest.current.onRowDown(e, row),
    enter: (id) => editor.hover(id),
    toggle: (id) => model.toggle(id),
    reveal: (id) => latest.current.onReveal(id),
    rename: (row) => canRename(row.facts, replica) && latest.current.setRenaming(row.facts.id),
    flag: (row, attr) => latest.current.flag(row, attr),
    renamed: () => {
      latest.current.setRenaming(null);
      listRef.current?.focus({ preventScroll: true });
    },
  }));

  return (
    <ol
      ref={listRef}
      aria-label="Layers"
      aria-multiselectable
      role="tree"
      tabIndex={0}
      onKeyDown={onKeyDown}
      onScroll={(e) =>
        setView({ top: e.currentTarget.scrollTop, height: e.currentTarget.clientHeight })
      }
      onPointerLeave={() => editor.hover(null)}
      {...stylex.props(styles.list)}
    >
      {rows.length === 0 && (
        <li {...stylex.props(styles.empty)}>
          {query.trim() ? "No layers match." : "No artboards on this page."}
        </li>
      )}
      <li
        role="presentation"
        style={{ height: rows.length * ROW }}
        {...stylex.props(styles.spacer)}
      >
        {rows.slice(first, end).map((row, i) => (
          <LayerRow
            key={row.facts.id}
            row={row}
            index={first + i}
            selected={picked.has(row.facts.id)}
            hovered={hover === row.facts.id}
            target={target === row.facts.id}
            dimmed={dragging?.has(row.facts.id) ?? false}
            renaming={renaming === row.facts.id}
            actions={actions}
            editor={editor}
          />
        ))}
        {indicator?.kind === "slot" && (
          <div
            aria-hidden
            {...stylex.props(indicator.edge === "inside" ? styles.into : styles.line)}
            style={
              indicator.edge === "inside"
                ? { top: indicator.row * ROW, left: (indicator.depth - 1) * INDENT + INSET }
                : {
                    top: (indicator.row + (indicator.edge === "after" ? 1 : 0)) * ROW - 2,
                    left: indicator.depth * INDENT + INSET + PAD + 16,
                  }
            }
          />
        )}
      </li>
    </ol>
  );
}

/** Whether a row's name can be typed: an element's, not a bare text node's or one inside an instance. */
function canRename(facts: RowFacts, replica: Replica) {
  return !facts.virtual && replica.get(facts.id)?.type === "element";
}

/** What a row does, the same object every render. */
interface RowActions {
  readonly down: (e: ReactPointerEvent, row: Row) => void;
  readonly enter: (id: string) => void;
  readonly toggle: (id: string) => void;
  readonly reveal: (id: string) => void;
  readonly rename: (row: Row) => void;
  readonly flag: (row: Row, attr: "hidden" | "data-locked") => void;
  readonly renamed: () => void;
}

interface RowProps {
  row: Row;
  index: number;
  selected: boolean;
  hovered: boolean;
  target: boolean;
  dimmed: boolean;
  renaming: boolean;
  actions: RowActions;
  editor: Editor;
}

/** A row draws again only when what it shows changed; rows are rebuilt on every edit, their facts aren't. */
function sameRow(a: RowProps, b: RowProps) {
  return (
    a.row.facts === b.row.facts &&
    a.row.depth === b.row.depth &&
    a.row.open === b.row.open &&
    a.row.parent === b.row.parent &&
    a.row.hiddenBy === b.row.hiddenBy &&
    a.row.lockedBy === b.row.lockedBy &&
    a.index === b.index &&
    a.selected === b.selected &&
    a.hovered === b.hovered &&
    a.target === b.target &&
    a.dimmed === b.dimmed &&
    a.renaming === b.renaming
  );
}

const LayerRow = memo(function LayerRow({
  row,
  index,
  selected,
  hovered,
  target,
  dimmed,
  renaming,
  actions,
  editor,
}: RowProps) {
  const { facts, depth, open } = row;
  const parent = facts.kids.length > 0;
  const hidden = facts.hidden || row.hiddenBy;
  const locked = facts.locked || row.lockedBy;
  return (
    <div
      role="treeitem"
      data-layer={facts.id}
      aria-selected={selected}
      aria-expanded={parent ? open : undefined}
      aria-level={depth + 1}
      title={facts.label}
      onPointerDown={(e) => {
        if ((e.target as Element).closest("button, input")) return;
        actions.down(e, row);
      }}
      onPointerEnter={() => actions.enter(facts.id)}
      onDoubleClick={(e) => {
        if ((e.target as Element).closest("[data-name-label]")) actions.rename(row);
        else if (!(e.target as Element).closest("button")) actions.reveal(facts.id);
      }}
      {...stylex.props(
        styles.row,
        hovered && styles.rowHover,
        target && styles.rowTarget,
        selected && styles.rowOn,
        dimmed && styles.dimmed,
      )}
      style={{ top: index * ROW, paddingLeft: depth * INDENT + PAD }}
    >
      <button
        type="button"
        tabIndex={-1}
        aria-label={open ? "Collapse" : "Expand"}
        onClick={() => parent && actions.toggle(facts.id)}
        {...stylex.props(styles.twisty, !parent && styles.invisible)}
      >
        <span {...stylex.props(styles.chevron, open && styles.chevronOpen)}>
          <Icon name="next" size={12} />
        </span>
      </button>
      <span
        {...stylex.props(
          styles.icon,
          selected && styles.iconOn,
          facts.part && styles.part,
          hidden && styles.faded,
        )}
      >
        <Icon name={facts.icon} size={15} />
      </span>
      {renaming ? (
        <RenameField id={facts.id} label={facts.label} editor={editor} onDone={actions.renamed} />
      ) : (
        <span data-name-label {...stylex.props(styles.name, hidden && styles.faded)}>
          {facts.label}
        </span>
      )}
      {!facts.virtual && (
        <span {...stylex.props(styles.flags)}>
          <IconButton
            icon={locked ? "lock" : "unlock"}
            label={facts.locked ? "Unlock" : "Lock"}
            title={facts.locked ? "Unlock (⇧⌘L)" : "Lock (⇧⌘L)"}
            variant="ghost"
            size="small"
            tabIndex={-1}
            // The look stays flat: the icon itself says it's locked.
            aria-pressed={facts.locked}
            onClick={() => actions.flag(row, "data-locked")}
            style={[
              styles.flag,
              facts.locked ? styles.flagOn : !hovered && styles.invisible,
              row.lockedBy && !facts.locked && styles.faded,
            ]}
          />
          <IconButton
            icon={hidden ? "eyeOff" : "eye"}
            label={facts.hidden ? "Show" : "Hide"}
            title={facts.hidden ? "Show (⇧⌘H)" : "Hide (⇧⌘H)"}
            variant="ghost"
            size="small"
            tabIndex={-1}
            aria-pressed={facts.hidden}
            onClick={() => actions.flag(row, "hidden")}
            style={[styles.flag, facts.hidden ? styles.flagOn : !hovered && styles.invisible]}
          />
        </span>
      )}
    </div>
  );
}, sameRow);

/**
 * A layer's name being typed: the artboard label and the row follow each
 * key, Enter or leaving keeps it as one undo step, Escape puts it back.
 * An empty name takes the name off, so the layer reads as its content.
 */
function RenameField({
  id,
  label,
  editor,
  onDone,
}: {
  id: string;
  label: string;
  editor: Editor;
  onDone: () => void;
}) {
  const draft = useRef<ReturnType<Editor["begin"]> | null>(null);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    draft.current = editor.begin({ onLost: onDone });
    ref.current?.select();
    // Unmounting keeps what was typed, as leaving the field does.
    return () => draft.current?.commit();
  }, [editor, onDone]); // Both are stable: the editor, and the rows' shared actions.
  const edit = (text: string): UserEdit[] => [
    { kind: "setAttributes", ids: [id], attrs: { "data-name": text.trim() || null } },
  ];
  return (
    <input
      ref={ref}
      aria-label="Layer name"
      defaultValue={label}
      spellCheck={false}
      onChange={(e) => draft.current?.preview(edit(e.target.value))}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          draft.current?.commit();
          onDone();
        } else if (e.key === "Escape") {
          draft.current?.cancel();
          onDone();
        }
      }}
      onBlur={() => {
        draft.current?.commit();
        onDone();
      }}
      {...stylex.props(styles.rename)}
    />
  );
}

const styles = stylex.create({
  list: {
    position: "relative",
    flexGrow: 1,
    minHeight: 0,
    margin: 0,
    padding: 0,
    paddingBottom: space.sm,
    overflowY: "auto",
    listStyle: "none",
    outline: "none",
  },
  spacer: { position: "relative", flexShrink: 0 },
  empty: {
    display: "flex",
    alignItems: "center",
    height: size.sm,
    paddingInline: space.ms,
    color: colors.muted,
    fontSize: 12,
  },
  row: {
    position: "absolute",
    left: INSET,
    right: INSET,
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    height: size.sm,
    // The flags' icons end about as far in as the buttons above them.
    paddingRight: 0,
    borderRadius: radii.sm,
    color: colors.text,
    fontSize: 14,
    lineHeight: "20px",
    cursor: "var(--cursor-pointer, pointer)",
    userSelect: "none",
    touchAction: "none",
  },
  /** Under the pointer, here or on the canvas. */
  rowHover: { backgroundColor: colors.hoverFill },
  /** What a drag drops into, ringed in the brand like its outline on the canvas. */
  rowTarget: { boxShadow: `inset 0 0 0 2px ${colors.brand}` },
  rowOn: { backgroundColor: colors.activeFill },
  dimmed: { opacity: 0.45 },
  twisty: {
    display: "grid",
    placeItems: "center",
    width: 12,
    height: 12,
    flexShrink: 0,
    marginRight: `calc(-1 * ${space.xs})`,
    padding: 0,
    borderWidth: 0,
    borderRadius: radii.xs,
    backgroundColor: "transparent",
    color: { default: colors.faint, ":hover": colors.text },
    cursor: "var(--cursor-pointer, pointer)",
  },
  invisible: { visibility: "hidden" },
  chevron: { display: "flex", transition: "transform 200ms cubic-bezier(.23, 1, .32, 1)" },
  chevronOpen: { transform: "rotate(90deg)" },
  icon: { display: "flex", flexShrink: 0, color: colors.faint },
  iconOn: { color: colors.text },
  part: { color: colors.component },
  faded: { opacity: 0.5 },
  name: {
    flexGrow: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  /** A sunk field over the name, ringed in the brand while it's typed in. */
  rename: {
    flexGrow: 1,
    minWidth: 0,
    height: size.xs,
    marginLeft: `calc(-1 * ${space.xs})`,
    paddingInline: space.xs,
    borderWidth: 0,
    borderRadius: radii.sm,
    backgroundColor: colors.sunk,
    boxShadow: shadows.field,
    color: colors.text,
    font: "inherit",
    outline: `1px solid ${colors.brand}`,
  },
  flags: { display: "flex", flexShrink: 0, gap: space.px },
  /** Fainter than the ghost's muted, so a column of them stays behind the names. */
  flag: { color: { default: colors.faint, ":hover": colors.text } },
  flagOn: { visibility: "visible" },
  line: {
    position: "absolute",
    right: space.sm,
    height: 3,
    borderRadius: 1,
    backgroundColor: colors.brand,
    pointerEvents: "none",
  },
  into: {
    position: "absolute",
    right: INSET,
    height: size.sm,
    borderRadius: radii.xs,
    boxShadow: `inset 0 0 0 2px ${colors.brand}`,
    pointerEvents: "none",
  },
});
