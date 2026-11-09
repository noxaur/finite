"use client";

import * as stylex from "@stylexjs/stylex";
import type { Tool } from "@/canvas/editor";
import { PIN_PATH } from "@/lib/cursors";
import { colors, fonts, radii, shadows, space } from "@/styles/tokens.stylex";
import { Button, IconButton } from "./Button";

/**
 * The canvas's tools, at the top center: select (V), comment (C), measure (M), and Interact,
 * which lets the pointer into the frames to click through the real app. While Interact or
 * Measure is on, the pill says so and how to leave.
 */
export function InteractivePill({
  tool,
  interact,
  onTool,
  onInteract,
}: {
  tool: Tool;
  interact: boolean;
  onTool: (tool: Tool) => void;
  onInteract: (on: boolean) => void;
}) {
  return (
    <div
      role="toolbar"
      aria-label="Canvas tools"
      data-canvas-ui=""
      data-camera-ignore=""
      {...stylex.props(styles.pill)}
    >
      <IconButton
        size="small"
        variant="ghost"
        icon={POINTER}
        label="Select"
        title="Select (V)"
        picked={tool === "select" && !interact}
        aria-pressed={tool === "select" && !interact}
        onClick={() => {
          onInteract(false);
          onTool("select");
        }}
      />
      <IconButton
        size="small"
        variant="ghost"
        icon={PIN}
        label="Comment"
        title="Comment (C)"
        picked={tool === "comment" && !interact}
        aria-pressed={tool === "comment" && !interact}
        onClick={() => {
          onInteract(false);
          onTool("comment");
        }}
      />
      <IconButton
        size="small"
        variant="ghost"
        icon={RULER}
        label="Measure"
        title="Measure (M)"
        picked={tool === "measure" && !interact}
        aria-pressed={tool === "measure" && !interact}
        onClick={() => {
          onInteract(false);
          onTool("measure");
        }}
      />
      <span {...stylex.props(styles.divider)} />
      <Button
        size="small"
        variant="ghost"
        pressed={interact}
        onClick={() => onInteract(!interact)}
        title={interact ? "Back to editing (Esc)" : "Click through the real app"}
      >
        {INTERACT}
        Interact
      </Button>
      {interact && <span {...stylex.props(styles.note)}>Esc to edit</span>}
      {tool === "measure" && !interact && (
        <span {...stylex.props(styles.note)}>Click to pin · ↑ parent · Esc</span>
      )}
    </div>
  );
}

const POINTER = (
  <svg width="15" height="15" viewBox="0 0 24 24" overflow="visible" aria-hidden="true">
    <path
      d="M5.6 5.6l13.6 4.8-6.4 2.4-2.4 6.4z"
      fill="currentColor"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinejoin="round"
    />
  </svg>
);

/** The pin's own outline, so the tool looks like what it places. */
const PIN = (
  <svg width="15" height="15" viewBox="-2 -4 44 44" overflow="visible" aria-hidden="true">
    <path d={PIN_PATH} fill="none" stroke="currentColor" strokeWidth="2.9" strokeLinejoin="round" />
  </svg>
);

/** A ruler with three ticks, on whole pixels at 15px. */
const RULER = (
  <svg width="15" height="15" viewBox="0 0 24 24" overflow="visible" aria-hidden="true">
    <path
      d="M4 7.2h16a1.6 1.6 0 0 1 1.6 1.6v6.4a1.6 1.6 0 0 1-1.6 1.6H4a1.6 1.6 0 0 1-1.6-1.6V8.8A1.6 1.6 0 0 1 4 7.2zM7.2 7.2v3.2M12 7.2v4.8M16.8 7.2v3.2"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

/** An outlined pointer with a click's rays: the pointer, using the page. */
const INTERACT = (
  <svg width="15" height="15" viewBox="0 0 24 24" overflow="visible" aria-hidden="true">
    <path
      d="M8 8l12 4.4-5.6 2-2 5.6zM8 2.4v2.4M2.4 8h2.4M4 4l1.7 1.7"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const styles = stylex.create({
  pill: {
    position: "absolute",
    top: space.sm,
    left: "50%",
    transform: "translateX(-50%)",
    zIndex: 2,
    display: "flex",
    alignItems: "center",
    gap: space.xs,
    padding: space.xs,
    borderRadius: radii.md,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: colors.surface,
    boxShadow: shadows.raised,
    fontFamily: fonts.sans,
    fontSize: 12,
    whiteSpace: "nowrap",
  },
  divider: { width: 1, alignSelf: "stretch", backgroundColor: colors.border },
  note: { color: colors.muted, paddingInline: space.xs },
});
