"use client";

import * as stylex from "@stylexjs/stylex";
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Draft, Editor } from "@/design/editing/editor";
import type { UserEdit } from "@/design/schema";
import { colors, cursors, motion } from "@/styles/tokens.stylex";
import { clampedText, numberOf, scrubber, steppedText, tidy } from "./scrub";

export { numberOf };

/**
 * A text field that edits the design as it's typed: each key previews on
 * the canvas and in the panels, ↑ and ↓ step a number (Shift by 10), Enter
 * or leaving keeps it as one undo step, and Escape puts it back. `toEdits`
 * turns what's typed into edits, or `null` to show nothing; it's asked
 * once more with `done` on Enter or leaving, for what a half-typed value
 * would misread, like `#1f3a` on the way to `#1f3a44`. A number typed or
 * stepped past `min` or `max` is held to it.
 */
export function useDraftField(
  editor: Editor,
  shown: string,
  toEdits: (text: string, done: boolean) => ReadonlyArray<UserEdit> | null,
  /** What ↑ and ↓ step when the field is empty, like the browser's value. */
  fallback = "",
  { min, max }: { min?: number | undefined; max?: number | undefined } = {},
) {
  const [typing, setTyping] = useState<string | null>(null);
  const draft = useRef<Draft | null>(null);
  const latest = useRef(toEdits);
  latest.current = toEdits;
  // A field that goes away keeps what was typed, as leaving it does.
  useEffect(() => () => draft.current?.commit(), []);

  const show = (text: string) => {
    setTyping(text);
    draft.current ??= editor.begin({
      onLost: () => {
        draft.current = null;
        setTyping(null);
      },
    });
    // What's typed stays as typed; the design gets it held to the limits.
    draft.current.preview(latest.current(clampedText(text, min, max), false));
  };
  const finish = (keep: boolean) => {
    const open = draft.current;
    draft.current = null;
    setTyping(null);
    if (!keep) return open?.cancel();
    // What's typed, read as finished; nothing readable keeps what was last shown.
    const final = typing === null ? null : latest.current(clampedText(typing, min, max), true);
    if (final) open?.preview(final);
    open?.commit();
  };
  return {
    typing: typing !== null,
    props: {
      value: typing ?? shown,
      spellCheck: false,
      onFocus: (e: React.FocusEvent<HTMLInputElement>) => e.currentTarget.select(),
      onChange: (e: React.ChangeEvent<HTMLInputElement>) => show(e.target.value),
      onBlur: () => finish(true),
      onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === "Enter") {
          finish(true);
          e.currentTarget.blur();
        } else if (e.key === "Escape") {
          finish(false);
          e.currentTarget.blur();
        } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
          const n = numberOf(typing ?? shown) ?? numberOf(fallback);
          if (!n) return;
          e.preventDefault();
          const by = (e.key === "ArrowUp" ? 1 : -1) * (e.shiftKey ? 10 : 1);
          show(steppedText(n, by, min, max));
        }
      },
    },
  };
}

/** How far each arrowhead of the scrub cursor slides from the other when it's pressed, in pixels. */
const OPEN = 2;

/**
 * The scrub cursor while a number is held: two arrowheads, ◀ ▶, drawn where
 * the press began, since the pointer is locked there and the system cursor
 * is hidden. They start together, like the cursor over the label, slide
 * apart when `held`, and come back together when it's released.
 */
function ScrubCursor({ x, y, held }: { x: number; y: number; held: boolean }) {
  const root = useRef<HTMLSpanElement>(null);
  const [apart, setApart] = useState(false);
  // Painted together first, so the slide has somewhere to start from.
  useLayoutEffect(() => {
    root.current?.getBoundingClientRect();
    setApart(true);
  }, []);
  const open = apart && held ? OPEN : 0;
  const half = (d: string, by: number) => (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      aria-hidden="true"
      {...stylex.props(styles.half)}
      style={{ transform: `translateX(${by * open}px)` }}
    >
      <path d={d} {...stylex.props(styles.arrow)} />
    </svg>
  );
  return createPortal(
    <span
      ref={root}
      aria-hidden="true"
      {...stylex.props(styles.cursor)}
      style={{ left: x - 12, top: y - 12 }}
    >
      {half("M10.25 6.5 3.5 12l6.75 5.5Z", -1)}
      {half("M13.75 6.5l6.75 5.5-6.75 5.5Z", 1)}
    </span>,
    document.body,
  );
}

