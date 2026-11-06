"use client";

import * as stylex from "@stylexjs/stylex";
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Replica } from "@/design/replica";
import type { Audience, Comment } from "@/design/schema";
import { audienceLabel, audienceOf, routeLabel, type KnownAgent } from "@/lib/audience";
import { COMMENT_LIMIT, NAME_LIMIT, SELECTION_LIMIT } from "@/lib/limits";
import { isLocalUser, useLocalName } from "@/lib/user";
import { timeAgo } from "@/lib/time";
import { Button, buttonStyle, IconButton } from "./Button";
import { Icon } from "./Icons";
import { Dropdown } from "./Menu";
import { PinFilters, PinIcon, type PinState } from "./PinIcon";
import { raised } from "@/styles/raised";
import { colors, fonts, radii, shadows, size, space } from "@/styles/tokens.stylex";

/** How far right of its pin a popover starts, in pixels. */
const POPOVER_GAP = 36;

export type Mode = "pointer" | "interact" | "comment";

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

/** What a comment's pin shows. `working` is the agent label on its artboard, if any. */
export function pinState(comment: Comment, working: string | undefined): PinState {
  if (comment.resolved) return "resolved";
  if (audienceOf(comment).kind === "people") return "note";
  if (working) return "working";
  return comment.messages.at(-1)?.author.kind === "agent" ? "replied" : "waiting";
}

/** The pointer and comment tools, in a pill at the bottom of the screen. */
interface LayerProps {
  readonly replica: Replica;
  /** The page shown. Pins on artboards on other pages are hidden. */
  readonly page: string;
  readonly comments: ReadonlyMap<string, Comment>;
  readonly openId: string | null;
  readonly draft: Draft | null;
  /** Agent labels by artboard id, for the artboards agents are working on. */
  readonly working: ReadonlyMap<string, string>;
  /** The agents a comment can be for, besides any agent. */
  readonly agents: ReadonlyArray<KnownAgent>;
  readonly onOpen: (id: string | null) => void;
  /** Resolves to nothing once sent, or to why it wasn't, to show. */
  readonly onPost: (body: string) => Promise<string | undefined>;
  readonly onCancelDraft: () => void;
  readonly onReply: (id: string, body: string) => Promise<string | undefined>;
  readonly onResolve: (id: string, resolved: boolean) => void;
  readonly onAudience: (id: string, audience: Audience) => void;
  /** Replaces the newest message, which must be this browser's. */
  readonly onEdit: (id: string, body: string) => Promise<string | undefined>;
  readonly onDelete: (id: string) => void;
  /** Outlines the nodes a linked change touched. */
  readonly onShowChange: (nodeIds: ReadonlyArray<string>) => void;
}

/**
 * Comment pins and the open thread, drawn in canvas coordinates inside the
 * camera's transformed layer. Each pin keeps its screen size at any zoom.
 * A resolved pin leaves the canvas at once, unless its thread is open.
 */
