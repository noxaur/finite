"use client";

import * as stylex from "@stylexjs/stylex";
import type { Canvas, Comment } from "@finite/protocol";
import { useState } from "react";
import { useActiveEditor, useEditorState } from "@/canvas/editor";
import { colors, radii, size, space } from "@/styles/tokens.stylex";
import { Button } from "./Button";
import { pinState } from "@/canvas/pins";
import { PinIcon } from "./PinIcon";
import { TimeAgo } from "./TimeAgo";

/**
 * Every comment on the canvas, open ones first, newest first; resolved ones fold away under a
 * toggle. Picking one opens its thread on the canvas.
 */
export function CommentsPanel({ canvas }: { canvas: Canvas }) {
  const editor = useActiveEditor();
  const state = useEditorState(editor);
  const [resolvedOpen, setResolvedOpen] = useState(false);
  const all = [...canvas.comments].sort((a, b) => b.createdAt - a.createdAt);
  const open = all.filter((c) => c.resolvedAt === undefined);
  const resolved = all.filter((c) => c.resolvedAt !== undefined);
  const where = (c: Comment) =>
    "frameId" in c.anchor
      ? (canvas.frames.find((f) => f.id === (c.anchor as { frameId: string }).frameId)?.name ??
        "Removed frame")
      : "Canvas";

  const list = (shown: readonly Comment[]) => (
    <ol {...stylex.props(styles.list)}>
      {shown.map((c) => (
        <li key={c.id}>
          <button
            type="button"
            onClick={() => editor?.openComment(c.id)}
            {...stylex.props(
              styles.row,
              state?.openComment === c.id && styles.rowOpen,
              c.resolvedAt !== undefined && styles.rowResolved,
            )}
          >
            <span {...stylex.props(styles.icon)}>
              <PinIcon state={pinState(c)} />
            </span>
            <span {...stylex.props(styles.text)}>
              <span {...stylex.props(styles.meta)}>
                <span {...stylex.props(styles.author)}>{c.author.name || "Someone"}</span>
                <span {...stylex.props(styles.muted)}>
                  {c.kind === "annotation" && "Annotation · "}
                  {where(c)} · <TimeAgo at={c.createdAt} />
                  {c.replies.length > 0 &&
                    ` · ${c.replies.length} repl${c.replies.length === 1 ? "y" : "ies"}`}
                </span>
              </span>
              <span {...stylex.props(styles.body)}>{c.text}</span>
            </span>
          </button>
        </li>
      ))}
    </ol>
  );

  return (
    <div {...stylex.props(styles.panel)}>
      <h3 {...stylex.props(styles.heading)}>Open · {open.length}</h3>
      {open.length === 0 ? (
        <p {...stylex.props(styles.muted, styles.empty)}>No open comments</p>
      ) : (
        list(open)
      )}
      {resolved.length > 0 && (
        <Button
          size="small"
          variant="ghost"
          expanded={resolvedOpen}
          onClick={() => setResolvedOpen(!resolvedOpen)}
          style={styles.toggle}
        >
          Resolved · {resolved.length}
        </Button>
      )}
      {resolvedOpen && list(resolved)}
    </div>
  );
}

const styles = stylex.create({
  panel: { display: "flex", flexDirection: "column", padding: space.sm, minHeight: 0 },
  heading: {
    display: "flex",
    alignItems: "center",
    height: size.xs,
    margin: 0,
    paddingInline: space.xs,
    color: colors.muted,
    fontSize: 12,
    fontWeight: 500,
  },
  toggle: { width: "100%", marginTop: space.sm, justifyContent: "flex-start" },
  muted: { margin: 0, color: colors.muted, fontSize: 12 },
  empty: { padding: space.xs },
  list: {
    display: "flex",
    flexDirection: "column",
    gap: space.sm,
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  row: {
    display: "flex",
    alignItems: "flex-start",
    gap: space.sm,
    width: "100%",
    padding: space.sm,
    borderWidth: 0,
    borderRadius: radii.sm,
    backgroundColor: { default: "transparent", ":hover": colors.hoverFill },
    color: colors.text,
    font: "inherit",
    textAlign: "left",
    cursor: "pointer",
  },
  rowOpen: { backgroundColor: { default: colors.activeFill, ":hover": colors.activeFill } },
  rowResolved: { color: colors.muted },
  icon: {
    flexShrink: 0,
    width: 24,
    height: 21,
    marginTop: 3,
    transform: "scale(0.6)",
    transformOrigin: "0 0",
  },
  text: { display: "flex", flexDirection: "column", gap: 3, minWidth: 0 },
  meta: { display: "flex", alignItems: "baseline", gap: space.xs, flexWrap: "wrap" },
  author: { fontWeight: 600 },
  body: {
    display: "-webkit-box",
    WebkitBoxOrient: "vertical",
    WebkitLineClamp: 3,
    overflow: "hidden",
    overflowWrap: "anywhere",
    lineHeight: 1.4,
  },
});
