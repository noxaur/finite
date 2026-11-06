"use client";

import * as stylex from "@stylexjs/stylex";
import type { TextLabel } from "@finite/protocol";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { colors, fonts, radii, space } from "@/styles/tokens.stylex";
import { bridgeOf } from "./bridge";
import type { CanvasEditor, EditorState, TextEdit } from "./editor";
import { labelAnchor } from "./labelAnchor";

/**
 * The agent's notes above the frames it made: a direction's title and why. People move them
 * (drag), edit them (double-click), and delete them (select, then Delete). A label that belongs
 * to a frame (see `labelAnchor`) sits by its bottom edge just over the frame's title.
 */
export function TextLabels({ editor, state }: { editor: CanvasEditor; state: EditorState }) {
  const frames = editor.frames.map((f) => editor.boxOf(f));
  return (
    <>
      {editor.texts.map((text) => {
        const at = state.textOverrides[text.id] ?? text;
        const selected = state.selectedText === text.id;
        const editing = state.editingLabel === text.id;
        const above = labelAnchor(text, frames);
        // While dragged, an attached label moves by the drag from where it's drawn.
        const placed =
          above === null
            ? styles.label(at.x, at.y, text.width)
            : styles.attached(at.x, above + at.y - text.y, text.width);
        return (
          <div
            key={text.id}
            data-text-id={editing ? undefined : text.id}
            {...stylex.props(placed, selected && styles.selected)}
          >
            {editing ? (
              <LabelEditor
                text={text}
                onDone={(next) => {
                  editor.editLabel(null);
                  if (next && (next.title !== text.title || next.body !== text.body)) {
                    void editor.patch({ op: "setText", text: { ...text, ...next } });
                  }
                }}
              />
            ) : (
              <>
                <div {...stylex.props(styles.title)}>{text.title}</div>
                {text.body && <div {...stylex.props(styles.body)}>{text.body}</div>}
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
  onDone,
}: {
  text: TextLabel;
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
        {...stylex.props(styles.field, styles.title)}
      />
      <textarea
        value={body}
        aria-label="Why"
        rows={3}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={keys}
        {...stylex.props(styles.field, styles.body)}
      />
    </div>
  );
}

/**
 * Typing into an element's text, in place: an editable box over the element with its font,
 * while the element's own text is hidden through the bridge. Enter keeps it (one `text` edit),
 * Shift-Enter breaks the line, Escape puts it back.
 */
export function TextEditor({ editor, editing }: { editor: CanvasEditor; editing: TextEdit }) {
  const ref = useRef<HTMLDivElement>(null);
  const done = useRef(false);
  const frame = editor.frame(editing.frameId);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.textContent = editing.text;
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    getSelection()?.removeAllRanges();
    getSelection()?.addRange(range);
    bridgeOf(editing.frameId)?.preview(editing.loc, { color: "transparent" });
  }, [editing]);
  if (!frame) return null;
  const b = editor.boxOf(frame);
  const f = editing.font;
  const finish = (keep: boolean) => {
    if (done.current) return;
    done.current = true;
    void editor.finishText(keep ? (ref.current?.innerText ?? editing.text) : null);
  };
  return (
    <div
      ref={ref}
      contentEditable="plaintext-only"
      suppressContentEditableWarning
      role="textbox"
      aria-label="Text"
      data-canvas-ui=""
      data-camera-ignore=""
      onBlur={() => finish(true)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") finish(false);
        else if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          finish(true);
        }
      }}
      {...stylex.props(styles.inline)}
      style={{
        left: b.x + editing.rect.x,
        top: b.y + editing.rect.y,
        minWidth: editing.rect.width,
        minHeight: editing.rect.height,
        fontFamily: f.fontFamily,
        fontSize: f.fontSize,
        fontWeight: f.fontWeight,
        fontStyle: f.fontStyle,
        lineHeight: f.lineHeight,
        letterSpacing: f.letterSpacing,
        color: f.color,
        textAlign: f.textAlign as React.CSSProperties["textAlign"],
        textTransform: f.textTransform as React.CSSProperties["textTransform"],
        paddingTop: f.paddingTop,
        paddingRight: f.paddingRight,
        paddingBottom: f.paddingBottom,
        paddingLeft: f.paddingLeft,
      }}
    />
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
  /** `bottom` is the frame's top: the label ends a gap above the frame's title (15px + 6px). */
  attached: (x: number, bottom: number, width: number) => ({
    position: "absolute",
    left: x,
    top: bottom,
    width,
    transform: "translateY(calc(-100% - 27px * var(--inv-zoom, 1)))",
    padding: space.xs,
    borderRadius: radii.sm,
    color: colors.text,
    fontFamily: fonts.sans,
    cursor: "default",
  }),
  selected: {
    outline: `calc(1.5px * var(--inv-zoom, 1)) solid ${colors.hover}`,
  },
  title: { fontSize: 20, lineHeight: "26px", fontWeight: 600 },
  body: { marginTop: space.xs, fontSize: 14, lineHeight: "20px", color: colors.muted },
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
  inline: {
    position: "absolute",
    boxSizing: "border-box",
    whiteSpace: "pre-wrap",
    outline: `calc(1.5px * var(--inv-zoom, 1)) solid ${colors.hover}`,
    caretColor: colors.hover,
    cursor: "text",
  },
});
