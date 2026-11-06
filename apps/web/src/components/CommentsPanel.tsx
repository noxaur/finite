"use client";

import * as stylex from "@stylexjs/stylex";
import { useState } from "react";
import type { Replica } from "@/design/replica";
import type { Activity } from "@/design/session";
import type { Comment } from "@/design/schema";
import { isLocalUser } from "@/lib/user";
import { timeAgo } from "@/lib/time";
import { colors, radii, size, space } from "@/styles/tokens.stylex";
import { ANY_AGENT, audienceLabel, routeLabel } from "@/lib/audience";
import { pinState } from "./Comments";
import { PinIcon } from "./PinIcon";

type Tab = "comments" | "activity";

/**
 * The right side in comment mode: every comment on the design, open ones
 * first, newest first, and the design's recent changes. Resolved pins
 * leave the canvas as soon as they're resolved, so this is where they're
 * kept. Picking one opens its thread on the canvas.
 */
export function CommentsPanel({
  replica,
  comments,
  working,
  openId,
  activity,
  onSelect,
}: {
  replica: Replica;
  comments: ReadonlyMap<string, Comment>;
  /** Agent labels by artboard id, for the artboards agents are working on. */
  working: ReadonlyMap<string, string>;
  openId: string | null;
  activity: ReadonlyArray<Activity>;
  onSelect: (id: string) => void;
}) {
  const [tab, setTab] = useState<Tab>("comments");
  const [resolvedOpen, setResolvedOpen] = useState(false);
  const all = [...comments.values()].sort((a, b) => b.createdAt - a.createdAt);
  const open = all.filter((c) => !c.resolved);
  const resolved = all.filter((c) => c.resolved);

  const list = (shown: ReadonlyArray<Comment>) => (
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
              {...stylex.props(
                styles.row,
                comment.id === openId && styles.rowOpen,
                comment.resolved && styles.rowResolved,
              )}
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
                  {routeLabel(comment) !== audienceLabel(ANY_AGENT) && ` · ${routeLabel(comment)}`}
                </span>
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );

  return (
    <aside data-camera-ignore aria-label="Comments" {...stylex.props(styles.panel)}>
      <div role="tablist" {...stylex.props(styles.tabs)}>
        {(
          [
            ["comments", "Comments", open.length],
            ["activity", "Activity", null],
          ] as const
        ).map(([key, label, count]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            {...stylex.props(styles.tab, tab === key && styles.tabActive)}
          >
            {label}
            {count !== null && count > 0 && <span {...stylex.props(styles.count)}>{count}</span>}
          </button>
        ))}
      </div>
      <div {...stylex.props(styles.scroll)}>
        {tab === "activity" ? (
          activity.length === 0 ? (
            <p {...stylex.props(styles.muted, styles.empty)}>
              Changes show up here as they happen.
            </p>
          ) : (
            <ol aria-label="Recent changes" {...stylex.props(styles.list)}>
              {activity.map((a) => (
                <li key={a.seq} {...stylex.props(styles.activity)}>
                  <span {...stylex.props(styles.author)}>{a.actor}</span>
                  <span {...stylex.props(styles.activityLabel)}>{a.label}</span>
                  <span {...stylex.props(styles.muted)}>{timeAgo(a.at)}</span>
                </li>
              ))}
            </ol>
          )
        ) : (
          <>
            <p {...stylex.props(styles.heading)}>Open</p>
            {open.length === 0 ? (
              <p {...stylex.props(styles.muted, styles.empty)}>
                No open comments. Click the canvas to add one.
              </p>
            ) : (
              list(open)
            )}
            {resolved.length > 0 && (
              <>
                <button
                  type="button"
                  aria-expanded={resolvedOpen}
                  onClick={() => setResolvedOpen(!resolvedOpen)}
                  {...stylex.props(styles.heading, styles.toggle)}
                >
                  Resolved
                  <span {...stylex.props(styles.count)}>{resolved.length}</span>
                </button>
                {resolvedOpen && list(resolved)}
              </>
            )}
          </>
        )}
      </div>
    </aside>
  );
}

const styles = stylex.create({
  panel: {
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    minHeight: 0,
  },
  tabs: {
    display: "flex",
    alignItems: "center",
    gap: space.xs,
    height: size.lg,
    flexShrink: 0,
    paddingInline: space.sm,
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderBottomColor: colors.border,
  },
  tab: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    height: size.sm,
    paddingInline: space.sm,
    borderWidth: 0,
    borderRadius: radii.xs,
    backgroundColor: { default: "transparent", ":hover": colors.bg },
    color: { default: colors.muted, ":hover": colors.text },
    font: "inherit",
    fontSize: 14,
    fontWeight: 500,
    cursor: "var(--cursor-pointer, pointer)",
  },
  tabActive: {
    backgroundColor: { default: colors.sunk, ":hover": colors.sunk },
    color: colors.text,
  },
  count: { color: colors.faint, fontSize: 12, fontVariantNumeric: "tabular-nums" },
  scroll: { flexGrow: 1, minHeight: 0, overflowY: "auto", padding: space.sm },
  heading: {
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    height: size.xs,
    margin: 0,
    paddingInline: space.xs,
    color: colors.muted,
    fontSize: 12,
    fontWeight: 500,
  },
  toggle: {
    width: "100%",
    marginTop: space.sm,
    borderWidth: 0,
    backgroundColor: "transparent",
    font: "inherit",
    fontSize: 12,
    fontWeight: 500,
    cursor: "var(--cursor-pointer, pointer)",
  },
  muted: { margin: 0, color: colors.muted, fontSize: 12 },
  empty: { padding: space.xs },
  activity: {
    display: "flex",
    alignItems: "baseline",
    gap: space.sm,
    paddingInline: space.xs,
    paddingBlock: space.xs,
    minWidth: 0,
  },
  activityLabel: {
    flexGrow: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  list: {
    display: "flex",
    flexDirection: "column",
    gap: 3,
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
  rowOpen: { backgroundColor: { default: colors.sunk, ":hover": colors.sunk } },
  rowResolved: { color: colors.muted },
  // The pin at 60%, so a row is about one line of text tall.
  icon: {
    flexShrink: 0,
    width: 24,
    height: 21,
    marginTop: 3,
    transform: "scale(0.6)",
    transformOrigin: "0 0",
  },
  text: { display: "flex", flexDirection: "column", gap: 3, minWidth: 0 },
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
