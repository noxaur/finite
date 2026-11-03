"use client";

import * as stylex from "@stylexjs/stylex";
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Replica } from "@/design/replica";
import type { Comment } from "@/design/schema";
import { COMMENT_LIMIT, NAME_LIMIT, SELECTION_LIMIT } from "@/lib/limits";
import { isLocalUser, useLocalName } from "@/lib/user";
import { timeAgo } from "@/lib/time";
import { PIN_PATH } from "@/lib/cursors";
import { PinFilters, PinIcon, type PinState } from "./PinIcon";
import { colors, radii, space } from "@/styles/tokens.stylex";

/** How far right of its pin a popover starts, in pixels. */
const POPOVER_GAP = 36;
/** How long a resolved pin stays on the canvas, fading, before it goes. The comments panel keeps it. */
export const DECAY_MS = 60_000;

export type Mode = "pointer" | "comment";

/** A comment being written: where its pin goes, before it's posted. */
export interface Draft {
  readonly artboardId: string | null;
  readonly nodeId: string | null;
  /** More elements in the same artboard, picked with shift-click. */
  readonly extraNodeIds: ReadonlyArray<string>;
  /** Relative to the artboard, or canvas coordinates when `artboardId` is `null`. */
  readonly x: number;
  readonly y: number;
}

/** Every element a draft or comment points at, its `nodeId` first. */
export function selectionOf(
  pin: Pick<Draft, "nodeId"> & { readonly extraNodeIds?: ReadonlyArray<string> },
): ReadonlyArray<string> {
  return pin.nodeId === null ? [] : [pin.nodeId, ...(pin.extraNodeIds ?? [])];
}

/**
 * Adds `nodeId` to the draft's elements, or takes it out if it's there.
 * Returns `null` when that leaves none, and the draft as it was when it's full.
 */
