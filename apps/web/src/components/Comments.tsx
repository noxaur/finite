"use client";

import * as stylex from "@stylexjs/stylex";
import type { Comment, Frame, Rect } from "@finite/protocol";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { bridgeOf } from "@/canvas/bridge";
import { finite } from "@/client/finite";
import type { CanvasEditor, EditorState } from "@/canvas/editor";
import { pinSpot, pinState } from "@/canvas/pins";
import { colors, fonts, radii, shadows, space } from "@/styles/tokens.stylex";
import { Button, IconButton } from "./Button";
import { PinFilters, PinIcon } from "./PinIcon";
import { TimeAgo } from "./TimeAgo";

/** The canvas tools the old tool rail switches between. */
export type Mode = "pointer" | "interact" | "comment";

/** How far right of its pin a popover starts, in pixels. */
const POPOVER_GAP = 36;

/** Measures every element comments point at, frame by frame, again after each frame update. */
function useAnchorRects(comments: readonly Comment[], updates: number) {
  const [rects, setRects] = useState<Record<string, Record<string, Rect[]>>>({});
  const wanted = new Map<string, Set<string>>();
  for (const c of comments) {
    if (!("frameId" in c.anchor) || c.anchor.loc === undefined) continue;
    const set = wanted.get(c.anchor.frameId) ?? new Set();
    set.add(c.anchor.loc);
    wanted.set(c.anchor.frameId, set);
  }
  const key = JSON.stringify([...wanted].map(([f, l]) => [f, [...l]]));
  useEffect(() => {
    let live = true;
    const want = JSON.parse(key) as [string, string[]][];
    void Promise.all(
      want.map(async ([frameId, locs]) => {
        const bridge = bridgeOf(frameId);
        if (!bridge) return [frameId, null] as const;
        return [frameId, await bridge.rects(locs).catch(() => null)] as const;
      }),
    ).then((found) => {
      if (!live) return;
      const next: Record<string, Record<string, Rect[]>> = {};
      for (const [frameId, r] of found) if (r) next[frameId] = r;
      setRects(next);
    });
    return () => {
      live = false;
    };
  }, [key, updates]);
  return rects;
}

/**
 * The comment pins on the canvas, the open thread, and the composer for a new comment. They sit
 * in the camera's world and keep their screen size. The comment tool (C) places a new one on
 * the element under the pointer, or on the canvas.
 */
