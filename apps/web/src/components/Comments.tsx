"use client";

import * as stylex from "@stylexjs/stylex";
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Replica } from "@/design/replica";
import type { Comment, CommentMessage } from "@/design/schema";
import { isLocalUser, NAME_LIMIT, useLocalName } from "@/lib/user";
import { timeAgo } from "@/lib/time";

/** How far right of its pin a popover starts, in pixels. */
const POPOVER_GAP = 36;
import { colors, radii, space } from "@/styles/tokens.stylex";

export type Mode = "pointer" | "comment";

/** A comment being written: where its pin goes, before it's posted. */
export interface Draft {
  readonly artboardId: string | null;
  readonly nodeId: string | null;
  /** Relative to the artboard, or canvas coordinates when `artboardId` is `null`. */
  readonly x: number;
  readonly y: number;
}

/** Where a pin sits on the canvas. A pin whose artboard is gone stays where it last was. */
export function pinPosition(
  replica: Replica,
  pin: Pick<Draft, "artboardId" | "x" | "y"> & Pick<Partial<Comment>, "detachedAt">,
): { x: number; y: number } | null {
  if (pin.artboardId === null) return { x: pin.x, y: pin.y };
  const board = replica.get(pin.artboardId);
  if (board?.parent === null) return { x: (board.x ?? 0) + pin.x, y: (board.y ?? 0) + pin.y };
  // The artboard is gone: the pin stays where it was when it went.
  return pin.detachedAt ?? null;
}

/** The pointer and comment tools, in a pill at the bottom of the screen. */
export function ToolPill({ mode, onMode }: { mode: Mode; onMode: (mode: Mode) => void }) {
  return (
    <div {...stylex.props(styles.pill)} role="toolbar" aria-label="Tools">
      <button
        type="button"
        aria-pressed={mode === "pointer"}
        title="Pointer (V)"
        onClick={() => onMode("pointer")}
        {...stylex.props(styles.pillButton, mode === "pointer" && styles.pillActive)}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M6 3.5 18.5 12l-5.6 1.3-2.9 5.7z" fill="currentColor" />
        </svg>
      </button>
      <button
        type="button"
        aria-pressed={mode === "comment"}
        title="Comment (C)"
        onClick={() => onMode("comment")}
        {...stylex.props(styles.pillButton, mode === "comment" && styles.pillActive)}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
          <path
            d="M12 3.5a8.5 8.5 0 1 1-4.3 15.8L3.5 20.5l1.2-4.1A8.5 8.5 0 0 1 12 3.5Z"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinejoin="round"
          />
        </svg>
      </button>
    </div>
  );
}

interface LayerProps {
  readonly replica: Replica;
  readonly comments: ReadonlyMap<string, Comment>;
  readonly openId: string | null;
  readonly draft: Draft | null;
  /** Agent labels by artboard id, for the artboards agents are working on. */
  readonly working: ReadonlyMap<string, string>;
  readonly onOpen: (id: string | null) => void;
  readonly onPost: (body: string) => Promise<boolean>;
  readonly onCancelDraft: () => void;
  readonly onReply: (id: string, body: string) => Promise<boolean>;
  readonly onResolve: (id: string, resolved: boolean) => void;
  /** Outlines the nodes a linked change touched. */
  readonly onShowChange: (nodeIds: ReadonlyArray<string>) => void;
}

/**
 * Comment pins and the open thread, drawn in canvas coordinates inside the
 * camera's transformed layer. Each pin keeps its screen size at any zoom.
 */
