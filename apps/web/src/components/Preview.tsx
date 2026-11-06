"use client";

import * as stylex from "@stylexjs/stylex";
import { type RefObject, useEffect, useMemo, useRef, useState } from "react";
import { artboardDocument, pixelSize } from "@/design/html";
import type { Replica } from "@/design/replica";
import { colors, radii, space } from "@/styles/tokens.stylex";
import { Icon } from "./Icons";

/** How long preview mode waits for edits to settle before reloading the artboard. */
const RELOAD_DELAY_MS = 150;
/** How long the note about a broken link stays up. */
const NOTICE_MS = 3000;

interface PreviewProps {
  readonly replica: Replica;
  /** The artboards the arrows step through, in order. */
  readonly boards: ReadonlyArray<string>;
  readonly current: string;
  /** The session's version, so the preview reloads when the design changes. */
  readonly version: number;
  readonly onSelect: (id: string) => void;
  readonly onClose: () => void;
}

/**
 * Preview mode: one artboard at full size over the canvas, running as a real
 * page. It scrolls, takes clicks and runs its scripts in a sandboxed iframe,
 * and reloads after each burst of edits. An element with `data-to` is a link
 * to another artboard, which opens at the width closest to this one's (see
 * `flow.rs`); other links and forms do nothing. Back and Restart walk this
 * viewer's own history, which never reaches the design or its undo.
 * It's a modal `<dialog>`, so the canvas behind it is inert, and focus goes
 * back to where it was when it closes.
 */
export function Preview({ replica, boards, current, version, onSelect, onClose }: PreviewProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  // The screens shown before this one, and the one the preview opened on.
  const [history, setHistory] = useState<ReadonlyArray<string>>([]);
  const [start] = useState(current);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (notice === null) return;
    const timer = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);
  const index = boards.indexOf(current);
  const go = (id: string) => {
    if (id === current) return;
    setHistory((h) => [...h, current]);
    onSelect(id);
  };
  const step = (by: number) => {
    const next = boards[(index + by + boards.length) % boards.length];
    if (next) go(next);
  };
  // Screens deleted since they were shown are skipped.
  const shown = history.filter((id) => replica.get(id)?.parent === null);
  const back = () => {
    const previous = shown.at(-1);
    if (previous === undefined) return;
    setHistory(shown.slice(0, -1));
    onSelect(previous);
  };
  const startsHere = replica.get(start)?.parent === null;
  const restart = () => {
    setHistory([]);
    if (startsHere) onSelect(start);
  };
  const follow = (to: unknown) => {
    if (typeof to !== "string") return;
    const target = replica.flowTarget(to, pixelSize(replica.get(current)!).width);
    if (target === undefined) setNotice("This link goes to an artboard that isn't there anymore.");
    else go(target);
  };
  // Read by the message listener, which outlives this render.
  const actions = { step, back, restart, follow };
  const actionsRef = useRef(actions);
  actionsRef.current = actions;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);

  // Escape leaves (the dialog's own `cancel`), the arrows step, Backspace
  // goes back and R restarts. Keys pressed and links followed inside the
  // artboard arrive by message (see `./html`).
  useEffect(() => {
    const press = (key: unknown) => {
      if (key === "Escape") closeRef.current();
      else if (key === "ArrowLeft") actionsRef.current.step(-1);
      else if (key === "ArrowRight") actionsRef.current.step(1);
      else if (key === "Backspace") actionsRef.current.back();
      else if (key === "r" || key === "R") actionsRef.current.restart();
      else return false;
      return true;
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.key === "Escape") return;
      // The bar's buttons take Enter and Space themselves.
      if (e.target instanceof HTMLButtonElement && (e.key === "Enter" || e.key === " ")) return;
      if (press(e.key)) e.preventDefault();
    };
    const onMessage = (e: MessageEvent) => {
      if (e.source !== iframeRef.current?.contentWindow) return;
      const message = (
        e.data as { finite?: { type?: unknown; key?: unknown; to?: unknown } } | null
      )?.finite;
      if (message?.type === "key") press(message.key);
      else if (message?.type === "navigate") actionsRef.current.follow(message.to);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("message", onMessage);
    };
  }, []);

  // Recomputed with the design, so a fixed link stops counting at once.
  const broken = useMemo(
    () => replica.flow().broken.filter((b) => b.from === current),
    [replica, current, version],
  );
  const board = replica.get(current);
  if (!board) return null;
  const size = pixelSize(board);

  return (
    <dialog
      ref={dialogRef}
      aria-label="Preview"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      {...stylex.props(styles.overlay)}
    >
      <header {...stylex.props(styles.bar)}>
        <span {...stylex.props(styles.name)}>{board.name ?? "Artboard"}</span>
        {boards.length > 1 && (
          <>
            <button
              type="button"
              onClick={() => step(-1)}
              {...stylex.props(styles.tool)}
              aria-label="Previous artboard"
              title="Previous artboard (←)"
            >
              <Icon name="previous" size={14} />
            </button>
            <span {...stylex.props(styles.muted)}>
              {index + 1} of {boards.length}
            </span>
            <button
              type="button"
              onClick={() => step(1)}
              {...stylex.props(styles.tool)}
              aria-label="Next artboard"
              title="Next artboard (→)"
            >
              <Icon name="next" size={14} />
            </button>
          </>
        )}
        <button
          type="button"
          onClick={back}
          disabled={shown.length === 0}
          {...stylex.props(styles.tool)}
          aria-label="Back"
          title="Back (Backspace)"
        >
          <Icon name="back" size={14} />
        </button>
        <button
          type="button"
          onClick={restart}
          disabled={!startsHere || (current === start && shown.length === 0)}
          {...stylex.props(styles.tool)}
          aria-label="Restart"
          title="Restart from the first screen (R)"
        >
          <Icon name="restart" size={14} />
        </button>
        {broken.length > 0 && (
          <span
            {...stylex.props(styles.warning)}
            title="Links here go to artboards that were deleted. Undo the delete, or pick another target."
          >
            {broken.length} broken link{broken.length === 1 ? "" : "s"}
          </span>
        )}
        <span role="status" {...stylex.props(styles.muted)}>
          {notice}
        </span>
        <span {...stylex.props(styles.spacer)} />
        <button
          type="button"
          onClick={onClose}
          {...stylex.props(styles.tool)}
          aria-label="Close"
          title="Back to the canvas (Esc)"
        >
          <Icon name="close" size={14} />
        </button>
      </header>
      <div {...stylex.props(styles.stage)}>
        <PreviewFrame
          key={current}
          replica={replica}
          board={current}
          version={version}
          title={board.name ?? "Artboard"}
          width={size.width ?? 1440}
          height={size.height}
          iframeRef={iframeRef}
        />
      </div>
    </dialog>
  );
}

