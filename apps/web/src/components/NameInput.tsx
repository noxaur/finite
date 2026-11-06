"use client";

import * as stylex from "@stylexjs/stylex";

/**
 * A name edited in place. Enter or leaving the field keeps a changed, non-empty
 * name through `onRename`; Escape and an empty name put `value` back.
 */
export function NameInput({
  label,
  value,
  placeholder,
  autoFocus,
  onRename,
  onDone,
  style,
}: {
  label: string;
  value: string;
  placeholder?: string;
  /** Focuses the field with its text selected, for a rename the person just asked for. */
  autoFocus?: boolean;
  onRename: (name: string) => void;
  /** Runs when the field is left, after any rename. */
  onDone?: () => void;
  style: stylex.StyleXStyles;
}) {
  return (
    <input
      aria-label={label}
      defaultValue={value}
      placeholder={placeholder}
      autoFocus={autoFocus}
      spellCheck={false}
      onFocus={autoFocus ? (e) => e.currentTarget.select() : undefined}
      onBlur={(e) => {
        const next = e.target.value.trim();
        if (next && next !== value) onRename(next);
        else e.target.value = value;
        onDone?.();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        else if (e.key === "Escape") {
          e.currentTarget.value = value;
          e.currentTarget.blur();
        }
      }}
      {...stylex.props(style)}
    />
  );
}