export function CommentLayer({
  designId,
  canvasId,
  comments,
  editor,
  state,
}: {
  designId: string;
  canvasId: string;
  comments: readonly Comment[];
  editor: CanvasEditor;
  state: EditorState;
}) {
  const rects = useAnchorRects(comments, state.updates);
  const frameOf = (id: string) => {
    const f: Frame | undefined = editor.frame(id);
    return f ? { box: editor.boxOf(f) } : undefined;
  };
  const request = async (run: () => Promise<unknown>): Promise<string | undefined> => {
    try {
      await run();
      return undefined;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  };
  const ids = { designId, canvasId };

  return (
    <div {...stylex.props(styles.layer)} data-canvas-ui="" data-camera-ignore="">
      <PinFilters boiling={false} />
      {comments.map((comment) => {
        const anchor = comment.anchor;
        const spot = pinSpot(
          anchor,
          frameOf,
          "frameId" in anchor
            ? (rects[anchor.frameId] ?? (bridgeOf(anchor.frameId) ? {} : null))
            : null,
        );
        if (!spot) return null;
        const open = state.openComment === comment.id;
        return (
          <div
            key={comment.id}
            {...stylex.props(styles.anchor(spot.at.x, spot.at.y), open && styles.raised)}
          >
            <button
              type="button"
              aria-label={`Comment by ${comment.author.name}`}
              title={spot.moved ? "Its element moved or is gone" : undefined}
              onClick={() => editor.openComment(open ? null : comment.id)}
              {...stylex.props(styles.pin)}
            >
              <PinIcon state={pinState(comment)} selected={open} />
            </button>
            {spot.moved && <span {...stylex.props(styles.moved)}>moved</span>}
            {open && (
              <Thread
                comment={comment}
                onClose={() => editor.openComment(null)}
                onReply={(text) =>
                  request(() =>
                    finite.request("comment.reply", { ...ids, commentId: comment.id, text }),
                  )
                }
                onResolve={(resolved) =>
                  void request(() =>
                    finite.request(resolved ? "comment.resolve" : "comment.reopen", {
                      ...ids,
                      commentId: comment.id,
                    }),
                  )
                }
              />
            )}
          </div>
        );
      })}
      {state.commentDraft && (
        <div
          {...stylex.props(
            styles.anchor(state.commentDraft.at.x, state.commentDraft.at.y),
            styles.raised,
          )}
        >
          <span {...stylex.props(styles.pin)}>
            <PinIcon state="draft" />
          </span>
          <Popover label="New comment">
            <Composer
              placeholder="Add a comment"
              autoFocus
              label="Post"
              onCancel={() => editor.cancelCommentDraft()}
              onSubmit={async (text) => {
                const anchor = state.commentDraft!.anchor;
                const failure = await request(() =>
                  finite.request("comment.add", { ...ids, anchor, text }),
                );
                if (failure === undefined) editor.cancelCommentDraft();
                return failure;
              }}
            />
          </Popover>
        </div>
      )}
    </div>
  );
}

function Popover({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div role="dialog" aria-label={label} {...stylex.props(styles.popover)}>
      {children}
    </div>
  );
}

function Thread({
  comment,
  onClose,
  onReply,
  onResolve,
}: {
  comment: Comment;
  onClose: () => void;
  onReply: (text: string) => Promise<string | undefined>;
  onResolve: (resolved: boolean) => void;
}) {
  const resolved = comment.resolvedAt !== undefined;
  const messages = [
    { id: comment.id, author: comment.author, text: comment.text, createdAt: comment.createdAt },
    ...comment.replies,
  ];
  return (
    <Popover label="Comment thread">
      <div {...stylex.props(styles.threadHead)}>
        <span {...stylex.props(styles.muted)}>{resolved ? "Resolved" : "Open"}</span>
        <span {...stylex.props(styles.spacer)} />
        <Button size="small" onClick={() => onResolve(!resolved)}>
          {resolved ? "Reopen" : "Resolve"}
        </Button>
        <IconButton size="small" icon="close" label="Close" onClick={onClose} />
      </div>
      <ol {...stylex.props(styles.messages)}>
        {messages.map((m) => (
          <li key={m.id} {...stylex.props(styles.message)}>
            <div>
              <span {...stylex.props(styles.author)}>{m.author.name || "Someone"}</span>{" "}
              <span {...stylex.props(styles.muted)}>
                <TimeAgo at={m.createdAt} />
              </span>
            </div>
            <p {...stylex.props(styles.body)}>{m.text}</p>
          </li>
        ))}
      </ol>
      <Composer placeholder="Reply" onSubmit={onReply} onCancel={onClose} />
    </Popover>
  );
}

function Composer({
  placeholder,
  autoFocus,
  label = "Send",
  onSubmit,
  onCancel,
}: {
  placeholder: string;
  autoFocus?: boolean;
  label?: string;
  onSubmit: (text: string) => Promise<string | undefined>;
  onCancel: () => void;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState<string>();
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);

  const submit = async () => {
    if (!text.trim() || sending) return;
    setSending(true);
    const failure = await onSubmit(text.trim());
    // Keep the text after a failure, so it can be sent again.
    if (failure === undefined) setText("");
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
          value={text}
          rows={2}
          placeholder={placeholder}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void submit();
            } else if (e.key === "Escape") {
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
          disabled={!text.trim() || sending}
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
    cursor: "pointer",
  },
  moved: {
    position: "absolute",
    left: 40,
    bottom: 6,
    paddingInline: space.xs,
    borderRadius: radii.sm,
    backgroundColor: colors.surface,
    color: colors.muted,
    fontSize: 11,
    whiteSpace: "nowrap",
  },
  popover: {
    position: "absolute",
    left: POPOVER_GAP,
    bottom: -3,
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
    cursor: "default",
    userSelect: "text",
  },
  threadHead: { display: "flex", alignItems: "center", gap: space.xs },
  spacer: { flexGrow: 1 },
  muted: { color: colors.muted, fontSize: 12 },
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
