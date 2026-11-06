"use client";

import * as stylex from "@stylexjs/stylex";
import type { ReactElement } from "react";
import { PIN_PATH } from "@/lib/cursors";
import { hideMode } from "@/styles/hideMode";
import { colors, radii, shadows, size, space } from "@/styles/tokens.stylex";
import { IconButton } from "./Button";
import type { Mode } from "./Comments";

/**
 * The tools, down the left edge of the canvas. Shown with the sidebars, the
 * rail is a column of the window. In hide mode (`hidden`), the column slides
 * off with the left sidebar and the tools travel, as they are, to the middle
 * of the canvas's left edge, where a panel's face fades in around them; they
 * travel back when the sidebars return. It's one element throughout, so
 * focus, hover and a toggle mid-way all carry over. `instant` skips the motion.
 */
export function ToolRail({
  mode,
  onMode,
  hidden = false,
  instant = false,
}: {
  mode: Mode;
  onMode: (mode: Mode) => void;
  hidden?: boolean;
  instant?: boolean;
}) {
  const tool = (m: Mode, label: string, title: string, icon: ReactElement) => (
    <IconButton
      variant="ghost"
      icon={icon}
      label={label}
      title={title}
      picked={mode === m}
      aria-pressed={mode === m}
      onClick={(e) => {
        onMode(m);
        // A pointer click leaves focus on the button, and the next V/I/C key press would
        // make `:focus-visible` match and draw the ring. `detail` is 0 for Enter and Space.
        if (e.detail > 0) e.currentTarget.blur();
      }}
    />
  );
  return (
    <nav
      data-camera-ignore
      aria-label="Tools"
      {...stylex.props(styles.rail, hidden && styles.railHidden)}
    >
      <span
        aria-hidden
        {...stylex.props(
          styles.column,
          hideMode.panel,
          hidden && hideMode.panelHidden,
          hidden && hideMode.offLeft,
          instant && hideMode.instant,
        )}
      />
      {/* Moves across, and down by half the rail's height; the tools come up by half their own. */}
      <div
        {...stylex.props(
          styles.mover,
          hideMode.travel,
          hideMode.dip,
          hidden && hideMode.travelHidden,
          hidden && hideMode.dipHidden,
          hidden && styles.moverHidden,
          instant && hideMode.instant,
        )}
      >
        <div
          role="toolbar"
          aria-label="Tool"
          aria-orientation="vertical"
          {...stylex.props(
            styles.tools,
            hideMode.travel,
            hidden && hideMode.travelHidden,
            hidden && styles.toolsHidden,
            instant && hideMode.instant,
          )}
        >
          <span
            aria-hidden
            {...stylex.props(
              styles.face,
              hideMode.face,
              hidden && hideMode.faceShown,
              instant && hideMode.instant,
            )}
          />
          {tool(
            "pointer",
            "Pointer",
            "Pointer (V)",
            <svg width="15" height="15" viewBox="0 0 24 24" overflow="visible" aria-hidden="true">
              <path
                d="M5.6 5.6l13.6 4.8-6.4 2.4-2.4 6.4z"
                fill="currentColor"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinejoin="round"
              />
            </svg>,
          )}
          {/* An outlined pointer with a click's rays: the pointer, using the page. */}
          {tool(
            "interact",
            "Interact",
            "Interact (I): click, type and scroll in pages",
            <svg width="15" height="15" viewBox="0 0 24 24" overflow="visible" aria-hidden="true">
              <path
                d="M8 8l12 4.4-5.6 2-2 5.6zM8 2.4v2.4M2.4 8h2.4M4 4l1.7 1.7"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>,
          )}
          {/* The pin's own outline, so the tool looks like what it places. */}
          {tool(
            "comment",
            "Comment",
            "Comment (C)",
            <svg width="15" height="15" viewBox="-2 -4 44 44" overflow="visible" aria-hidden="true">
              <path
                d={PIN_PATH}
                fill="none"
                stroke="currentColor"
                strokeWidth="2.9"
                strokeLinejoin="round"
              />
            </svg>,
          )}
        </div>
      </div>
    </nav>
  );
}

const styles = stylex.create({
  // Its own stacking layer over the canvas, which runs under it in hide mode.
  rail: {
    gridArea: "rail",
    position: "relative",
    zIndex: 2,
    minHeight: 0,
  },
  // In hide mode only the tools take clicks; the canvas has the rest.
  railHidden: { pointerEvents: "none" },
  // The docked rail's look: a column with a line on its right.
  // Under the tools: the rail is a stacking context, and this sits at its bottom.
  column: {
    position: "absolute",
    inset: 0,
    zIndex: -1,
    pointerEvents: "none",
    backgroundColor: colors.surface,
    borderRightWidth: 1,
    borderRightStyle: "solid",
    borderRightColor: colors.border,
  },
  mover: {
    position: "absolute",
    inset: 0,
    pointerEvents: "none",
  },
  // To 9px from the canvas's left edge, and half the rail's height down.
  moverHidden: { transform: `translate(calc(${space.ms} - ${size.left}), 50%)` },
  /** The 27px tools, 6px from the rail's edges and 6px apart. */
  tools: {
    position: "relative",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: space.sm,
    width: size.rail,
    padding: space.sm,
    boxSizing: "border-box",
    pointerEvents: "auto",
    // A stacking context, so the face can sit under the tools.
    zIndex: 0,
  },
  toolsHidden: { transform: "translateY(-50%)" },
  /** The floating panel's face: its 9px corners are the tools' 3px plus the 6px around them. */
  face: {
    position: "absolute",
    inset: 0,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    borderRadius: radii.lg,
    backgroundColor: colors.surface,
    boxShadow: shadows.raised,
    pointerEvents: "none",
    zIndex: -1,
  },
});