export function CommentLayer(props: LayerProps) {
  const { replica, comments, openId, draft, working } = props;
  return (
    <div {...stylex.props(styles.layer)}>
      {[...comments.values()].map((comment) => {
        const at = pinPosition(replica, comment);
        if (!at) return null;
        const open = comment.id === openId;
        const busy =
          !comment.resolved && comment.artboardId !== null && working.has(comment.artboardId);
        return (
          <div
            key={comment.id}
            data-camera-ignore
            {...stylex.props(styles.anchor(at.x, at.y), open && styles.raised)}
          >
            <button
              type="button"
              aria-label={`Comment: ${comment.messages[0]?.body ?? ""}`}
              onClick={() => props.onOpen(open ? null : comment.id)}
              {...stylex.props(
                styles.pin,
                comment.resolved && styles.pinResolved,
                open && styles.pinOpen,
                busy && styles.pinBusy,
              )}
            >
              {comment.resolved ? "✓" : initial(comment.messages[0])}
            </button>
            {open && (
              <Thread
                comment={comment}
                working={comment.artboardId === null ? undefined : working.get(comment.artboardId)}
                onClose={() => props.onOpen(null)}
                onReply={(body) => props.onReply(comment.id, body)}
                onResolve={(resolved) => props.onResolve(comment.id, resolved)}
                onShowChange={props.onShowChange}
              />
            )}
          </div>
        );
      })}
      {draft && <DraftPin {...props} draft={draft} />}
    </div>
  );
}

function DraftPin({ replica, draft, onPost, onCancelDraft }: LayerProps & { draft: Draft }) {
  const at = pinPosition(replica, draft);
  if (!at) return null;
  return (
    <div data-camera-ignore {...stylex.props(styles.anchor(at.x, at.y), styles.raised)}>
      <div {...stylex.props(styles.pin, styles.pinOpen)} />
      <Popover>
        <NameLine />
        <Composer
          placeholder="Add a comment"
          autoFocus
          onSubmit={onPost}
          onCancel={onCancelDraft}
        />
      </Popover>
    </div>
  );
}

/**
 * "Commenting as Guest", where clicking the name lets you change it. There
 * are no accounts, so the name is saved in this browser only.
 */
function NameLine() {
  const [name, setName] = useLocalName();
  const [editing, setEditing] = useState(false);
  if (editing) {
    return (
      <input
        autoFocus
        defaultValue={name === "Guest" ? "" : name}
        placeholder="Your name"
        maxLength={NAME_LIMIT}
        aria-label="Your name"
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            setName(e.currentTarget.value);
            setEditing(false);
          } else if (e.key === "Escape") {
            e.stopPropagation();
            setEditing(false);
          }
        }}
        onBlur={(e) => {
          setName(e.currentTarget.value);
          setEditing(false);
        }}
        {...stylex.props(styles.nameInput)}
      />
    );
  }
  return (
    <span {...stylex.props(styles.muted)}>
      Commenting as{" "}
      <button
        type="button"
        title="Change your name"
        onClick={() => setEditing(true)}
        {...stylex.props(styles.nameButton)}
      >
        {name}
      </button>
    </span>
  );
}

/** Room kept between a popover and the window's edge, in pixels. */
const EDGE = 8;
/** The top bar's height: popovers flip below their pin rather than slide under it. */
const TOP_BAR = 56;

/**
 * The box beside a pin. It opens up and to the right of the pin, and flips
 * left or below when that would leave the window. It decides from the pin's
 * screen position, which flipping doesn't change, so it can't flip back and forth.
 */