export function CommentLayer(props: LayerProps) {
  const { replica, comments, openId, draft, working } = props;
  const busyAny = [...comments.values()].some(
    (c) => !c.resolved && c.artboardId !== null && working.has(c.artboardId),
  );
  return (
    <div {...stylex.props(styles.layer)}>
      <PinFilters boiling={busyAny} />
      {[...comments.values()].map((comment) => {
        const open = comment.id === openId;
        if (comment.resolved && !open) return null;
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
              <PinIcon
                state={pinState(
                  comment,
                  busy && comment.artboardId !== null ? working.get(comment.artboardId) : undefined,
                )}
                selected={open}
              />
            </button>
            {open && (
              <Thread
                comment={comment}
                working={comment.artboardId === null ? undefined : working.get(comment.artboardId)}
                agents={props.agents}
                onClose={() => props.onOpen(null)}
                onReply={(body) => props.onReply(comment.id, body)}
                onResolve={(resolved) => props.onResolve(comment.id, resolved)}
                onAudience={(audience) => props.onAudience(comment.id, audience)}
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
      <Button
        size="small"
        title="Change your name"
        onClick={() => setEditing(true)}
        style={styles.nameButton}
      >
        {name}
      </Button>
    </span>
  );
}

/**
 * Where a comment went, as a label a person can open to send it elsewhere:
 * any agent (or the agent that took it), one agent, or people only. An agent
 * that has gone stays in the list while the comment is for it.
 */
function AudiencePicker({
  comment,
  agents,
  onChange,
}: {
  comment: Comment;
  agents: ReadonlyArray<KnownAgent>;
  onChange: (audience: Audience) => void;
}) {
  const value = audienceOf(comment);
  const gone = value.kind === "agent" && !agents.some((a) => a.id === value.id);
  const options = gone ? [...agents, { id: value.id, name: value.name }] : agents;
  const choices: ReadonlyArray<readonly [string, string]> = [
    ["agents", value.kind === "agents" ? routeLabel(comment) : "Any agent"],
    ["people", audienceLabel({ kind: "people" })],
    ...options.map(
      (agent) =>
        [
          agent.id,
          value.kind === "agent" && value.id === agent.id
            ? routeLabel(comment)
            : audienceLabel({ kind: "agent", ...agent }),
        ] as const,
    ),
  ];
  return (
    <Dropdown
      label="Who it's for"
      value={value.kind === "agent" ? value.id : value.kind}
      options={choices}
      onPick={(picked) => {
        if (picked === "agents" || picked === "people") return onChange({ kind: picked });
        const agent = options.find((a) => a.id === picked);
        if (agent) onChange({ kind: "agent", id: agent.id, name: agent.name });
      }}
      style={[...buttonStyle({ size: "small" }), styles.audience]}
    >
      <span {...stylex.props(styles.audienceText)}>
        {choices.find(([v]) => v === (value.kind === "agent" ? value.id : value.kind))?.[1]}
      </span>
      <Icon name="chevronDown" size={12} />
    </Dropdown>
  );
}

/** Room kept between a popover and the window's edge, in pixels. */
const EDGE = 6;
/** The top bar's height: popovers flip below their pin rather than slide under it. */
const TOP_BAR = 51;

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
  agents,
  onClose,
  onReply,
  onResolve,
  onAudience,
  onEdit,
  onDelete,
  onShowChange,
}: {
  comment: Comment;
  working: string | undefined;
  agents: ReadonlyArray<KnownAgent>;
  onClose: () => void;
  onReply: (body: string) => Promise<string | undefined>;
  onResolve: (resolved: boolean) => void;
  onAudience: (audience: Audience) => void;
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
          <Button size="small" autoFocus onClick={() => setConfirming(false)}>
            Cancel
          </Button>
          <Button size="small" onClick={onDelete} style={styles.danger}>
            Delete
          </Button>
        </div>
      </Popover>
    );
  }
  return (
    <Popover label="Comment thread">
      <div {...stylex.props(styles.threadHead)}>
        <span {...stylex.props(styles.muted)}>{comment.resolved ? "Resolved" : "Open"}</span>
        <AudiencePicker comment={comment} agents={agents} onChange={onAudience} />
        <span {...stylex.props(styles.spacer)} />
        <Button size="small" onClick={() => setConfirming(true)}>
          Delete
        </Button>
        <Button size="small" onClick={() => onResolve(!comment.resolved)}>
          {comment.resolved ? "Reopen" : "Resolve"}
        </Button>
        <IconButton size="small" icon="close" label="Close" onClick={onClose} />
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
                <Button
                  size="small"
                  variant="ghost"
                  onClick={() => setEditing(true)}
                  style={styles.inlineButton}
                >
                  Edit
                </Button>
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
                    {...stylex.props(raised.control, styles.change)}
                  >
                    {change.label}
                  </button>
                ))}
              </div>
            )}
          </li>
        ))}
      </ol>
      {comment.passedBy && comment.passedBy.length > 0 && (
        <p {...stylex.props(styles.muted)}>
          Passed: {comment.passedBy.map((agent) => agent.name).join(", ")}
        </p>
      )}
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
        <IconButton
          type="submit"
          variant="brand"
          icon="arrowUp"
          label={label}
          disabled={!body.trim() || sending}
        />
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
  "0%": { boxShadow: `0 0 0 0 color-mix(in srgb, ${colors.accent} 60%, transparent)` },
  "100%": { boxShadow: `0 0 0 9px color-mix(in srgb, ${colors.accent} 0%, transparent)` },
});

