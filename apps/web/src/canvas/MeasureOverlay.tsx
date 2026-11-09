"use client";

import * as stylex from "@stylexjs/stylex";
import type { Rect } from "@finite/protocol";
import { useSyncExternalStore } from "react";
import { colors, fonts, radii } from "@/styles/tokens.stylex";
import type { EditorState } from "./editor";
import { gaps } from "./objects";
import { hoveredBox, measureFrom, selectedBox } from "./tools/measure";
import type { ToolHost } from "./tools/host";

/**
 * The Measurement tool's overlay: the two boxes and the distances between them. Lines and
 * labels keep their screen size, so a gap reads the same at any zoom. The label shows canvas
 * units, which are CSS pixels inside a frame.
 */
export function MeasureOverlay({ host }: { host: ToolHost; state: EditorState }) {
  const picked = useSyncExternalStore(measureFrom.subscribe, measureFrom.get, () => null);
  const a = picked ?? selectedBox(host);
  const b = hoveredBox(host);
  if (!a) return null;
  const lines = b ? gaps(a, b) : [];
  return (
    <>
      <Outline box={a} />
      {b && <Outline box={b} />}
      {lines.map((g, i) => {
        const horizontal = g.a.y === g.b.y;
        const box: Rect = horizontal
          ? { x: Math.min(g.a.x, g.b.x), y: g.a.y, width: Math.abs(g.b.x - g.a.x), height: 0 }
          : { x: g.a.x, y: Math.min(g.a.y, g.b.y), width: 0, height: Math.abs(g.b.y - g.a.y) };
        return (
          <div key={i} data-measure={g.label} {...stylex.props(styles.line(box, horizontal))}>
            <span {...stylex.props(styles.label)}>{g.label}</span>
          </div>
        );
      })}
    </>
  );
}

function Outline({ box }: { box: Rect }) {
  return <div aria-hidden {...stylex.props(styles.outline(box))} />;
}

const styles = stylex.create({
  outline: (r: Rect) => ({
    position: "absolute",
    left: r.x,
    top: r.y,
    width: r.width,
    height: r.height,
    boxSizing: "border-box",
    outline: `calc(1px * var(--inv-zoom, 1)) solid ${colors.danger}`,
    pointerEvents: "none",
  }),
  line: (r: Rect, horizontal: boolean) => ({
    position: "absolute",
    left: r.x,
    top: r.y,
    width: r.width,
    height: r.height,
    pointerEvents: "none",
    borderTopWidth: horizontal ? "calc(1px * var(--inv-zoom, 1))" : 0,
    borderLeftWidth: horizontal ? 0 : "calc(1px * var(--inv-zoom, 1))",
    borderStyle: "solid",
    borderColor: colors.danger,
    borderBottomWidth: 0,
    borderRightWidth: 0,
  }),
  label: {
    position: "absolute",
    left: "50%",
    top: "50%",
    transform: "translate(-50%, -50%) scale(var(--inv-zoom, 1))",
    paddingBlock: 1,
    paddingInline: 4,
    borderRadius: radii.sm,
    backgroundColor: colors.danger,
    color: colors.halo,
    fontFamily: fonts.sans,
    fontSize: 11,
    lineHeight: "14px",
    whiteSpace: "nowrap",
  },
});
