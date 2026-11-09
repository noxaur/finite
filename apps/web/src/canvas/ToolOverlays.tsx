"use client";

import * as stylex from "@stylexjs/stylex";
import { InspectLayer } from "@/components/InspectLayer";
import { colors } from "@/styles/tokens.stylex";
import type { CanvasEditor, EditorState } from "./editor";
import { toolOf } from "./tools/registry";
import { VECTOR_OVERLAYS } from "./tools/VectorOverlay";

/** What tools draw over the frames: the shape being dragged out, and the current tool's own overlay. */
export function ToolOverlays({ editor, state }: { editor: CanvasEditor; state: EditorState }) {
  const Overlay = toolOf(state.tool).Overlay ?? VECTOR_OVERLAYS[state.tool];
  const ghost = state.ghost;
  return (
    <>
      {ghost &&
        (ghost.d ? (
          <svg
            aria-hidden
            {...stylex.props(
              styles.at(ghost.box.x, ghost.box.y, ghost.box.width, ghost.box.height),
            )}
          >
            <path d={ghost.d} vectorEffect="non-scaling-stroke" {...stylex.props(styles.outline)} />
          </svg>
        ) : (
          <div
            aria-hidden
            {...stylex.props(
              styles.at(ghost.box.x, ghost.box.y, ghost.box.width, ghost.box.height),
              styles.ghost,
              ghost.round && styles.round,
            )}
          />
        ))}
      {Overlay && <Overlay host={editor} state={state} />}
      {state.tool === "inspect" && <InspectLayer editor={editor} inspect={state.inspect} />}
    </>
  );
}

const styles = stylex.create({
  at: (x: number, y: number, width: number, height: number) => ({
    position: "absolute",
    left: x,
    top: y,
    width,
    height,
    overflow: "visible",
    pointerEvents: "none",
  }),
  ghost: {
    boxSizing: "border-box",
    borderWidth: "calc(1px * var(--inv-zoom, 1))",
    borderStyle: "solid",
    borderColor: colors.hover,
    backgroundColor: "rgba(149, 206, 215, 0.25)",
  },
  outline: { fill: "none", stroke: colors.hover, strokeWidth: 1 },
  round: { borderRadius: "50%" },
});