export function toggleInDraft(draft: Draft, nodeId: string): Draft | null {
  const nodes = selectionOf(draft);
  if (!nodes.includes(nodeId) && nodes.length >= SELECTION_LIMIT) return draft;
  const next = nodes.includes(nodeId) ? nodes.filter((id) => id !== nodeId) : [...nodes, nodeId];
  const [first, ...rest] = next;
  return first === undefined ? null : { ...draft, nodeId: first, extraNodeIds: rest };
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

/**
 * How long ago `comment` was resolved, or `null` while it's open. A comment
 * resolved before the server recorded when counts as long ago.
 */
function resolvedFor(comment: Comment, now: number): number | null {
  if (!comment.resolved) return null;
  return comment.resolvedAt === undefined ? Infinity : now - comment.resolvedAt;
}

/** What a comment's pin shows. `working` is the agent label on its artboard, if any. */
export function pinState(comment: Comment, working: string | undefined): PinState {
  if (comment.resolved) return "resolved";
  if (working) return "working";
  return comment.messages.at(-1)?.author.kind === "agent" ? "replied" : "waiting";
}

/** The pointer and comment tools, in a pill at the bottom of the screen. */
export function ToolPill({ mode, onMode }: { mode: Mode; onMode: (mode: Mode) => void }) {
  return (
    <div {...stylex.props(styles.pill)} role="toolbar" aria-label="Tools">
      {/* The pill renders before any pins, so it carries its own wobble filter. */}
      <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true">
        <filter id="tool-wob" x="-20%" y="-20%" width="140%" height="140%">
          <feTurbulence type="fractalNoise" baseFrequency="0.045" numOctaves="1" seed="3" />
          <feDisplacementMap
            in="SourceGraphic"
            scale="3"
            xChannelSelector="R"
            yChannelSelector="G"
          />
        </filter>
      </svg>
      <button
        type="button"
        aria-pressed={mode === "pointer"}
        title="Pointer (V)"
        onClick={() => onMode("pointer")}
        {...stylex.props(styles.pillButton, mode === "pointer" && styles.pillActive)}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" overflow="visible" aria-hidden="true">
          <path
            d="M6 3.5 18.5 12l-5.6 1.3-2.9 5.7z"
            fill="currentColor"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinejoin="round"
            filter="url(#tool-wob)"
          />
        </svg>
      </button>
      <button
        type="button"
        aria-pressed={mode === "comment"}
        title="Comment (C)"
        onClick={() => onMode("comment")}
        {...stylex.props(styles.pillButton, mode === "comment" && styles.pillActive)}
      >
        {/* The pin's own outline, so the tool looks like what it places. */}
        <svg width="22" height="20" viewBox="0 0 40 36" overflow="visible" aria-hidden="true">
          <path
            d={PIN_PATH}
            fill="none"
            stroke="currentColor"
            strokeWidth="3.2"
            strokeLinejoin="round"
            filter="url(#tool-wob)"
          />
        </svg>
      </button>
    </div>
  );
}

interface LayerProps {
  readonly replica: Replica;
  /** The page shown. Pins on artboards on other pages are hidden. */
  readonly page: string;
  readonly comments: ReadonlyMap<string, Comment>;
  readonly openId: string | null;
  readonly draft: Draft | null;
  /** Agent labels by artboard id, for the artboards agents are working on. */
  readonly working: ReadonlyMap<string, string>;
  readonly onOpen: (id: string | null) => void;
  /** Resolves to nothing once sent, or to why it wasn't, to show. */
  readonly onPost: (body: string) => Promise<string | undefined>;
  readonly onCancelDraft: () => void;
  readonly onReply: (id: string, body: string) => Promise<string | undefined>;
  readonly onResolve: (id: string, resolved: boolean) => void;
  /** Replaces the newest message, which must be this browser's. */
  readonly onEdit: (id: string, body: string) => Promise<string | undefined>;
  readonly onDelete: (id: string) => void;
  /** Outlines the nodes a linked change touched. */
  readonly onShowChange: (nodeIds: ReadonlyArray<string>) => void;
}

/**
 * Comment pins and the open thread, drawn in canvas coordinates inside the
 * camera's transformed layer. Each pin keeps its screen size at any zoom.
 * A resolved pin fades out over `DECAY_MS` and then leaves the canvas,
 * unless its thread is open.
 */
export function CommentLayer(props: LayerProps) {
  const { replica, comments, openId, draft, working } = props;
  const now = Date.now();
  const busyAny = [...comments.values()].some(
    (c) => !c.resolved && c.artboardId !== null && working.has(c.artboardId),
  );
  // Re-render when the next fading pin should go.
  const [, setExpired] = useState(0);
  const nextExpiry = Math.min(
    ...[...comments.values()].map((c) => DECAY_MS - (resolvedFor(c, now) ?? Infinity)),
  );
  useEffect(() => {
    if (nextExpiry <= 0 || nextExpiry === Infinity) return;
    const timer = setTimeout(() => setExpired((n) => n + 1), nextExpiry);
    return () => clearTimeout(timer);
  }, [nextExpiry]);
  return (
    <div {...stylex.props(styles.layer)}>
      <PinFilters boiling={busyAny} />
      {[...comments.values()].map((comment) => {
        const open = comment.id === openId;
        const age = resolvedFor(comment, now);
        if (age !== null && age >= DECAY_MS && !open) return null;
        const at = pinPosition(replica, comment);
        if (!at) return null;
        const board = comment.artboardId === null ? undefined : replica.get(comment.artboardId);
        if (board?.parent === null && replica.pageOf(board) !== props.page) return null;
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
              {...stylex.props(styles.pin)}
            >
              {age !== null && !open ? (
                // Keyed by when it was resolved, so resolving again restarts the fade.
                <Decay key={comment.resolvedAt} age={age}>
                  <PinIcon state="resolved" />
                </Decay>
              ) : (
                <PinIcon
                  state={pinState(
                    comment,
                    busy && comment.artboardId !== null
                      ? working.get(comment.artboardId)
                      : undefined,
                  )}
                  selected={open}
                />
              )}
            </button>
            {open && (
              <Thread
                comment={comment}
                working={comment.artboardId === null ? undefined : working.get(comment.artboardId)}
                onClose={() => props.onOpen(null)}
                onReply={(body) => props.onReply(comment.id, body)}
                onResolve={(resolved) => props.onResolve(comment.id, resolved)}
                onEdit={(body) => props.onEdit(comment.id, body)}
                onDelete={() => props.onDelete(comment.id)}
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

/**
 * Fades its children out over what's left of `DECAY_MS`. The delay is read
 * once: changing it later would shift the running animation by the time
 * that already passed.
 */
function Decay({ age, children }: { age: number; children: ReactNode }) {
  const [delay] = useState(-age);
  return <span {...stylex.props(styles.decaying, styles.decayFrom(delay))}>{children}</span>;
}

function DraftPin({ replica, draft, onPost, onCancelDraft }: LayerProps & { draft: Draft }) {
  const at = pinPosition(replica, draft);
  if (!at) return null;
  return (
    <div data-camera-ignore {...stylex.props(styles.anchor(at.x, at.y), styles.raised)}>
      <div {...stylex.props(styles.pin)}>
        <PinIcon state="draft" selected />
      </div>
      <Popover>
        <NameLine />
        {draft.nodeId !== null && <SelectionLine count={selectionOf(draft).length} />}
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

/** How many elements the draft points at, and how to change that. */
function SelectionLine({ count }: { count: number }) {
  return (
    <span data-selection-count={count} {...stylex.props(styles.muted)}>
      {count === 1
        ? "Shift-click to add elements"
        : `${count} elements · Shift-click to add or remove`}
    </span>
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
  onEdit,
  onDelete,
  onShowChange,
}: {
  comment: Comment;
  working: string | undefined;
  onClose: () => void;
  onReply: (body: string) => Promise<string | undefined>;
  onResolve: (resolved: boolean) => void;
  onEdit: (body: string) => Promise<string | undefined>;
  onDelete: () => void;
  onShowChange: (nodeIds: ReadonlyArray<string>) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [editRequested, setEditing] = useState(false);
  const last = comment.messages.length - 1;
  // Only your own newest message: once an agent answers, it's part of the record.
  const editable = last >= 0 && isLocalUser(comment.messages[last]!.author);
  const editing = editRequested && editable;
  if (confirming) {
    return (
      <Popover label="Delete comment">
        <p {...stylex.props(styles.body)}>Delete this comment and its replies?</p>
        <div {...stylex.props(styles.threadHead)}>
          <span {...stylex.props(styles.spacer)} />
          <button
            type="button"
            autoFocus
            onClick={() => setConfirming(false)}
            {...stylex.props(styles.textButton)}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onDelete}
            {...stylex.props(styles.textButton, styles.danger)}
          >
            Delete
          </button>
        </div>
      </Popover>
    );
  }
  return (
    <Popover label="Comment thread">
      <div {...stylex.props(styles.threadHead)}>
        <span {...stylex.props(styles.muted)}>{comment.resolved ? "Resolved" : "Open"}</span>
        <span {...stylex.props(styles.spacer)} />
        <button
          type="button"
          onClick={() => setConfirming(true)}
          {...stylex.props(styles.textButton)}
        >
          Delete
        </button>
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
              <span {...stylex.props(styles.muted)}>
                {timeAgo(message.at)}
                {message.editedAt !== undefined && " · edited"}
              </span>
              {i === last && editable && !editing && (
                <button
                  type="button"
                  onClick={() => setEditing(true)}
                  {...stylex.props(styles.textButton, styles.inlineButton)}
                >
                  Edit
                </button>
              )}
            </div>
            {i === last && editing ? (
              <Composer
                placeholder="Edit your message"
                initial={message.body}
                autoFocus
                label="Save"
                onSubmit={async (body) => {
                  const failure = await onEdit(body);
                  if (failure === undefined) setEditing(false);
                  return failure;
                }}
                onCancel={() => setEditing(false)}
              />
            ) : (
              <p {...stylex.props(styles.body)}>{message.body}</p>
            )}
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
      {!editing && <Composer placeholder="Reply" onSubmit={onReply} onCancel={onClose} />}
    </Popover>
  );
}

function Composer({
  placeholder,
  initial = "",
  autoFocus,
  label = "Send",
  onSubmit,
  onCancel,
}: {
  placeholder: string;
  initial?: string;
  autoFocus?: boolean;
  label?: string;
  onSubmit: (body: string) => Promise<string | undefined>;
  onCancel: () => void;
}) {
  const [body, setBody] = useState(initial);
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState<string>();
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);

  const submit = async () => {
    if (!body.trim() || sending) return;
    setSending(true);
    const failure = await onSubmit(body);
    // Keep the text after a failure, so it can be sent again.
    if (failure === undefined) setBody("");
    setFailed(failure);
    setSending(false);
  };

  return (
    <>
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
          maxLength={COMMENT_LIMIT}
          placeholder={placeholder}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void submit();
            } else if (e.key === "Escape") {
              // Only this composer closes, not the thread around it.
              e.preventDefault();
              e.stopPropagation();
              onCancel();
            }
          }}
          {...stylex.props(styles.input)}
        />
        <button
          type="submit"
          disabled={!body.trim() || sending}
          aria-label={label}
          {...stylex.props(styles.send)}
        >
          ↑
        </button>
      </form>
      {failed && (
        <p role="alert" {...stylex.props(styles.failed)}>
          {failed}
        </p>
      )}
    </>
  );
}

const pulse = stylex.keyframes({
  "0%": { boxShadow: `0 0 0 0 rgba(194, 65, 12, 0.5)` },
  "100%": { boxShadow: `0 0 0 10px rgba(194, 65, 12, 0)` },
});

// Holds most of its ink, then thins out at the end.
const decay = stylex.keyframes({
  "0%": { opacity: 1 },
  "70%": { opacity: 0.7 },
  "100%": { opacity: 0 },
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
    cursor: "var(--cursor-pointer, pointer)",
  },
  pillActive: {
    backgroundColor: { default: colors.accent, ":hover": colors.accent },
    color: colors.onAccent,
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
  decaying: {
    display: "block",
    animationName: decay,
    animationDuration: `${DECAY_MS}ms`,
    animationTimingFunction: "linear",
    animationFillMode: "forwards",
  },
  // A negative delay starts the fade partway, so a reload doesn't restart it.
  decayFrom: (delayMs: number) => ({ animationDelay: `${delayMs}ms` }),
  pin: {
    position: "absolute",
    left: -3,
    bottom: -2,
    display: "block",
    padding: 0,
    borderWidth: 0,
    backgroundColor: "transparent",
    cursor: "var(--cursor-pointer, pointer)",
  },
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
    cursor: "var(--cursor-arrow, default)",
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
    cursor: "var(--cursor-pointer, pointer)",
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
  danger: { color: colors.danger },
  inlineButton: { height: 18, marginLeft: 2, color: colors.muted },
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
    cursor: "var(--cursor-pointer, pointer)",
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
  failed: { margin: 0, marginTop: space.xs, fontSize: 12, color: colors.danger },
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
    color: colors.onAccent,
    fontSize: 14,
    cursor: {
      default: "var(--cursor-pointer, pointer)",
      ":disabled": "var(--cursor-not-allowed, not-allowed)",
    },
  },
});
