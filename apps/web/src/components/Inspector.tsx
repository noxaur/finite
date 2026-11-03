"use client";

import * as stylex from "@stylexjs/stylex";
import { useEffect, useRef, useState } from "react";
import type { Editor } from "@/design/editing/editor";
import { isPositioned, moveAbsolute, moveArtboards, resize } from "@/design/editing/geometry";
import { nodeOf } from "@/design/editing/tree";
import type { Renderer } from "@/design/renderer";
import type { Replica } from "@/design/replica";
import type { UserEdit } from "@/design/schema";
import { colors, radii, space } from "@/styles/tokens.stylex";

type Field = "x" | "y" | "w" | "h";

/**
 * The selected node's position and size, in CSS pixels, to type exact
 * values into. An artboard's X and Y are its place on the canvas; a
 * positioned element's are its `left` and `top`. An element in the flow
 * is placed by its layout, so its X and Y only show where it is.
 * `version` changes with the design, so the values follow every edit.
 */
export function Inspector({
  editor,
  renderer,
  replica,
}: {
  editor: Editor;
  renderer: Renderer;
  replica: Replica;
  version: number;
}) {
  const [state, setState] = useState(editor.state);
  useEffect(() => {
    setState(editor.state);
    return editor.subscribe(() => setState(editor.state));
  }, [editor]);
  // What the person is typing, until it's committed or put back.
  const [typing, setTyping] = useState<{ field: Field; text: string } | null>(null);
  // Escape blurs the field, and the blur mustn't commit what it put back.
  const putBack = useRef(false);

  const [id] = state.selection;
  const node = id === undefined || state.selection.length !== 1 ? undefined : nodeOf(replica, id);
  const facts = id === undefined ? null : renderer.measure(id);
  if (!node || !facts || state.dragging) return null;
  const board = node.parent === null;
  const width = facts.rect.width / facts.scale;
  const height = facts.rect.height / facts.scale;
  const artboard = id ? replica.artboardOf(id) : undefined;
  const boardRect = artboard ? renderer.nodeRect(artboard.id) : null;
  const values: Record<Field, number> = {
    x: board
      ? (node.x ?? 0)
      : isPositioned(facts)
        ? facts.left
        : (facts.rect.left - (boardRect?.left ?? 0)) / facts.scale,
    y: board
      ? (node.y ?? 0)
      : isPositioned(facts)
        ? facts.top
        : (facts.rect.top - (boardRect?.top ?? 0)) / facts.scale,
    w: width,
    h: height,
  };
  const movable = board || isPositioned(facts);

  /** The edit that gives `field` the value `n`. */
  const editFor = (field: Field, n: number): UserEdit | null => {
    const d = n - values[field];
    if (!Number.isFinite(n) || Math.abs(d) < 0.5) return null;
    if (field === "w") return resize(node, facts, "e", { x: d, y: 0 });
    if (field === "h") return resize(node, facts, "s", { x: 0, y: d });
    const delta = field === "x" ? { x: d, y: 0 } : { x: 0, y: d };
    if (board) return moveArtboards([{ id: node.id, x: node.x ?? 0, y: node.y ?? 0 }], delta);
    return isPositioned(facts) ? moveAbsolute(node, facts, delta) : null;
  };
  const commit = () => {
    if (putBack.current) {
      putBack.current = false;
      return;
    }
    if (!typing) return;
    const edit = editFor(typing.field, parseFloat(typing.text));
    setTyping(null);
    if (edit) void editor.commit([edit]);
  };

  return (
    <div role="group" aria-label="Position and size" {...stylex.props(styles.panel)}>
      {(["x", "y", "w", "h"] as const).map((field) => {
        const disabled = (field === "x" || field === "y") && !movable;
        return (
          <label key={field} {...stylex.props(styles.field)}>
            <span {...stylex.props(styles.name)}>{field.toUpperCase()}</span>
            <input
              inputMode="decimal"
              aria-label={{ x: "X", y: "Y", w: "Width", h: "Height" }[field]}
              disabled={disabled}
              title={disabled ? "Its layout places it; drag it to reorder it" : undefined}
              value={typing?.field === field ? typing.text : String(Math.round(values[field]))}
              onChange={(e) => setTyping({ field, text: e.target.value })}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commit();
                } else if (e.key === "Escape") {
                  putBack.current = true;
                  setTyping(null);
                  e.currentTarget.blur();
                }
              }}
              {...stylex.props(styles.input)}
            />
          </label>
        );
      })}
    </div>
  );
}

const styles = stylex.create({
  panel: {
    position: "absolute",
    right: space.sm,
    bottom: 48,
    display: "flex",
    gap: space.xs,
    margin: 0,
    padding: space.xs,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: colors.surface,
    boxShadow: "0 4px 16px rgba(0, 0, 0, 0.08)",
    fontSize: 12,
  },
  field: {
    display: "flex",
    alignItems: "center",
    gap: 4,
  },
  name: { color: colors.muted, width: 10 },
  input: {
    width: 52,
    height: 24,
    paddingInline: 6,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    borderRadius: radii.sm,
    backgroundColor: colors.bg,
    color: { default: "inherit", ":disabled": colors.muted },
    font: "inherit",
    fontVariantNumeric: "tabular-nums",
    outline: { default: "none", ":focus": `2px solid ${colors.accent}` },
  },
});