function Popover({ label, children }: { label?: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [flip, setFlip] = useState({ left: false, below: false });
  useLayoutEffect(() => {
    const box = ref.current;
    const pin = box?.parentElement?.getBoundingClientRect();
    if (!box || !pin) return;
    // The anchor undoes the canvas zoom, so these sizes are screen pixels.
    const left = pin.left + POPOVER_GAP + box.offsetWidth > window.innerWidth - EDGE;
    const below =
      pin.top - box.offsetHeight < TOP_BAR &&
      pin.top + box.offsetHeight < window.innerHeight - EDGE;
    setFlip((prev) => (prev.left === left && prev.below === below ? prev : { left, below }));
  });
  return (
    <div
      ref={ref}
      {...(label ? { role: "dialog", "aria-label": label } : {})}
      {...stylex.props(
        styles.popover,
        flip.left && styles.popoverLeft,
        flip.below && styles.popoverBelow,
      )}
    >
      {children}
    </div>
  );
}

function Thread({
  comment,
  working,
  onClose,
  onReply,
  onResolve,
  onShowChange,
}: {
  comment: Comment;
  working: string | undefined;
  onClose: () => void;
  onReply: (body: string) => Promise<boolean>;
  onResolve: (resolved: boolean) => void;
  onShowChange: (nodeIds: ReadonlyArray<string>) => void;
}) {
  return (
    <Popover label="Comment thread">
      <div {...stylex.props(styles.threadHead)}>
        <span {...stylex.props(styles.muted)}>{comment.resolved ? "Resolved" : "Open"}</span>
        <span {...stylex.props(styles.spacer)} />
        <button
          type="button"
          onClick={() => onResolve(!comment.resolved)}
          {...stylex.props(styles.textButton)}
        >
          {comment.resolved ? "Reopen" : "Resolve"}
        </button>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          {...stylex.props(styles.textButton)}
        >
          ×
        </button>
      </div>
      <ol {...stylex.props(styles.messages)}>
        {comment.messages.map((message, i) => (
          <li key={i} {...stylex.props(styles.message)}>
            <div>
              <span {...stylex.props(styles.author)}>
                {isLocalUser(message.author) ? "You" : message.author.name}
              </span>{" "}
              <span {...stylex.props(styles.muted)}>{timeAgo(message.at)}</span>
            </div>
            <p {...stylex.props(styles.body)}>{message.body}</p>
            {message.changes && message.changes.length > 0 && (
              <div {...stylex.props(styles.changes)}>
                {message.changes.map((change) => (
                  <button
                    key={change.seq}
                    type="button"
                    title="Show what changed"
                    onClick={() => onShowChange(change.nodeIds)}
                    {...stylex.props(styles.change)}
                  >
                    {change.label}
                  </button>
                ))}
              </div>
            )}
          </li>
        ))}
      </ol>
      {working && (
        <p {...stylex.props(styles.working)}>
          <span {...stylex.props(styles.workingDot)} /> {working}
        </p>
      )}
      <Composer placeholder="Reply" onSubmit={onReply} onCancel={onClose} />
    </Popover>
  );
}

function Composer({
  placeholder,
  autoFocus,
  onSubmit,
  onCancel,
}: {
  placeholder: string;
  autoFocus?: boolean;
  onSubmit: (body: string) => Promise<boolean>;
  onCancel: () => void;
}) {
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);

  const submit = async () => {
    if (!body.trim() || sending) return;
    setSending(true);
    if (await onSubmit(body)) setBody("");
    setSending(false);
  };

  return (
    <form
      {...stylex.props(styles.composer)}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <textarea
        ref={ref}
        value={body}
        rows={2}
        placeholder={placeholder}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void submit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
        {...stylex.props(styles.input)}
      />
      <button
        type="submit"
        disabled={!body.trim() || sending}
        aria-label="Send"
        {...stylex.props(styles.send)}
      >
        ↑
      </button>
    </form>
  );
}

const initial = (message: CommentMessage | undefined) =>
  message && isLocalUser(message.author) ? "Y" : (message?.author.name[0]?.toUpperCase() ?? "?");

const pulse = stylex.keyframes({
  "0%": { boxShadow: `0 0 0 0 rgba(194, 65, 12, 0.5)` },
  "100%": { boxShadow: `0 0 0 10px rgba(194, 65, 12, 0)` },
});

