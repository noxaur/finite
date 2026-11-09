"use client";

import * as stylex from "@stylexjs/stylex";
import { MeasureLayer } from "@/components/MeasureLayer";
import { colors } from "@/styles/tokens.stylex";
import type { CanvasEditor, EditorState } from "./editor";
import { toolOf } from "./tools/registry";

/** What tools draw over the frames: the shape being dragged out, and the current tool's own overlay. */
export function ToolOverlays({ editor, state }: { editor: CanvasEditor; state: EditorState }) {
  const Overlay = toolOf(state.tool).Overlay;
  const ghost = state.ghost;
  return (
    <>
      {ghost && (
        <div
          aria-hidden
          {...stylex.props(
            styles.ghost(ghost.box.x, ghost.box.y, ghost.box.width, ghost.box.height),
            ghost.round && styles.round,
          )}
        />
      )}
      {Overlay && <Overlay host={editor} state={state} />}
      {state.tool === "measure" && <MeasureLayer editor={editor} measure={state.measure} />}
    </>
  );
}

const styles = stylex.create({
  ghost: (x: number, y: number, width: number, height: number) => ({
    position: "absolute",
    left: x,
    top: y,
    width,
    height,
    boxSizing: "border-box",
    borderWidth: "calc(1px * var(--inv-zoom, 1))",
    borderStyle: "solid",
    borderColor: colors.hover,
    backgroundColor: "rgba(149, 206, 215, 0.25)",
    pointerEvents: "none",
  }),
  round: { borderRadius: "50%" },
});
