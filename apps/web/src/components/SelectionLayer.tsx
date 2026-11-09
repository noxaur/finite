"use client";

import * as stylex from "@stylexjs/stylex";
import type { Rect } from "@finite/protocol";
import type { CanvasEditor, EditorState } from "@/canvas/editor";
import { CORNERS, HANDLES, type Handle } from "@/canvas/gestures";
import { keyOf, type SelectionItem } from "@/canvas/selection";
import { colors, fonts, radii, shadows, space } from "@/styles/tokens.stylex";

/** The cursor over each resize handle. */
const CURSORS: Record<Handle, string> = {
  n: "ns-resize",
  s: "ns-resize",
  e: "ew-resize",
  w: "ew-resize",
  ne: "nesw-resize",
  sw: "nesw-resize",
  nw: "nwse-resize",
  se: "nwse-resize",
};

/**
 * Draws what the editor shows over the frames: the selection with its resize handles and
 * corner marks, the thing under the pointer, where a reorder drops, and the label that says
 * which file an edit changes. It sits in the camera's world, so it pans and zooms with the
 * frames; lines and handles keep their screen size through `--inv-zoom`.
 */
export function SelectionLayer({
  editor,
  state,
  selection,
}: {
  editor: CanvasEditor;
  state: EditorState;
  selection: readonly SelectionItem[];
}) {
  const world = (frameId: string, r: Rect): Rect | null => {
    const frame = editor.frame(frameId);
    if (!frame) return null;
    const b = editor.boxOf(frame);
    return { x: b.x + r.x, y: b.y + r.y, width: r.width, height: r.height };
  };
  const hover = state.hover && world(state.hover.frameId, state.hover.rect);
  const drop = state.dropLine && world(state.dropLine.frameId, state.dropLine.rect);
  const resizable = selection.length === 1 && !state.dragging && state.tool !== "interact";
  const [first] = selection;
  const firstRect = first && state.rects[keyOf(first)];
  const labelAt = first && firstRect ? world(first.frameId, firstRect) : null;

  return (
    <>
      {hover && !state.dragging && <div {...stylex.props(styles.box(hover), styles.hover)} />}
      {drop && <div data-drop {...stylex.props(styles.box(drop), styles.drop)} />}
      {selection.map((item) => {
        const key = keyOf(item);
        const local = state.rects[key];
        const rect = local && world(item.frameId, local);
        if (!rect) return null;
        return (
          <div key={key} data-selected={key} {...stylex.props(styles.box(rect), styles.selected)}>
            {resizable
              ? HANDLES.map((handle) => (
                  <div
                    key={handle}
                    data-handle={handle}
                    data-key={key}
                    data-camera-ignore
                    {...stylex.props(
                      styles.handle(handle),
                      (handle === "n" || handle === "s") && styles.across,
                      (handle === "e" || handle === "w") && styles.along,
                    )}
                  >
                    {CORNERS.includes(handle) && <Mark />}
                  </div>
                ))
              : CORNERS.map((corner) => (
                  <div key={corner} {...stylex.props(styles.corner(corner))}>
                    <Mark />
                  </div>
                ))}
          </div>
        );
      })}
      {state.label && labelAt && (
        <div {...stylex.props(styles.labelSpot(labelAt))}>
          <span {...stylex.props(styles.label)}>{state.label}</span>
        </div>
      )}
    </>
  );
}

/**
 * A selection's corner mark: halo inside, brand outline. One unit is one pixel, so its
 * 2px stroke runs from 1 to 3 and lands on whole pixels.
 */
function Mark() {
  return (
    <svg viewBox="0 0 12 12" overflow="visible" aria-hidden="true" {...stylex.props(styles.fill)}>
      <rect
        x="2"
        y="2"
        width="8"
        height="8"
        strokeWidth="2"
        strokeLinejoin="round"
        {...stylex.props(styles.mark)}
      />
    </svg>
  );
}

/** Where a handle sits on its box, as fractions of the width and height. */
const spot = (handle: Handle) => ({
  x: handle.includes("w") ? 0 : handle.includes("e") ? 1 : 0.5,
  y: handle.startsWith("n") ? 0 : handle.startsWith("s") ? 1 : 0.5,
});

const styles = stylex.create({
  box: (r: Rect) => ({
    position: "absolute",
    left: r.x,
    top: r.y,
    width: r.width,
    height: r.height,
    pointerEvents: "none",
  }),
  selected: {
    outline: `calc(1.5px * var(--inv-zoom, 1)) solid ${colors.hover}`,
  },
  hover: {
    outline: `calc(1.5px * var(--inv-zoom, 1)) solid ${colors.hover}`,
    outlineOffset: 0,
  },
  drop: {
    outline: `calc(2px * var(--inv-zoom, 1)) solid ${colors.hover}`,
    boxShadow: `0 0 0 calc(3px * var(--inv-zoom, 1)) ${colors.halo}`,
  },
  fill: {
    display: "block",
    width: "100%",
    height: "100%",
  },
  corner: (corner: Handle) => ({
    position: "absolute",
    left: `${spot(corner).x * 100}%`,
    top: `${spot(corner).y * 100}%`,
    width: "calc(12px * var(--inv-zoom, 1))",
    height: "calc(12px * var(--inv-zoom, 1))",
    transform: "translate(-50%, -50%)",
  }),
  mark: {
    fill: colors.halo,
    stroke: colors.hover,
  },
  // Corner handles draw a mark, over the sides.
  handle: (handle: Handle) => ({
    position: "absolute",
    left: `${spot(handle).x * 100}%`,
    top: `${spot(handle).y * 100}%`,
    width: "calc(12px * var(--inv-zoom, 1))",
    height: "calc(12px * var(--inv-zoom, 1))",
    transform: "translate(-50%, -50%)",
    zIndex: 1,
    cursor: CURSORS[handle],
    pointerEvents: "auto",
  }),
  // Side handles are unseen strips along the whole side, so any point on it resizes.
  across: {
    left: 0,
    width: "100%",
    transform: "translateY(-50%)",
    zIndex: 0,
  },
  along: {
    top: 0,
    height: "100%",
    transform: "translateX(-50%)",
    zIndex: 0,
  },
  labelSpot: (r: Rect) => ({
    position: "absolute",
    left: r.x,
    top: r.y + r.height,
    pointerEvents: "none",
  }),
  label: {
    display: "inline-block",
    transform: "scale(var(--inv-zoom, 1))",
    transformOrigin: "0 0",
    marginTop: space.sm,
    paddingBlock: 2,
    paddingInline: space.sm,
    borderRadius: radii.sm,
    backgroundColor: colors.hover,
    color: colors.halo,
    boxShadow: shadows.raised,
    fontFamily: fonts.sans,
    fontSize: 12,
    lineHeight: "16px",
    whiteSpace: "nowrap",
  },
});