const styles = stylex.create({
  pill: {
    position: "absolute",
    left: "50%",
    bottom: space.md,
    transform: "translateX(-50%)",
    display: "flex",
    gap: 2,
    padding: 4,
    borderRadius: 999,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: colors.surface,
    boxShadow: "0 4px 16px rgba(0, 0, 0, 0.08)",
  },
  pillButton: {
    display: "grid",
    placeItems: "center",
    width: 36,
    height: 32,
    borderWidth: 0,
    borderRadius: 999,
    backgroundColor: { default: "transparent", ":hover": colors.bg },
    color: colors.text,
    cursor: "pointer",
  },
  pillActive: {
    backgroundColor: { default: colors.accent, ":hover": colors.accent },
    color: "white",
  },
  layer: {
    position: "absolute",
    left: 0,
    top: 0,
    width: 0,
    height: 0,
    fontFamily: "ui-sans-serif, system-ui, sans-serif",
    fontSize: 13,
    color: colors.text,
  },
  // The pin's tip sits on the point; the whole anchor keeps its screen size.
  anchor: (x: number, y: number) => ({
    position: "absolute",
    left: x,
    top: y,
    transform: "scale(var(--inv-zoom, 1))",
    transformOrigin: "0 0",
  }),
  raised: { zIndex: 1 },
  pin: {
    position: "absolute",
    left: 0,
    bottom: 0,
    display: "grid",
    placeItems: "center",
    width: 28,
    height: 28,
    padding: 0,
    borderWidth: 2,
    borderStyle: "solid",
    borderColor: "white",
    borderRadius: "14px 14px 14px 2px",
    backgroundColor: colors.accent,
    color: "white",
    fontSize: 12,
    fontWeight: 600,
    fontFamily: "inherit",
    boxShadow: "0 1px 4px rgba(0, 0, 0, 0.25)",
    cursor: "pointer",
  },
  pinResolved: { backgroundColor: colors.ok },
  pinOpen: { outline: `2px solid ${colors.accent}`, outlineOffset: 1 },
  pinBusy: { animationName: pulse, animationDuration: "1.2s", animationIterationCount: "infinite" },
  popover: {
    position: "absolute",
    left: POPOVER_GAP,
    bottom: -4,
    width: 280,
    display: "flex",
    flexDirection: "column",
    gap: space.sm,
    padding: space.sm,
    borderRadius: radii.md,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: colors.surface,
    boxShadow: "0 8px 24px rgba(0, 0, 0, 0.12)",
    cursor: "auto",
    userSelect: "text",
  },
  // Mirror the default placement: to the pin's left, or hanging below it.
  popoverLeft: { left: "auto", right: 8 },
  popoverBelow: { bottom: "auto", top: 4 },
  threadHead: { display: "flex", alignItems: "center", gap: space.xs },
  spacer: { flexGrow: 1 },
  muted: { color: colors.muted, fontSize: 12 },
  nameButton: {
    padding: 0,
    borderWidth: 0,
    backgroundColor: "transparent",
    color: colors.text,
    font: "inherit",
    textDecoration: "underline",
    textDecorationStyle: "dotted",
    textUnderlineOffset: 2,
    cursor: "pointer",
  },
  nameInput: {
    height: 24,
    paddingInline: 6,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    borderRadius: radii.sm,
    backgroundColor: "transparent",
    color: colors.text,
    fontSize: 12,
    fontFamily: "inherit",
  },
  textButton: {
    paddingInline: 6,
    height: 22,
    borderWidth: 0,
    borderRadius: 4,
    backgroundColor: { default: "transparent", ":hover": colors.bg },
    color: "inherit",
    font: "inherit",
    fontSize: 12,
    cursor: "pointer",
  },
  messages: {
    display: "flex",
    flexDirection: "column",
    gap: space.sm,
    margin: 0,
    padding: 0,
    maxHeight: 320,
    overflowY: "auto",
    listStyle: "none",
  },
  message: { display: "flex", flexDirection: "column", gap: 2 },
  author: { fontWeight: 600 },
  body: { margin: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere", lineHeight: 1.4 },
  changes: { display: "flex", flexWrap: "wrap", gap: 4, marginTop: 2 },
  change: {
    paddingInline: 6,
    paddingBlock: 1,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    borderRadius: 4,
    backgroundColor: { default: colors.bg, ":hover": colors.surface },
    color: "inherit",
    font: "inherit",
    fontSize: 12,
    cursor: "pointer",
  },
  working: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    margin: 0,
    color: colors.muted,
    fontSize: 12,
  },
  workingDot: {
    width: 6,
    height: 6,
    borderRadius: "50%",
    backgroundColor: colors.accent,
    animationName: pulse,
    animationDuration: "1.2s",
    animationIterationCount: "infinite",
  },
  composer: { display: "flex", alignItems: "flex-end", gap: space.xs, margin: 0 },
  input: {
    flexGrow: 1,
    minHeight: 36,
    maxHeight: 120,
    padding: 6,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    borderRadius: radii.sm,
    backgroundColor: colors.bg,
    color: "inherit",
    font: "inherit",
    resize: "none",
    outline: { default: "none", ":focus": `2px solid ${colors.accent}` },
  },
  send: {
    width: 28,
    height: 28,
    borderWidth: 0,
    borderRadius: "50%",
    backgroundColor: { default: colors.accent, ":disabled": colors.border },
    color: "white",
    fontSize: 14,
    cursor: { default: "pointer", ":disabled": "default" },
  },
});
