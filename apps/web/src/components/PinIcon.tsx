"use client";

import { colors } from "@/styles/tokens.stylex";
import { PIN_PATH } from "../lib/cursors";

/** `note` is an open comment for people only, which no agent acts on. */
export type PinState = "waiting" | "working" | "replied" | "resolved" | "note" | "draft";

// A pin sits on the frame, whichever theme the app is in, so these two stay the same in both.
const BLUE = "#2563eb";
const GREEN = "#15803d";

const LOOK: Record<PinState, { fill: string; stroke: string; dots: boolean }> = {
  waiting: { fill: colors.ink, stroke: colors.ink, dots: true },
  working: { fill: colors.ink, stroke: colors.ink, dots: true },
  replied: { fill: BLUE, stroke: BLUE, dots: true },
  resolved: { fill: GREEN, stroke: GREEN, dots: false },
  note: { fill: colors.halo, stroke: colors.ink, dots: false },
  draft: { fill: colors.halo, stroke: colors.ink, dots: false },
};

/** The typing dots, on the bubble's center line. */
const DOTS = [
  [13.5, 14.5],
  [20.5, 14.5],
  [27.5, 14.5],
] as const;

/**
 * The pin shape every pin points at, and, while an agent works, the typing
 * keyframes its dots run. Render once, next to the pins.
 */
export function PinFilters({ boiling }: { boiling: boolean }) {
  return (
    <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true">
      <defs>
        <path id="pin-body" d={PIN_PATH} />
      </defs>
      {boiling && <style>{"@keyframes pin-typing{0%,60%,100%{opacity:.35}30%{opacity:1}}"}</style>}
    </svg>
  );
}

/**
 * A comment pin: a rounded speech pin on a halo, so it reads on any frame.
 * Its tail tip is the bottom-left corner. A selected pin also has a ring
 * outside the halo, in the pin's own color.
 */
export function PinIcon({ state, selected }: { state: PinState; selected?: boolean }) {
  const look = LOOK[state];
  return (
    <svg
      width="40"
      height="36"
      viewBox="0 0 40 36"
      style={{ display: "block", overflow: "visible" }}
      aria-hidden="true"
    >
      {selected && (
        <use
          href="#pin-body"
          style={{ fill: "none", stroke: look.stroke }}
          strokeWidth="9"
          strokeLinejoin="round"
        />
      )}
      <use
        href="#pin-body"
        style={{ fill: colors.halo, stroke: colors.halo }}
        strokeWidth="6"
        strokeLinejoin="round"
      />
      <use
        href="#pin-body"
        style={{ fill: look.fill, stroke: look.stroke }}
        strokeLinejoin="round"
        strokeWidth="2"
        strokeDasharray={state === "draft" ? "4 3" : undefined}
      />
      {look.dots && (
        <g style={{ fill: colors.halo }}>
          {DOTS.map(([cx, cy], i) => (
            <circle
              key={i}
              cx={cx}
              cy={cy}
              r="2"
              style={
                state === "working"
                  ? { animation: `pin-typing 1.2s ${i * 0.2}s infinite` }
                  : undefined
              }
            />
          ))}
        </g>
      )}
    </svg>
  );
}
