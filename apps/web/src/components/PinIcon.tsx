"use client";

import { useEffect } from "react";
import { PIN_PATH } from "../lib/cursors";

/** `note` is an open comment for people only, which no agent acts on. */
export type PinState = "waiting" | "working" | "replied" | "resolved" | "note" | "draft";

const INK = "#1a1a18";
const BLUE = "#2563eb";
const GREEN = "#15803d";

const LOOK: Record<PinState, { fill: string; stroke: string; dots: boolean }> = {
  waiting: { fill: INK, stroke: INK, dots: true },
  working: { fill: INK, stroke: INK, dots: true },
  replied: { fill: BLUE, stroke: BLUE, dots: true },
  resolved: { fill: GREEN, stroke: GREEN, dots: false },
  note: { fill: "#fafbfd", stroke: INK, dots: false },
  draft: { fill: "#fff", stroke: INK, dots: false },
};

const DOTS = [
  [13.5, 15],
  [20, 14],
  [26.5, 13.5],
] as const;

/** The wobble filters every pin points at. Render once, next to the pins. */
export function PinFilters({ boiling }: { boiling: boolean }) {
  // Only a working agent's pin moves: its line redraws like boiling ink.
  useEffect(() => {
    if (!boiling || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const noise = document.getElementById("pin-boil-noise");
    let seed = 1;
    const timer = setInterval(() => {
      seed = (seed % 4) + 1;
      noise?.setAttribute("seed", String(seed));
    }, 120);
    return () => clearInterval(timer);
  }, [boiling]);
  const filter = (id: string, seed: number) => (
    <filter id={id} x="-20%" y="-20%" width="140%" height="140%">
      <feTurbulence
        id={`${id}-noise`}
        type="fractalNoise"
        baseFrequency="0.045"
        numOctaves="1"
        seed={seed}
      />
      <feDisplacementMap in="SourceGraphic" scale="3" xChannelSelector="R" yChannelSelector="G" />
    </filter>
  );
  return (
    <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true">
      <defs>
        {filter("pin-wob", 3)}
        {filter("pin-wob2", 11)}
        {filter("pin-boil", 1)}
        <path id="pin-body" d={PIN_PATH} />
      </defs>
      <style>{"@keyframes pin-typing{0%,60%,100%{opacity:.35}30%{opacity:1}}"}</style>
    </svg>
  );
}

/** A comment pin, drawn as sketched ink. Its tail tip is the bottom-left corner. */
export function PinIcon({ state, selected }: { state: PinState; selected?: boolean }) {
  const look = LOOK[state];
  const filter = state === "working" ? "url(#pin-boil)" : "url(#pin-wob)";
  return (
    <svg
      width="40"
      height="36"
      viewBox="0 0 40 36"
      style={{ display: "block", overflow: "visible" }}
      aria-hidden="true"
    >
      <use href="#pin-body" fill="none" filter={filter} stroke="#fff" strokeWidth="6" />
      <use
        href="#pin-body"
        fill={look.fill}
        filter={filter}
        stroke={look.stroke}
        strokeLinejoin="round"
        strokeWidth={selected ? 3 : 2.5}
        strokeDasharray={state === "draft" ? "4 3" : undefined}
      />
      {selected && (
        <use
          href="#pin-body"
          fill="none"
          filter="url(#pin-wob2)"
          stroke={look.stroke}
          strokeWidth="2"
          transform="translate(2.5 -2)"
        />
      )}
      {look.dots && (
        <g fill="#fff">
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