interface FrameProps {
  readonly replica: Replica;
  readonly board: string;
  readonly version: number;
  readonly title: string;
  readonly width: number;
  readonly height: number | null;
  readonly iframeRef: RefObject<HTMLIFrameElement | null>;
}

/** One artboard's iframe. Keyed by artboard, so a new one never shows the last one's page. */
function PreviewFrame({ replica, board, version, title, width, height, iframeRef }: FrameProps) {
  const [doc, setDoc] = useState(() => artboardDocument(replica, board, true));
  useEffect(() => {
    const timer = setTimeout(() => {
      // Unchanged markup keeps the page as it is, scroll and all.
      setDoc(artboardDocument(replica, board, true));
    }, RELOAD_DELAY_MS);
    return () => clearTimeout(timer);
  }, [replica, board, version]);
  return (
    <iframe
      ref={iframeRef}
      title={title}
      sandbox="allow-scripts"
      srcDoc={doc}
      {...stylex.props(styles.frame(width, height))}
    />
  );
}

const styles = stylex.create({
  overlay: {
    position: "fixed",
    inset: 0,
    width: "100%",
    height: "100%",
    maxWidth: "none",
    maxHeight: "none",
    margin: 0,
    padding: 0,
    borderWidth: 0,
    color: "inherit",
    font: "inherit",
    display: "flex",
    flexDirection: "column",
    backgroundColor: colors.canvas,
  },
  bar: {
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    margin: space.sm,
    padding: space.xs,
    paddingInline: space.sm,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  name: { fontWeight: 500 },
  muted: { color: colors.muted, fontVariantNumeric: "tabular-nums" },
  warning: { color: colors.danger },
  spacer: { flexGrow: 1 },
  tool: {
    display: "inline-grid",
    placeItems: "center",
    minWidth: 28,
    height: 24,
    paddingInline: 6,
    borderWidth: 0,
    borderRadius: 4,
    backgroundColor: { default: "transparent", ":hover:enabled": colors.bg },
    color: { default: "inherit", ":disabled": colors.muted },
    font: "inherit",
    cursor: { default: "var(--cursor-pointer, pointer)", ":disabled": "default" },
  },
  stage: {
    flexGrow: 1,
    minHeight: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    paddingInline: space.sm,
    paddingBottom: space.sm,
  },
  // At its own size when it fits; a taller or wider artboard scrolls inside.
  frame: (width: number, height: number | null) => ({
    width: `min(${width}px, 100%)`,
    height: height === null ? "100%" : `min(${height}px, 100%)`,
    borderWidth: 0,
    boxShadow: "0 1px 3px rgba(0, 0, 0, 0.12), 0 0 0 1px rgba(0, 0, 0, 0.06)",
    colorScheme: "normal",
  }),
});
