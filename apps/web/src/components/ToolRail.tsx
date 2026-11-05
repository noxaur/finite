"use client";

import * as stylex from "@stylexjs/stylex";
import type { Ref } from "react";
import { PIN_PATH } from "@/lib/cursors";
import { colors, fonts, radii, shadows, size, space } from "@/styles/tokens.stylex";
import type { Mode } from "./Comments";

/**
 * The tools, down the left edge of the canvas, and the zoom below them.
 * The camera writes the zoom percentage into `zoomLabel` itself, so
 * zooming doesn't re-render the canvas.
 */
export function ToolRail({
  mode,
  onMode,
  zoomLabel,
  onZoom,
  onActualSize,
  onFit,
}: {
  mode: Mode;
  onMode: (mode: Mode) => void;
  zoomLabel: Ref<HTMLButtonElement>;
  onZoom: (by: number) => void;
  onActualSize: () => void;
  onFit: () => void;
}) {
  const tool = (m: Mode) => ({
    type: "button" as const,
    "aria-pressed": mode === m,
    onClick: () => onMode(m),
    ...stylex.props(styles.button, mode === m && styles.on),
  });
  return (
    <nav data-camera-ignore aria-label="Tools" {...stylex.props(styles.rail)}>
      {/* The rail renders before any pins, so it carries its own wobble filter. */}
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
      <div
        role="toolbar"
        aria-label="Tool"
        aria-orientation="vertical"
        {...stylex.props(styles.group)}
      >
        <button {...tool("pointer")} title="Pointer (V)">
          <svg width="18" height="18" viewBox="0 0 24 24" overflow="visible" aria-hidden="true">
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
        <button {...tool("interact")} title="Interact (I): click, type and scroll in pages">
          {/* An outlined pointer with a click's rays: the pointer, using the page. */}
          <svg width="18" height="18" viewBox="0 0 24 24" overflow="visible" aria-hidden="true">
            <path
              d="M8.6 7.6c3 1.9 5.9 3.9 8.9 5.9-1.5.4-2.9.7-4.3 1.1-.7 1.4-1.4 2.8-2.2 4.2-.8-3.7-1.6-7.4-2.4-11.2z M6.2 3.4l.9 2 M3.4 6.9l2.1.5 M10.2 2.7l-.3 2.1"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.9"
              strokeLinecap="round"
              strokeLinejoin="round"
              filter="url(#tool-wob)"
            />
          </svg>
        </button>
        <button {...tool("comment")} title="Comment (C)">
          {/* The pin's own outline, so the tool looks like what it places. */}
          <svg width="20" height="18" viewBox="0 0 40 36" overflow="visible" aria-hidden="true">
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
      <span {...stylex.props(styles.spacer)} />
      <div role="group" aria-label="Zoom" {...stylex.props(styles.group)}>
        <button
          type="button"
          onClick={() => onZoom(1.25)}
          aria-label="Zoom in"
          {...stylex.props(styles.button, styles.text)}
        >
          +
        </button>
        <button
          type="button"
          ref={zoomLabel}
          onClick={onActualSize}
          title="Zoom to 100% (0)"
          {...stylex.props(styles.zoom)}
        />
        <button
          type="button"
          onClick={() => onZoom(0.8)}
          aria-label="Zoom out"
          {...stylex.props(styles.button, styles.text)}
        >
          −
        </button>
        <button
          type="button"
          onClick={onFit}
          title="Zoom to fit (Shift+1)"
          {...stylex.props(styles.button, styles.text)}
        >
          Fit
        </button>
      </div>
    </nav>
  );
}

const styles = stylex.create({
  rail: {
    gridArea: "rail",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: space.sm,
    minHeight: 0,
    paddingBlock: space.sm,
    backgroundColor: colors.surface,
    borderRightWidth: 1,
    borderRightStyle: "solid",
    borderRightColor: colors.border,
  },
  group: { display: "flex", flexDirection: "column", alignItems: "center", gap: space.xs },
  spacer: { flexGrow: 1 },
  button: {
    display: "grid",
    placeItems: "center",
    width: 32,
    height: 32,
    padding: 0,
    borderWidth: 0,
    borderRadius: radii.sm,
    backgroundColor: { default: "transparent", ":hover": colors.bg },
    boxShadow: { default: "none", ":active": shadows.inset },
    color: colors.text,
    font: "inherit",
    cursor: "var(--cursor-pointer, pointer)",
    transform: { default: "none", ":active": "scale(.97)" },
    transition: "background-color 150ms ease, transform 120ms cubic-bezier(.23, 1, .32, 1)",
    outline: { default: "none", ":focus-visible": `2px solid ${colors.brand}` },
    outlineOffset: -2,
  },
  on: {
    backgroundColor: { default: colors.accent, ":hover": colors.accent },
    color: colors.onAccent,
  },
  text: { fontSize: 12, fontWeight: 500 },
  zoom: {
    width: size.rail,
    height: 20,
    padding: 0,
    borderWidth: 0,
    backgroundColor: "transparent",
    color: { default: colors.muted, ":hover": colors.text },
    fontFamily: fonts.mono,
    fontSize: 11,
    fontVariantNumeric: "tabular-nums",
    cursor: "var(--cursor-pointer, pointer)",
  },
});
