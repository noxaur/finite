"use client";

import * as stylex from "@stylexjs/stylex";
import type { Frame } from "@finite/protocol";
import { useMemo } from "react";
import type { CanvasEditor } from "@/canvas/editor";
import { space } from "@/styles/tokens.stylex";
import { GeometryField, Section } from "./controls";
import type { Geometry, GeometryFacts } from "./geometry";
import type { StyleEdit, StyleEditor } from "./styleEditor";

type Box = { x: number; y: number; width: number; height: number };
const FIELD: Record<Geometry, keyof Box> = { x: "x", y: "y", w: "width", h: "height" };

/** The box an edit from these fields gives the frame: its fields ride in `styles` as numbers. */
function boxAfter(frame: Box, edits: ReadonlyArray<StyleEdit> | null | undefined): Box {
  const next = { ...frame };
  for (const e of edits ?? []) {
    for (const [k, v] of Object.entries(e.styles)) if (v !== null) next[k as keyof Box] = Number(v);
  }
  return next;
}

/**
 * A selected frame's place and size on the canvas: X, Y, W and H, typed or scrubbed. They show
 * on the canvas as they change and are kept as one `canvas.patch`.
 */
export function GeometryFrameFields({ editor, frame }: { editor: CanvasEditor; frame: Frame }) {
  const box = editor.boxOf(frame);
  const fields: StyleEditor = useMemo(() => {
    let shown: ReadonlyArray<StyleEdit> | null = null;
    const show = (edits: ReadonlyArray<StyleEdit> | null) => {
      shown = edits;
      editor.previewFrame(frame.id, edits ? boxAfter(frame, edits) : null);
    };
    const keep = async (edits: ReadonlyArray<StyleEdit>) => {
      const b = boxAfter(frame, edits);
      await editor.patch({
        op: "resizeFrames",
        frames: [{ id: frame.id, ...b, ...(frame.hug !== undefined ? { hug: frame.hug } : {}) }],
      });
      show(null);
      void editor.refreshSelection();
    };
    return {
      begin: () => ({
        preview: (edits) => (show(edits), null),
        commit: (final) => {
          const edits = final ?? shown;
          if (edits) void keep(edits);
          else show(null);
        },
        cancel: () => show(null),
      }),
      drive: (e, element, run) => {
        const from = { x: e.clientX, y: e.clientY };
        let edits: ReadonlyArray<StyleEdit> | null = null;
        const ctl = new AbortController();
        const end = (commit: boolean) => {
          ctl.abort();
          if (commit && edits) void keep(edits);
          else show(null);
          run.end?.(commit);
        };
        const move = (m: PointerEvent) => {
          if (Math.hypot(m.clientX - from.x, m.clientY - from.y) < 3 && !edits) return;
          edits = run.move({ x: m.clientX, y: m.clientY, shift: m.shiftKey, free: m.metaKey });
          show(edits);
        };
        window.addEventListener("pointermove", move, { signal: ctl.signal });
        window.addEventListener("pointerup", () => end(true), { signal: ctl.signal });
        element.addEventListener("pointercancel", () => end(false), { signal: ctl.signal });
        return () => end(false);
      },
      commit: keep,
    };
  }, [editor, frame]);
  const geometry: GeometryFacts = {
    values: { x: box.x, y: box.y, w: box.width, h: box.height },
    movable: true,
    editFor: (field, n) =>
      Number.isFinite(n) && (field === "w" || field === "h" ? n >= 20 : true)
        ? { kind: "setStyles", ids: [frame.id], styles: { [FIELD[field]]: String(Math.round(n)) } }
        : null,
  };
  return (
    <Section title="Frame">
      <div {...stylex.props(styles.grid)}>
        {(["x", "y", "w", "h"] as const).map((f) => (
          <GeometryField key={f} field={f} editor={fields} geometry={geometry} />
        ))}
      </div>
    </Section>
  );
}

const styles = stylex.create({
  grid: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: space.sm,
    paddingInline: space.ms,
  },
});
