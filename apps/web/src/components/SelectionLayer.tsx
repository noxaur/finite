"use client";

import * as stylex from "@stylexjs/stylex";
import { useEffect, useState } from "react";
import type { Camera } from "@/design/camera";
import type { Editor } from "@/design/editing/editor";
import { HANDLES, type Handle } from "@/design/editing/geometry";
import type { Renderer } from "@/design/renderer";
import { colors, radii, space } from "@/styles/tokens.stylex";

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
 * Draws what the editor shows on the canvas: the selection with its resize
 * handles, the node under the pointer, and the container a move drops
 * into. It sits in the camera's world, so it pans and zooms with the design.
 * `version` changes whenever the design does, so it follows edits.
 */
export function SelectionLayer({
  editor,
  renderer,
  camera,
}: {
  editor: Editor;
  renderer: Renderer;
  camera: Camera;
  version: number;
}) {
  const [state, setState] = useState(editor.state);
  useEffect(() => {
    setState(editor.state);
    return editor.subscribe(() => setState(editor.state));
  }, [editor]);

  const rectOf = (id: string) => {
    const rect = renderer.nodeRect(id);
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
    state.hover !== null && !state.selection.includes(state.hover) ? rectOf(state.hover) : null;
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
        const rect = rectOf(id);
        if (!rect) return null;
        return (
          <div key={id} data-selected={id} {...stylex.props(styles.box(rect), styles.selected)}>
            {resizable &&
              !state.dragging &&
              HANDLES.map((handle) => (
                <div
                  key={handle}
                  data-handle={handle}
                  data-camera-ignore
                  {...stylex.props(styles.handle(handle))}
                />
              ))}
          </div>
        );
      })}
    </>
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

/** Where a handle sits on its box, as fractions of the width and height. */
const spot = (handle: Handle) => ({
  x: handle.includes("w") ? 0 : handle.includes("e") ? 1 : 0.5,
  y: handle.startsWith("n") ? 0 : handle.startsWith("s") ? 1 : 0.5,
});

const styles = stylex.create({
  notice: {
    position: "absolute",
    left: "50%",
    bottom: 76,
    transform: "translateX(-50%)",
    maxWidth: "min(480px, calc(100% - 32px))",
    paddingBlock: space.xs,
    paddingInline: space.sm,
    borderRadius: radii.sm,
    backgroundColor: colors.accent,
    color: colors.onAccent,
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
  selected: {
    outline: `calc(1.5px * var(--inv-zoom, 1)) solid ${colors.ink}`,
    boxShadow: `0 0 0 calc(3px * var(--inv-zoom, 1)) ${colors.halo}`,
  },
  area: {
    outline: `calc(1px * var(--inv-zoom, 1)) solid ${colors.ink}`,
    backgroundColor: "rgba(26, 26, 24, 0.06)",
  },
  vertical: {
    borderLeft: `calc(1px * var(--inv-zoom, 1)) solid ${colors.danger}`,
  },
  horizontal: {
    borderTop: `calc(1px * var(--inv-zoom, 1)) solid ${colors.danger}`,
  },
  hover: {
    outline: `calc(1px * var(--inv-zoom, 1)) solid ${colors.ink}`,
    opacity: 0.5,
  },
  target: {
    outline: `calc(1.5px * var(--inv-zoom, 1)) dashed ${colors.ink}`,
    boxShadow: `0 0 0 calc(3px * var(--inv-zoom, 1)) ${colors.halo}`,
  },
  handle: (handle: Handle) => ({
    position: "absolute",
    left: `${spot(handle).x * 100}%`,
    top: `${spot(handle).y * 100}%`,
    width: "calc(9px * var(--inv-zoom, 1))",
    height: "calc(9px * var(--inv-zoom, 1))",
    transform: "translate(-50%, -50%)",
    backgroundColor: colors.halo,
    border: `calc(1.5px * var(--inv-zoom, 1)) solid ${colors.ink}`,
    boxSizing: "border-box",
    cursor: CURSORS[handle],
    pointerEvents: "auto",
  }),
});
