"use client";

import * as stylex from "@stylexjs/stylex";
import type { TextLabel } from "@finite/protocol";
import { useEffect, useRef, useState } from "react";
import { colors, fonts, radii, space } from "@/styles/tokens.stylex";
import type { CanvasEditor, EditorState } from "./editor";
import { labelAnchor } from "./labelAnchor";

/**
 * The agent's notes above the frames it made: a direction's title and why. People move them
 * (drag), edit them (double-click), and delete them (select, then Delete). A label that belongs
 * to a frame (see `labelAnchor`) keeps its screen size like the frame's title and sits by its
 * bottom edge just over it, as wide as the frame looks; over a frame too narrow for it, only the
 * title shows. A free label scales with the canvas.
 */
export function TextLabels({ editor, state }: { editor: CanvasEditor; state: EditorState }) {
  const frames = editor.frames.map((f) => editor.boxOf(f));
  return (
    <>
      {editor.texts.map((text) => {
        const at = state.textOverrides[text.id] ?? text;
        const selected = state.selectedText === text.id;
        const editing = state.editingLabel === text.id;
        const frame = labelAnchor(text, frames);
        // While dragged, an attached label moves by the drag from where it's drawn.
        const placed =
          frame === null
            ? styles.label(at.x, at.y, text.width)
            : styles.attached(at.x, frame.y + at.y - text.y, frame.width);
        return (
          <div
            key={text.id}
            data-text-id={editing ? undefined : text.id}
            {...stylex.props(
              placed,
              selected && (frame === null ? styles.selected : styles.selectedAttached),
            )}
          >
            {editing ? (
              <LabelEditor
                text={text}
                attached={frame !== null}
                onDone={(next) => {
                  editor.editLabel(null);
                  if (next && (next.title !== text.title || next.body !== text.body)) {
                    void editor.patch({ op: "setText", text: { ...text, ...next } });
                  }
                }}
              />
            ) : (
              <>
                <div {...stylex.props(styles.title, frame && styles.attachedTitle)}>
                  {text.title}
                </div>
                {text.body && (
                  <div {...stylex.props(styles.body, frame && styles.attachedBody)}>
                    {text.body}
                  </div>
                )}
              </>
            )}
          </div>
        );
      })}
    </>
  );
}

function LabelEditor({
  text,
  attached,
  onDone,
}: {
  text: TextLabel;
  /** Drawn at screen size, so its outline and type aren't scaled by the zoom. */
  attached: boolean;
  onDone: (next: { title: string; body: string } | null) => void;
}) {
  const [title, setTitle] = useState(text.title);
  const [body, setBody] = useState(text.body);
  const box = useRef<HTMLDivElement>(null);
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => first.current?.select(), []);
  const keys = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onDone(null);
    } else if (e.key === "Enter" && (e.metaKey || !(e.target instanceof HTMLTextAreaElement))) {
      e.preventDefault();
      onDone({ title, body });
    }
  };
  return (
    <div
      ref={box}
      data-canvas-ui=""
      data-camera-ignore=""
      onBlur={(e) => {
        if (!box.current?.contains(e.relatedTarget as Node | null)) onDone({ title, body });
      }}
      {...stylex.props(styles.editor)}
    >
      <input
        ref={first}
        value={title}
        aria-label="Title"
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={keys}
        {...stylex.props(
          styles.field,
          styles.title,
          attached && styles.attachedField,
          attached && styles.attachedTitle,
        )}
      />
      <textarea
        value={body}
        aria-label="Why"
        rows={3}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={keys}
        {...stylex.props(
          styles.field,
          styles.body,
          attached && styles.attachedField,
          attached && styles.attachedFieldBody,
        )}
      />
    </div>
  );
}

const styles = stylex.create({
  label: (x: number, y: number, width: number) => ({
    position: "absolute",
    left: x,
    top: y,
    width,
    padding: space.xs,
    borderRadius: radii.sm,
    color: colors.text,
    fontFamily: fonts.sans,
    cursor: "default",
  }),
  /**
   * `top` is the frame's top. Scaled back to screen size from there, the label ends a gap above
   * the frame's title (15px + 6px), as wide as the frame is on screen, within limits.
   */
  attached: (x: number, top: number, frameWidth: number) => ({
    position: "absolute",
    left: x,
    top,
    width: `clamp(96px, calc(${frameWidth}px / var(--inv-zoom, 1)), 560px)`,
    transform: "scale(var(--inv-zoom, 1)) translateY(calc(-100% - 27px))",
    transformOrigin: "0 0",
    containerType: "inline-size",
    padding: space.xs,
    borderRadius: radii.sm,
    color: colors.text,
    fontFamily: fonts.sans,
    cursor: "default",
  }),
  selected: {
    outline: `calc(1.5px * var(--inv-zoom, 1)) solid ${colors.hover}`,
  },
  selectedAttached: { outline: `1.5px solid ${colors.hover}` },
  title: { fontSize: 20, lineHeight: "26px", fontWeight: 600 },
  body: { marginTop: space.xs, fontSize: 14, lineHeight: "20px", color: colors.muted },
  attachedTitle: { fontSize: 13, lineHeight: "17px" },
  /** Over a frame narrower than 140px on screen (less the padding), the body would wrap a word a line. */
  attachedBody: {
    marginTop: space.px,
    fontSize: 12,
    lineHeight: "16px",
    display: { default: "block", "@container (max-width: 133px)": "none" },
  },
  editor: { display: "flex", flexDirection: "column", gap: space.xs },
  field: {
    width: "100%",
    padding: 0,
    borderWidth: 0,
    backgroundColor: "transparent",
    fontFamily: fonts.sans,
    color: "inherit",
    resize: "none",
    outline: `calc(1.5px * var(--inv-zoom, 1)) solid ${colors.hover}`,
  },
  attachedField: { outline: `1.5px solid ${colors.hover}` },
  attachedFieldBody: { fontSize: 12, lineHeight: "16px" },
});
