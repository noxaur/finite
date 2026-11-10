"use client";

import * as stylex from "@stylexjs/stylex";
import type { Canvas, Frame, LayerNode } from "@finite/protocol";
import { useEffect, useState } from "react";
import { bridgeOf, onBridgesChange } from "@/canvas/bridge";
import { useActiveEditor, useEditorState } from "@/canvas/editor";
import { groupKeyOf, layerRows, pathIn } from "@/canvas/layers";
import { keyOf, selectionStore, toggleItem, useSelection } from "@/canvas/selection";
import { colors, fonts, motion, radii, size, space } from "@/styles/tokens.stylex";
import { Icon } from "./Icons";

/** The canvas's frames, and the elements of the open ones, from each frame's bridge. */
function useLayers(frames: readonly Frame[], opened: ReadonlySet<string>, updates: number) {
  const [layers, setLayers] = useState<Record<string, LayerNode[]>>({});
  const [bridges, setBridges] = useState(0);
  useEffect(() => onBridgesChange(() => setBridges((n) => n + 1)), []);
  const want = frames.filter((f) => opened.has(f.id)).map((f) => f.id);
  const key = want.join(" ");
  useEffect(() => {
    let live = true;
    void Promise.all(
      want.map(
        async (id) =>
          [
            id,
            (await bridgeOf(id)
              ?.layers()
              .catch(() => null)) ?? [],
          ] as const,
      ),
    ).then((found) => live && setLayers(Object.fromEntries(found)));
    return () => {
      live = false;
    };
    // `want` is keyed by `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, updates, bridges]);
  return layers;
}

/**
 * The layers panel: the canvas's frames at the top level, and under each one the elements it
 * renders. Selecting here selects on the canvas and the other way round; the rows open down to
 * what's selected. Hovering a row outlines its element on the canvas.
 */
export function LayersTree({ canvas }: { canvas: Canvas | null | undefined }) {
  const frames = canvas?.frames ?? NO_FRAMES;
  const editor = useActiveEditor();
  const state = useEditorState(editor);
  const selection = useSelection();
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  const layers = useLayers(frames, opened, state?.updates ?? 0);

  // Open the rows down to what's selected.
  const selectedKeys = new Set(selection.map(keyOf));
  const selectionKey = [...selectedKeys].join(" ");
  useEffect(() => {
    setOpened((prev) => {
      const next = new Set(prev);
      for (const item of selection) {
        next.add(item.frameId);
        if (item.loc === undefined) continue;
        const path = pathIn(layers[item.frameId] ?? [], item.loc, item.index ?? 0) ?? [];
        next.add(groupKeyOf(item.frameId, item.loc));
        // A parent's instance index isn't in the path; the first is the common case.
        for (const p of path) {
          next.add(keyOf({ frameId: item.frameId, loc: p.loc, index: 0 }));
          next.add(groupKeyOf(item.frameId, p.loc));
        }
      }
      return next.size === prev.size ? prev : next;
    });
    // `selection` is keyed by `selectionKey`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectionKey, layers]);

  const rows = layerRows(frames, layers, opened);
  const toggle = (key: string) =>
    setOpened((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <ol role="tree" aria-label="Layers" {...stylex.props(styles.list)}>
      {rows.length === 0 && <li {...stylex.props(styles.empty)}>No frames yet</li>}
      {rows.map((row) => {
        const on = selectedKeys.has(row.key);
        return (
          <li
            key={row.key}
            role="treeitem"
            aria-selected={on}
            aria-expanded={row.open ?? undefined}
            onPointerEnter={() => void editor?.hoverItem(row.item)}
            onPointerLeave={() => void editor?.hoverItem(null)}
            onClick={(e) => {
              const next = e.shiftKey ? toggleItem(selectionStore.get(), row.item) : [row.item];
              selectionStore.set(next);
            }}
            {...stylex.props(styles.row, on && styles.rowOn)}
            style={{ paddingLeft: `calc(${row.depth} * 12px + 6px)` }}
          >
            <button
              type="button"
              aria-label={row.open ? "Close" : "Open"}
              tabIndex={-1}
              onClick={(e) => {
                e.stopPropagation();
                toggle(row.key);
              }}
              {...stylex.props(
                styles.twisty,
                row.open === null && row.depth > 0 && styles.invisible,
              )}
            >
              <span {...stylex.props(styles.chevron, row.open === true && styles.chevronOpen)}>
                <Icon name="next" size={12} />
              </span>
            </button>
            <span {...stylex.props(styles.icon, on && styles.iconOn)}>
              <Icon name={row.item.loc === undefined ? "frame" : "box"} size={15} />
            </span>
            <span {...stylex.props(styles.name)}>{row.name}</span>
          </li>
        );
      })}
    </ol>
  );
}

const NO_FRAMES: readonly Frame[] = [];

const styles = stylex.create({
  list: {
    display: "flex",
    fontFamily: fonts.sans,
    flexDirection: "column",
    margin: 0,
    padding: space.xs,
    listStyle: "none",
  },
  empty: {
    paddingInline: space.ms,
    color: colors.muted,
    fontSize: 12,
  },
  row: {
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    height: size.sm,
    flexShrink: 0,
    paddingRight: space.sm,
    borderRadius: radii.sm,
    color: colors.text,
    fontSize: 14,
    lineHeight: "20px",
    cursor: "pointer",
    userSelect: "none",
    backgroundColor: { default: "transparent", ":hover": colors.hoverFill },
  },
  rowOn: { backgroundColor: { default: colors.activeFill, ":hover": colors.activeFill } },
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
    cursor: "pointer",
  },
  invisible: { visibility: "hidden" },
  chevron: { display: "flex", transition: `transform ${motion.base} ${motion.out}` },
  chevronOpen: { transform: "rotate(90deg)" },
  icon: { display: "flex", flexShrink: 0, color: colors.faint },
  iconOn: { color: colors.text },
  name: {
    flexGrow: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
});
