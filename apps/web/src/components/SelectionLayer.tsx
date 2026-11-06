"use client";

import * as stylex from "@stylexjs/stylex";
import { useEffect, useState } from "react";
import type { Camera } from "@/design/camera";
import type { Editor } from "@/design/editing/editor";
import { HANDLES, type Handle } from "@/design/editing/geometry";
import type { Renderer } from "@/design/renderer";
import type { DesignSession } from "@/design/session";
import { colors, radii, shadows, space } from "@/styles/tokens.stylex";

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

/** Draws the caller again once per frame in which the design changed. */
export function useRedrawOnChange(session: DesignSession) {
  const [, setTick] = useState(0);
  useEffect(() => {
    let frame = 0;
    const off = session.subscribeDoc(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setTick((t) => t + 1));
    });
    return () => {
      off();
      cancelAnimationFrame(frame);
    };
  }, [session]);
}

/**
 * Draws what the editor shows on the canvas: the selection with its resize
 * handles, the node under the pointer, and the container a move drops
 * into. It sits in the camera's world, so it pans and zooms with the design,
 * and it draws again after every change to the design, drafts included, so
 * outlines follow what a panel previews.
 */
export function SelectionLayer({
  editor,
  session,
  renderer,
  camera,
}: {
  editor: Editor;
  session: DesignSession;
  renderer: Renderer;
  camera: Camera;
}) {
  const [state, setState] = useState(editor.state);
  useEffect(() => {
    setState(editor.state);
    return editor.subscribe(() => setState(editor.state));
  }, [editor]);
  useRedrawOnChange(session);

  const rectOf = (id: string, outer = false) => {
    const rect = outer ? renderer.outerRect(id) : renderer.nodeRect(id);
    if (!rect) return null;
    const a = camera.toWorld(rect.left, rect.top);
    const b = camera.toWorld(rect.right, rect.bottom);
    return { x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y };
  };
  const [only] = state.selection;
  // Only what the browser can measure can be resized: not inside a sandboxed artboard.
  const resizable =
    state.selection.length === 1 && only !== undefined && renderer.measure(only) !== null;
  const hover =
    state.hover !== null && !state.selection.includes(state.hover)
      ? rectOf(state.hover, true)
      : null;
  const target = state.target === null ? null : rectOf(state.target);
  // Guides and the selection box come in page pixels.
  const world = (left: number, top: number, right: number, bottom: number) => {
    const a = camera.toWorld(left, top);
    const b = camera.toWorld(right, bottom);
    return { x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y };
  };
  const area =
    state.area && world(state.area.left, state.area.top, state.area.right, state.area.bottom);

  return (
    <>
      {hover && <div {...stylex.props(styles.box(hover), styles.hover)} />}
      {target && <div {...stylex.props(styles.box(target), styles.target)} />}
      {area && <div data-area {...stylex.props(styles.box(area), styles.area)} />}
      {state.guides.map((g, i) => (
        <div
          key={i}
          data-guide
          {...stylex.props(
            "x" in g
              ? styles.box(world(g.x, g.from, g.x, g.to))
              : styles.box(world(g.from, g.y, g.to, g.y)),
            "x" in g ? styles.vertical : styles.horizontal,
          )}
        />
      ))}
      {state.selection.map((id) => {
        const rect = rectOf(id, true);
        if (!rect) return null;
        const handles = resizable && !state.dragging;
        return (
          <div
            key={id}
            data-selected={id}
            {...stylex.props(styles.box(rect), styles.selected, id === state.hover && styles.hover)}
          >
            {handles &&
              HANDLES.map((handle) => (
                <div
                  key={handle}
                  data-handle={handle}
                  data-camera-ignore
                  {...stylex.props(
                    styles.handle(handle),
                    (handle === "n" || handle === "s") && styles.across,
                    (handle === "e" || handle === "w") && styles.along,
                  )}
                >
                  {CORNERS.includes(handle) && <Mark />}
                </div>
              ))}
            {!handles &&
              CORNERS.map((corner) => (
                <div key={corner} {...stylex.props(styles.corner(corner))}>
                  <Mark />
                </div>
              ))}
          </div>
        );
      })}
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

/** Says why a person's last edit didn't happen, above the tools. */
export function EditorNotice({ editor }: { editor: Editor }) {
  const [notice, setNotice] = useState(editor.state.notice);
  useEffect(() => editor.subscribe(() => setNotice(editor.state.notice)), [editor]);
  if (notice === null) return null;
  return (
    <div role="status" {...stylex.props(styles.notice)}>
      {notice}
    </div>
  );
}

/** The selection's corners, which carry a mark each. */
const CORNERS: readonly Handle[] = ["nw", "ne", "sw", "se"];

/** Where a handle sits on its box, as fractions of the width and height. */
const spot = (handle: Handle) => ({
  x: handle.includes("w") ? 0 : handle.includes("e") ? 1 : 0.5,
  y: handle.startsWith("n") ? 0 : handle.startsWith("s") ? 1 : 0.5,
});

const styles = stylex.create({
  notice: {
    position: "absolute",
    left: "50%",
    bottom: 75,
    transform: "translateX(-50%)",
    maxWidth: "min(480px, calc(100% - 30px))",
    paddingBlock: space.xs,
    paddingInline: space.sm,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: colors.accent,
    color: colors.onAccent,
    boxShadow: shadows.raised,
    fontSize: 13,
    lineHeight: 1.4,
    pointerEvents: "none",
  },
  box: (r: { x: number; y: number; width: number; height: number }) => ({
    position: "absolute",
    left: r.x,
    top: r.y,
    width: r.width,
    height: r.height,
    pointerEvents: "none",
  }),
  /** Selected and not under the pointer: the thin line. */
  selected: {
    outline: `calc(1.5px * var(--inv-zoom, 1)) solid ${colors.hover}`,
  },
  area: {
    outline: `calc(1px * var(--inv-zoom, 1)) solid ${colors.ink}`,
    backgroundColor: `color-mix(in srgb, ${colors.ink} 6%, transparent)`,
  },
  vertical: {
    borderLeft: `calc(1px * var(--inv-zoom, 1)) solid ${colors.danger}`,
  },
  horizontal: {
    borderTop: `calc(1px * var(--inv-zoom, 1)) solid ${colors.danger}`,
  },
  /** Under the pointer, selected or not: the heavy line. */
  hover: {
    outline: `calc(3px * var(--inv-zoom, 1)) solid ${colors.hover}`,
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
  target: {
    outline: `calc(1.5px * var(--inv-zoom, 1)) dashed ${colors.ink}`,
    boxShadow: `0 0 0 calc(3px * var(--inv-zoom, 1)) ${colors.halo}`,
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
});
