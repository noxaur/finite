"use client";

import * as stylex from "@stylexjs/stylex";
import { useEffect, useSyncExternalStore } from "react";
import { colors, fonts, motion, space } from "@/styles/tokens.stylex";

interface ToastState {
  readonly id: number;
  readonly text: string;
  readonly undo: (() => void) | undefined;
}

const SHOW_MS = 6000;
let current: ToastState | null = null;
let nextId = 1;
let timer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();
const notify = () => {
  for (const l of listeners) l();
};

/** Shows one short line, replacing the last. With `undo`, ⌘Z runs it while the line shows. */
export function toast(text: string, undo?: () => void): void {
  current = { id: nextId++, text, undo };
  clearTimeout(timer);
  timer = setTimeout(dismissToast, SHOW_MS);
  notify();
}

export function dismissToast(): void {
  current = null;
  notify();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

/** Whether a key press belongs to a field, where ⌘Z undoes typing instead. */
const inField = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || target.tagName === "INPUT" || target.tagName === "TEXTAREA");

/** Where toasts show. Mount one; it also listens for ⌘Z while an undoable toast is up. */
export function ToastSlot({ style }: { style?: stylex.StyleXStyles }) {
  const shown = useSyncExternalStore(
    subscribe,
    () => current,
    () => null,
  );

  useEffect(() => {
    if (!shown?.undo) return;
    const undo = shown.undo;
    const key = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "z" || !(e.metaKey || e.ctrlKey) || e.shiftKey) return;
      if (inField(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
      dismissToast();
      undo();
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [shown]);

  return (
    <div role="status" aria-live="polite" {...stylex.props(styles.slot, style)}>
      {shown && (
        <span key={shown.id} {...stylex.props(styles.toast)}>
          {shown.text}
          {shown.undo && (
            <button
              type="button"
              onClick={() => {
                const undo = shown.undo;
                dismissToast();
                undo?.();
              }}
              {...stylex.props(styles.undo)}
            >
              ⌘Z to undo
            </button>
          )}
        </span>
      )}
    </div>
  );
}

const rise = stylex.keyframes({
  from: { opacity: 0, transform: "translateY(4px)" },
  to: { opacity: 1, transform: "none" },
});

const styles = stylex.create({
  slot: { display: "flex", alignItems: "center", minWidth: 0 },
  toast: {
    display: "inline-flex",
    alignItems: "baseline",
    gap: space.xs,
    minWidth: 0,
    color: colors.muted,
    fontFamily: fonts.sans,
    fontSize: 12,
    lineHeight: "15px",
    whiteSpace: "nowrap",
    animationName: rise,
    animationDuration: motion.base,
    animationTimingFunction: motion.out,
  },
  undo: {
    padding: 0,
    borderWidth: 0,
    backgroundColor: "transparent",
    color: { default: colors.text, ":hover": colors.brandText },
    font: "inherit",
    cursor: "var(--cursor-pointer, pointer)",
    outline: { default: "none", ":focus-visible": `1px solid ${colors.brand}` },
  },
});
