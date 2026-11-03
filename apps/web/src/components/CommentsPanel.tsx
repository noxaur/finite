"use client";

import * as stylex from "@stylexjs/stylex";
import { useState } from "react";
import type { Replica } from "@/design/replica";
import type { Comment } from "@/design/schema";
import { isLocalUser } from "@/lib/user";
import { timeAgo } from "@/lib/time";
import { colors, radii, space } from "@/styles/tokens.stylex";
import { pinState } from "./Comments";
import { PinIcon } from "./PinIcon";

type Tab = "open" | "resolved";

/**
 * Every comment on the design, open or resolved, newest first. Resolved pins
 * leave the canvas as soon as they're resolved, so this is where they're
 * kept. Picking one opens its thread on the canvas.
 */
export function CommentsPanel({
  replica,
  comments,
  working,
  openId,
  onSelect,
  onClose,
}: {
  replica: Replica;
  comments: ReadonlyMap<string, Comment>;
  /** Agent labels by artboard id, for the artboards agents are working on. */
  working: ReadonlyMap<string, string>;
  openId: string | null;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>("open");
  const all = [...comments.values()].sort((a, b) => b.createdAt - a.createdAt);
  const open = all.filter((c) => !c.resolved);
  const resolved = all.filter((c) => c.resolved);
  const shown = tab === "open" ? open : resolved;

  return (
    <aside
      data-camera-ignore
      aria-label="Comments"
      {...stylex.props(styles.panel)}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <div {...stylex.props(styles.head)}>
        <p {...stylex.props(styles.title)}>Comments</p>
        <span {...stylex.props(styles.spacer)} />
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          {...stylex.props(styles.textButton)}
        >
          ×
        </button>
      </div>
      <div role="tablist" {...stylex.props(styles.tabs)}>
        {(
          [
            ["open", `Open ${open.length}`],
            ["resolved", `Resolved ${resolved.length}`],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            {...stylex.props(styles.tab, tab === key && styles.tabActive)}
          >
            {label}
          </button>
        ))}
      </div>
      {shown.length === 0 ? (
        <p {...stylex.props(styles.muted, styles.empty)}>
          {tab === "open"
            ? "No open comments. Pick the comment tool (C) and click the canvas to add one."
            : "Resolved comments show up here."}
        </p>
      ) : (
        <ol {...stylex.props(styles.list)}>
          {shown.map((comment) => {
            const first = comment.messages[0];
            const replies = comment.messages.length - 1;
            const board = comment.artboardId === null ? undefined : replica.get(comment.artboardId);
            const where =
              comment.artboardId === null
                ? "Canvas"
                : board && board.parent === null
                  ? (board.name ?? "Artboard")
                  : "Deleted artboard";
            return (
              <li key={comment.id}>
                <button
                  type="button"
                  aria-current={comment.id === openId}
                  onClick={() => onSelect(comment.id)}
                  {...stylex.props(styles.row, comment.id === openId && styles.rowOpen)}
                >
                  <span {...stylex.props(styles.icon)}>
                    <PinIcon
                      state={pinState(
                        comment,
                        comment.artboardId === null ? undefined : working.get(comment.artboardId),
                      )}
                    />
                  </span>
                  <span {...stylex.props(styles.text)}>
                    <span {...stylex.props(styles.meta)}>
                      <span {...stylex.props(styles.author)}>
                        {first ? (isLocalUser(first.author) ? "You" : first.author.name) : ""}
                      </span>
                      <span {...stylex.props(styles.muted)}>{timeAgo(comment.createdAt)}</span>
                    </span>
                    <span {...stylex.props(styles.body)}>{first?.body}</span>
                    <span {...stylex.props(styles.muted)}>
                      {where}
                      {replies > 0 && ` · ${replies} ${replies === 1 ? "reply" : "replies"}`}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </aside>
  );
}

const styles = stylex.create({
  panel: {
    position: "absolute",
    top: 52,
    right: space.sm,
    bottom: 52,
    width: 360,
    display: "flex",
    flexDirection: "column",
    gap: space.sm,
    padding: space.sm,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: colors.surface,
    boxShadow: "0 4px 16px rgba(0, 0, 0, 0.08)",
  },
  head: { display: "flex", alignItems: "center", gap: space.xs },
  title: { margin: 0, fontWeight: 500 },
  spacer: { flexGrow: 1 },
  muted: { margin: 0, color: colors.muted, fontSize: 12 },
  empty: { paddingBlock: space.md, textAlign: "center" },
  textButton: {
    paddingInline: 6,
    height: 22,
    borderWidth: 0,
    borderRadius: 4,
    backgroundColor: { default: "transparent", ":hover": colors.bg },
    color: "inherit",
    font: "inherit",
    fontSize: 12,
    cursor: "var(--cursor-pointer, pointer)",
  },
  tabs: {
    display: "flex",
    gap: 2,
    padding: 2,
    borderRadius: radii.sm,
    backgroundColor: colors.bg,
  },
  tab: {
    flexGrow: 1,
    height: 24,
    borderWidth: 0,
    borderRadius: 4,
    backgroundColor: "transparent",
    color: colors.muted,
    font: "inherit",
    fontSize: 12,
    cursor: "var(--cursor-pointer, pointer)",
  },
  tabActive: {
    backgroundColor: colors.surface,
    color: colors.text,
    boxShadow: "0 1px 2px rgba(0, 0, 0, 0.08)",
  },
  list: {
    display: "flex",
    flexDirection: "column",
    gap: 2,
    flexGrow: 1,
    minHeight: 0,
    margin: 0,
    padding: 0,
    overflowY: "auto",
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
    backgroundColor: { default: "transparent", ":hover": colors.bg },
    color: "inherit",
    font: "inherit",
    textAlign: "left",
    cursor: "var(--cursor-pointer, pointer)",
  },
  rowOpen: { backgroundColor: { default: colors.bg, ":hover": colors.bg } },
  // The pin at 60%, so a row is about one line of text tall.
  icon: {
    flexShrink: 0,
    width: 24,
    height: 22,
    marginTop: 2,
    transform: "scale(0.6)",
    transformOrigin: "0 0",
  },
  text: { display: "flex", flexDirection: "column", gap: 2, minWidth: 0 },
  meta: { display: "flex", alignItems: "baseline", gap: space.xs },
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
