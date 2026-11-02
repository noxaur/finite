"use client";

import * as stylex from "@stylexjs/stylex";
import { useState } from "react";
import { colors, radii, space } from "@/styles/tokens.stylex";

/** The longest shared stylesheet the server accepts (`edit::MAX_CSS`). */
const CSS_LIMIT = 100_000;

/**
 * Shows the design's shared CSS, which every artboard renders with, and lets
 * a person change it. Saving replaces the whole stylesheet as one edit.
 * `onSave` returns why it failed, or `undefined`.
 */
export function SharedCssPanel({
  css,
  onSave,
  onClose,
}: {
  css: string | null;
  onSave: (css: string) => Promise<string | undefined>;
  onClose: () => void;
}) {
  // `null` until the person types, so the panel follows edits agents make meanwhile.
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState<string>();
  const text = draft ?? css ?? "";

  const save = async () => {
    if (draft === null || saving) return;
    setSaving(true);
    const sent = draft;
    const failure = await onSave(sent);
    // Keep anything typed while it saved.
    if (failure === undefined) setDraft((now) => (now === sent ? null : now));
    setFailed(failure);
    setSaving(false);
  };

  return (
    <form
      data-camera-ignore
      aria-label="Shared CSS"
      {...stylex.props(styles.panel)}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      onKeyDown={(e) => {
        if (e.key === "s" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          void save();
        } else if (e.key === "Escape") {
          e.preventDefault();
          onClose();
        }
      }}
    >
      <p {...stylex.props(styles.title)}>Shared CSS</p>
      <p {...stylex.props(styles.muted)}>
        Every artboard uses these styles. An artboard’s own styles override them.
      </p>
      <textarea
        value={text}
        maxLength={CSS_LIMIT}
        spellCheck={false}
        placeholder=":root { --brand: #c2410c; }"
        onChange={(e) => setDraft(e.target.value)}
        {...stylex.props(styles.input)}
      />
      {failed && (
        <p role="alert" {...stylex.props(styles.failed)}>
          {failed}
        </p>
      )}
      <div {...stylex.props(styles.actions)}>
        <button type="button" onClick={onClose} {...stylex.props(styles.button)}>
          Close
        </button>
        <button
          type="submit"
          disabled={draft === null || saving}
          {...stylex.props(styles.button, styles.primary)}
        >
          Save
        </button>
      </div>
    </form>
  );
}

const styles = stylex.create({
  panel: {
    position: "absolute",
    top: 52,
    right: space.sm,
    bottom: 52,
    width: 360,
    display: "flex",
    flexDirection: "column",
    gap: space.sm,
    margin: 0,
    padding: space.sm,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: colors.surface,
    boxShadow: "0 4px 16px rgba(0, 0, 0, 0.08)",
  },
  title: { margin: 0, fontWeight: 500 },
  muted: { margin: 0, color: colors.muted },
  input: {
    flexGrow: 1,
    padding: space.sm,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    borderRadius: radii.sm,
    backgroundColor: colors.bg,
    color: "inherit",
    fontFamily: "ui-monospace, monospace",
    fontSize: 12,
    resize: "none",
    outline: { default: "none", ":focus": `2px solid ${colors.accent}` },
  },
  failed: { margin: 0, color: colors.danger },
  actions: {
    display: "flex",
    justifyContent: "flex-end",
    gap: space.xs,
  },
  button: {
    height: 28,
    paddingInline: space.sm,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    borderRadius: radii.sm,
    backgroundColor: { default: "transparent", ":hover": colors.bg },
    color: "inherit",
    font: "inherit",
    cursor: "var(--cursor-pointer, pointer)",
  },
  primary: {
    borderColor: colors.accent,
    backgroundColor: { default: colors.accent, ":disabled": colors.border },
    color: colors.onAccent,
    cursor: {
      default: "var(--cursor-pointer, pointer)",
      ":disabled": "var(--cursor-not-allowed, not-allowed)",
    },
  },
});