const styles = stylex.create({
  layer: {
    position: "absolute",
    left: 0,
    top: 0,
    width: 0,
    height: 0,
    fontFamily: fonts.sans,
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
    left: -3,
    bottom: -3,
    display: "block",
    padding: 0,
    borderWidth: 0,
    backgroundColor: "transparent",
    cursor: "var(--cursor-pointer, pointer)",
  },
  popover: {
    position: "absolute",
    left: POPOVER_GAP,
    bottom: -3,
    // As wide as the import card, so the thread's head fits its small buttons.
    width: 300,
    display: "flex",
    flexDirection: "column",
    gap: space.sm,
    padding: space.sm,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: colors.surface,
    boxShadow: shadows.raised,
    cursor: "var(--cursor-arrow, default)",
    userSelect: "text",
  },
  // Mirror the default placement: to the pin's left, or hanging below it.
  popoverLeft: { left: "auto", right: 6 },
  popoverBelow: { bottom: "auto", top: 3 },
  threadHead: { display: "flex", alignItems: "center", gap: space.xs },
  spacer: { flexGrow: 1 },
  muted: { color: colors.muted, fontSize: 12 },
  audienceText: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  /** The audience picker: a small button, its label cut short with an ellipsis. */
  audience: { gap: space.xs, maxWidth: 156, color: colors.muted },
  nameButton: { verticalAlign: "middle" },
  nameInput: {
    height: size.xs,
    paddingInline: space.sm,
    borderWidth: 0,
    borderRadius: radii.sm,
    backgroundColor: colors.sunk,
    boxShadow: shadows.field,
    color: colors.text,
    fontSize: 12,
    fontFamily: "inherit",
    outline: { default: "none", ":focus": `1px solid ${colors.brand}` },
  },
  danger: { color: colors.danger },
  inlineButton: { marginLeft: space.xs },
  messages: {
    display: "flex",
    flexDirection: "column",
    gap: space.sm,
    margin: 0,
    padding: 0,
    maxHeight: 318,
    overflowY: "auto",
    listStyle: "none",
  },
  message: { display: "flex", flexDirection: "column", gap: 3 },
  author: { fontWeight: 600 },
  body: { margin: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere", lineHeight: 1.4 },
  changes: { display: "flex", flexWrap: "wrap", gap: 3, marginTop: 3 },
  /**
   * A change's label, which can wrap, so it's a small button's padding and type with
   * a minimum height rather than a fixed one.
   */
  change: {
    maxWidth: "100%",
    minWidth: 0,
    minHeight: size.xs,
    paddingInline: space.ms,
    paddingBlock: space.xs,
    overflowWrap: "anywhere",
    textAlign: "start",
    whiteSpace: "normal",
    borderRadius: radii.sm,
    fontFamily: fonts.sans,
    fontSize: 12,
    fontWeight: 500,
    lineHeight: "15px",
    cursor: "var(--cursor-pointer, pointer)",
  },
  working: {
    display: "flex",
    alignItems: "center",
    gap: space.sm,
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
    padding: space.sm,
    borderWidth: 0,
    borderRadius: radii.sm,
    backgroundColor: colors.sunk,
    boxShadow: shadows.field,
    color: "inherit",
    font: "inherit",
    resize: "none",
    outline: { default: "none", ":focus": `1px solid ${colors.brand}` },
  },
});
