"use client";

import * as stylex from "@stylexjs/stylex";
import type { ThreadEvent, ThreadMeta } from "@finite/protocol";
import { useLayoutEffect, useMemo, useRef } from "react";
import { useThreadEvents } from "@/client/finite";
import { chatRows } from "@/lib/chat";
import { colors, fonts, radii, size, space } from "@/styles/tokens.stylex";
import { IconButton } from "./Button";
import { Icon } from "./Icons";
import { Markdown } from "./Markdown";

/**
 * A thread's messages down the right side: what people sent, the agent's replies, and its tool
 * calls as compact rows. Threads without a canvas (a brand import) show it on their own; canvas
 * threads show it when History is on.
 */
export function ChatPanel({
  designId,
  thread,
  onClose,
}: {
  designId: string;
  thread: ThreadMeta;
  onClose?: (() => void) | undefined;
}) {
  const { events, streaming, loaded } = useThreadEvents(designId, thread.id);
  const rows = useMemo(() => chatRows(events), [events]);
  const scroller = useRef<HTMLDivElement>(null);

  // Follows the conversation while it's scrolled to the bottom.
  const pinned = useRef(true);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [rows.length, streaming]);

  return (
    <aside aria-label="Messages" {...stylex.props(styles.panel)}>
      <header {...stylex.props(styles.head)}>
        <span {...stylex.props(styles.title)}>{thread.title || "New thread"}</span>
        {onClose && (
          <IconButton
            icon="close"
            label="Hide messages"
            variant="ghost"
            size="small"
            onClick={onClose}
          />
        )}
      </header>
      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
        {...stylex.props(styles.scroll)}
      >
        {!loaded && <p {...stylex.props(styles.note)}>Loading…</p>}
        {loaded && events.length === 0 && !streaming && (
          <p {...stylex.props(styles.note)}>No messages yet.</p>
        )}
        {rows.map((event, i) => (
          <EventRow key={event.type === "tool" ? event.id : i} event={event} />
        ))}
        {streaming && <Markdown text={streaming} />}
        {thread.running && !streaming && (
          <p {...stylex.props(styles.note)}>
            <span {...stylex.props(styles.spinner)} aria-hidden /> Working…
          </p>
        )}
      </div>
    </aside>
  );
}

function EventRow({ event }: { event: ThreadEvent }) {
  switch (event.type) {
    case "user":
      return (
        <div {...stylex.props(styles.user)}>
          {event.text}
          {event.attachments.length > 0 && (
            <span {...stylex.props(styles.attached)}>
              <Icon name="paperclip" size={12} />
              {event.attachments.map((a) => a.split("/").pop()).join(", ")}
            </span>
          )}
        </div>
      );
    case "text":
      return <Markdown text={event.text} />;
    case "tool":
      return (
        <div {...stylex.props(styles.tool, event.status === "error" && styles.toolError)}>
          <span {...stylex.props(styles.toolIcon)}>
            {event.status === "running" ? (
              <span {...stylex.props(styles.spinner)} aria-label="Running" />
            ) : (
              <Icon name={event.status === "error" ? "close" : "check"} size={12} />
            )}
          </span>
          <span {...stylex.props(styles.toolName)}>{event.name}</span>
          <span {...stylex.props(styles.toolSummary)}>{event.summary}</span>
        </div>
      );
    case "error":
      return <p {...stylex.props(styles.error)}>{event.message}</p>;
    case "result":
    case "text.delta":
      return null;
  }
}

const spin = stylex.keyframes({
  "0%": { transform: "rotate(0deg)" },
  "100%": { transform: "rotate(360deg)" },
});

const styles = stylex.create({
  panel: {
    display: "flex",
    flexDirection: "column",
    width: size.right,
    minHeight: 0,
    height: "100%",
    backgroundColor: colors.surface,
    borderLeftWidth: 1,
    borderLeftStyle: "solid",
    borderLeftColor: colors.border,
    fontFamily: fonts.sans,
    color: colors.text,
  },
  head: {
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    height: size.lg,
    flexShrink: 0,
    paddingLeft: space.md,
    paddingRight: space.sm,
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderBottomColor: colors.border,
  },
  title: {
    flexGrow: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: 13,
    fontWeight: 500,
  },
  scroll: {
    flexGrow: 1,
    minHeight: 0,
    overflowY: "auto",
    display: "flex",
    flexDirection: "column",
    gap: space.sm,
    padding: space.md,
    // Room for the composer when it floats over the panel's foot.
    paddingBottom: 120,
  },
  note: {
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    margin: 0,
    color: colors.faint,
    fontSize: 12,
  },
  user: {
    alignSelf: "flex-end",
    maxWidth: "88%",
    display: "flex",
    flexDirection: "column",
    gap: space.xs,
    paddingBlock: space.sm,
    paddingInline: space.ms,
    borderRadius: radii.lg,
    backgroundColor: colors.activeFill,
    fontSize: 13,
    lineHeight: "19px",
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
  },
  attached: {
    display: "flex",
    alignItems: "center",
    gap: space.xs,
    color: colors.muted,
    fontSize: 12,
  },
  tool: {
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    minWidth: 0,
    height: size.xs,
    color: colors.faint,
    fontSize: 12,
  },
  toolError: { color: colors.danger },
  toolIcon: { display: "grid", placeItems: "center", width: 12, flexShrink: 0 },
  toolName: { flexShrink: 0, color: colors.muted, fontWeight: 500 },
  toolSummary: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  error: { margin: 0, color: colors.danger, fontSize: 13, lineHeight: "19px" },
  spinner: {
    display: "inline-block",
    width: 10,
    height: 10,
    borderRadius: "50%",
    borderWidth: 1.5,
    borderStyle: "dashed",
    borderColor: colors.brand,
    animationName: spin,
    animationDuration: "2.4s",
    animationTimingFunction: "linear",
    animationIterationCount: "infinite",
  },
});