/**
 * A field's label that scrubs its number: drag left or right to change it
 * (Shift by 10, Alt by a tenth where `step` has decimals), and the design
 * follows each frame as one undo step. `start` is the number to scrub from,
 * `step` how much `PX_PER_STEP` of travel moves it, `min` and `max` where it
 * stops, and `toEdits` the edits for a value.
 *
 * Once a press turns into a drag, the pointer is locked and the change
 * follows how far the mouse moves, so the cursor can't run off the screen;
 * the scrub cursor stays where the press was. Releasing or Escape lets go.
 * Where the browser refuses the lock, the pointer travels as it always did.
 */
export function ScrubLabel({
  editor,
  start,
  step = 1,
  min,
  max,
  toEdits,
  children,
  style,
}: {
  editor: Editor;
  start: number | null;
  step?: number;
  min?: number | undefined;
  max?: number | undefined;
  toEdits: (value: number) => ReadonlyArray<UserEdit> | null;
  children: ReactNode;
  style?: stylex.StyleXStyles;
}) {
  const [press, setPress] = useState<{ x: number; y: number; held: boolean } | null>(null);
  const release = useRef<(() => void) | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(
    () => () => {
      release.current?.();
      clearTimeout(timer.current);
    },
    [],
  );
  return (
    <>
      <span
        onPointerDown={(e) => {
          if (start === null || e.button !== 0) return;
          const label = e.currentTarget;
          const from = e.clientX;
          let travel = 0;
          const scrub = scrubber(start);
          let fine = false;
          let locked = false;
          let holding = false;
          const end = new AbortController();
          const { signal } = end;
          // The pointer's travel: where it is until it's locked, then how far it moves.
          window.addEventListener(
            "pointermove",
            (m) => {
              fine = m.altKey && step < 1;
              travel =
                document.pointerLockElement === label ? travel + m.movementX : m.clientX - from;
            },
            { capture: true, signal },
          );
          let stop = () => {};
          const done = () => {
            release.current = null;
            end.abort();
            stop();
            if (document.pointerLockElement === label) document.exitPointerLock();
            setPress((p) => p && { ...p, held: false });
            clearTimeout(timer.current);
            timer.current = setTimeout(() => setPress(null), 200);
          };
          release.current = done;
          // The browser took the lock back (Escape): the drag is over, nothing is kept.
          document.addEventListener(
            "pointerlockchange",
            () => {
              if (document.pointerLockElement === label) locked = true;
              else if (locked) stop();
            },
            { signal },
          );
          // Refused: the pointer travels as it always did, so the element holds it again.
          const refused = () => {
            holding = false;
            setPress(null);
            if (!label.hasPointerCapture(e.pointerId)) label.setPointerCapture(e.pointerId);
          };
          document.addEventListener("pointerlockerror", refused, { signal });
          clearTimeout(timer.current);
          setPress({ x: e.clientX, y: e.clientY, held: true });
          stop = editor.drive(e.nativeEvent, label, {
            move: (p) => {
              if (!locked && document.pointerLockElement !== label) {
                locked = true;
                holding = true;
                (label.requestPointerLock() as unknown as Promise<void> | undefined)?.catch(
                  refused,
                );
              }
              const value = scrub(travel, { step, shift: p.shift, fine, min, max });
              return value === start ? null : toEdits(Number(tidy(value)));
            },
            end: done,
            keep: () => holding,
          });
        }}
        {...stylex.props(
          styles.scrub,
          start === null && styles.still,
          press?.held && styles.pressed,
          style,
        )}
      >
        {children}
      </span>
      {press && <ScrubCursor x={press.x} y={press.y} held={press.held} />}
    </>
  );
}

const styles = stylex.create({
  scrub: { cursor: cursors.scrub, userSelect: "none", touchAction: "none" },
  still: { cursor: "default" },
  /** The scrub cursor is drawn by hand while held. */
  pressed: { cursor: "none" },
  cursor: {
    position: "fixed",
    zIndex: 100,
    width: 24,
    height: 24,
    pointerEvents: "none",
  },
  half: {
    position: "absolute",
    inset: 0,
    transitionProperty: "transform",
    transitionDuration: motion.fast,
    transitionTimingFunction: motion.out,
  },
  arrow: {
    fill: colors.surface,
    stroke: colors.text,
    strokeWidth: 1.5,
    strokeLinejoin: "round",
  },
});
