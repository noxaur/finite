"use client";

import * as stylex from "@stylexjs/stylex";
import { type RefObject, useEffect, useRef, useState } from "react";
import { artboardDocument, pixelSize } from "@/design/html";
import type { Replica } from "@/design/replica";
import { colors, radii, space } from "@/styles/tokens.stylex";
import { Icon } from "./Icons";

/** How long preview mode waits for edits to settle before reloading the artboard. */
const RELOAD_DELAY_MS = 150;

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
 * and reloads after each burst of edits. Links and forms still do nothing.
 * It's a modal `<dialog>`, so the canvas behind it is inert, and focus goes
 * back to where it was when it closes.
 */
export function Preview({ replica, boards, current, version, onSelect, onClose }: PreviewProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const index = boards.indexOf(current);
  const step = (by: number) => {
    const next = boards[(index + by + boards.length) % boards.length];
    if (next) onSelect(next);
  };
  // Read by the message listener, which outlives this render.
  const stepRef = useRef(step);
  stepRef.current = step;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);

  // Escape leaves (the dialog's own `cancel`) and the arrows step. Keys
  // pressed inside the artboard arrive by message (see `./html`).
  useEffect(() => {
    const press = (key: unknown) => {
      if (key === "Escape") closeRef.current();
      else if (key === "ArrowLeft") stepRef.current(-1);
      else if (key === "ArrowRight") stepRef.current(1);
      else return false;
      return true;
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.key === "Escape") return;
      if (press(e.key)) e.preventDefault();
    };
    const onMessage = (e: MessageEvent) => {
      if (e.source !== iframeRef.current?.contentWindow) return;
      const message = (e.data as { finite?: { type?: unknown; key?: unknown } } | null)?.finite;
      if (message?.type === "key") press(message.key);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("message", onMessage);
    };
  }, []);

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
  spacer: { flexGrow: 1 },
  tool: {
    display: "inline-grid",
    placeItems: "center",
    minWidth: 28,
    height: 24,
    paddingInline: 6,
    borderWidth: 0,
    borderRadius: 4,
    backgroundColor: { default: "transparent", ":hover": colors.bg },
    color: "inherit",
    font: "inherit",
    cursor: "var(--cursor-pointer, pointer)",
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
