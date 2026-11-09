"use client";

import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";
import type { IconName } from "@/lib/icons";
import { colors, fonts, radii, space } from "@/styles/tokens.stylex";
import { Icon } from "./Icons";

/** The pieces the command menu is built from. Each flow is these, with different props. */

/** The search bar: a leading icon (back, once a flow is chosen), the text, and chips that name the flow. */
export function CommandSearch({
  value,
  placeholder,
  chips = [],
  onChange,
  onBack,
  inputRef,
  onKeyDown,
}: {
  value: string;
  placeholder: string;
  chips?: ReadonlyArray<string>;
  onChange: (value: string) => void;
  onBack?: (() => void) | undefined;
  inputRef: React.Ref<HTMLInputElement>;
  onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
}) {
  return (
    <div {...stylex.props(styles.search)}>
      {onBack ? (
        <button type="button" aria-label="Back" onClick={onBack} {...stylex.props(styles.lead)}>
          <Icon name="arrowLeft" size={15} />
        </button>
      ) : (
        <span {...stylex.props(styles.lead)}>
          <Icon name="search" size={15} />
        </span>
      )}
      <input
        ref={inputRef}
        value={value}
        placeholder={placeholder}
        aria-label={placeholder}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        {...stylex.props(styles.input)}
      />
      {chips.map((chip) => (
        <span key={chip} {...stylex.props(styles.chip)}>
          {chip}
        </span>
      ))}
    </div>
  );
}

/** A heading above a set of rows. */
export function CommandGroup({ children }: { children: ReactNode }) {
  return <div {...stylex.props(styles.group)}>{children}</div>;
}

/**
 * The one row of the menu: an action (icon, label, note), a folder (icon and label, a chevron
 * on the right), or a repo. `on` is the highlighted row.
 */
export function CommandItem({
  icon,
  label,
  note,
  on,
  open,
  onClick,
  onHover,
}: {
  icon: IconName;
  label: string;
  note?: string | undefined;
  on?: boolean | undefined;
  /** Draws the chevron that says the row opens a folder. */
  open?: boolean | undefined;
  onClick?: (() => void) | undefined;
  onHover?: (() => void) | undefined;
}) {
  return (
    <div
      role="option"
      aria-selected={!!on}
      tabIndex={-1}
      onClick={onClick}
      onMouseMove={onHover}
      {...stylex.props(styles.item, on && styles.itemOn, onClick && styles.clickable)}
    >
      <span {...stylex.props(styles.icon)}>
        <Icon name={icon} size={15} />
      </span>
      <span {...stylex.props(styles.label)}>{label}</span>
      {note && <span {...stylex.props(styles.note)}>{note}</span>}
      {open && (
        <span {...stylex.props(styles.chevron, note ? styles.chevronTall : styles.chevronOne)}>
          <Icon name="next" size={15} />
        </span>
      )}
    </div>
  );
}

/** One key on a keycap. Arrows, return and command are icons; words like esc stay text. */
const KEY_ICONS: Record<string, IconName> = {
  "↑": "arrowUp",
  "↓": "arrowDown",
  "↵": "enter",
  "⌘": "command",
};

export function Kbd({ children }: { children: string }) {
  const icon = KEY_ICONS[children];
  return (
    <kbd {...stylex.props(styles.kbd, !icon && styles.kbdWord)}>
      {icon ? <Icon name={icon} size={12} /> : children}
    </kbd>
  );
}

/** The key hints at the foot of the menu: what each key does right now. */
export function CommandHints({
  hints,
}: {
  hints: ReadonlyArray<{ keys: ReadonlyArray<string>; label: string }>;
}) {
  return (
    <div {...stylex.props(styles.hints)}>
      {hints.map(({ keys, label }) => (
        <span key={label} {...stylex.props(styles.hint)}>
          <span {...stylex.props(styles.keys)}>
            {keys.map((key) => (
              <Kbd key={key}>{key}</Kbd>
            ))}
          </span>
          {label}
        </span>
      ))}
    </div>
  );
}

const styles = stylex.create({
  search: {
    display: "flex",
    alignItems: "center",
    gap: space.ms,
    height: 48,
    paddingInline: space.lg,
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderBottomColor: colors.borderSoft,
  },
  lead: {
    display: "flex",
    flexShrink: 0,
    padding: 0,
    borderWidth: 0,
    backgroundColor: "transparent",
    color: colors.muted,
    cursor: "inherit",
  },
  input: {
    flexGrow: 1,
    minWidth: 0,
    padding: 0,
    borderWidth: 0,
    backgroundColor: "transparent",
    color: colors.text,
    fontFamily: fonts.sans,
    fontSize: 15,
    outline: "none",
    "::placeholder": { color: colors.faint },
  },
  chip: {
    display: "inline-flex",
    alignItems: "center",
    flexShrink: 0,
    height: 24,
    paddingInline: space.ms,
    borderRadius: radii.md,
    backgroundColor: colors.sunk,
    color: colors.text,
    fontSize: 12,
    fontWeight: 500,
    whiteSpace: "nowrap",
  },
  group: {
    paddingTop: { default: space.md, ":first-child": space.xs },
    paddingBottom: space.sm,
    paddingInline: space.md,
    color: colors.faint,
    fontSize: 11,
    fontWeight: 500,
    letterSpacing: 0.4,
  },
  item: {
    display: "grid",
    gridTemplateColumns: "auto 1fr auto",
    alignItems: "center",
    columnGap: space.ms,
    rowGap: space.xs,
    justifyItems: "start",
    paddingBlock: space.sm,
    paddingInline: space.md,
    borderRadius: radii.md,
  },
  itemOn: { backgroundColor: colors.activeFill },
  clickable: { cursor: "var(--cursor-pointer, pointer)" },
  icon: { display: "flex", width: 15, color: colors.muted },
  label: { minWidth: 0, fontSize: 13, fontWeight: 500, color: colors.text },
  note: {
    gridColumn: 2,
    maxWidth: "100%",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: 12,
    color: colors.muted,
  },
  chevron: {
    display: "flex",
    gridColumn: 3,
    justifySelf: "end",
    color: colors.muted,
  },
  /** Centered on a two-line row. */
  chevronTall: { gridRow: "1 / span 2" },
  chevronOne: { gridRow: 1 },
  hints: {
    display: "flex",
    alignItems: "center",
    gap: space.md,
    paddingBlock: space.sm,
    paddingInline: space.lg,
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: colors.borderSoft,
  },
  hint: {
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    color: colors.muted,
    fontSize: 11,
  },
  keys: { display: "flex", gap: space.xs },
  kbd: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    minWidth: 18,
    height: 18,
    boxSizing: "border-box",
    borderRadius: radii.sm,
    backgroundColor: colors.sunk,
    color: colors.muted,
    fontFamily: fonts.sans,
    fontSize: 11,
  },
  kbdWord: { paddingInline: space.xs },
});
