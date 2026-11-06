"use client";

import * as stylex from "@stylexjs/stylex";
import type { Token, TokenMode } from "@finite/protocol";
import { useEffect, useRef, useState } from "react";
import { finite } from "@/client/finite";
import { setAlpha } from "@/design/editing/colors";
import { displayName, hexOf, isColor } from "@/lib/tokens";
import { colors, fonts, radii, shadows, size, space } from "@/styles/tokens.stylex";
import { IconButton } from "./Button";
import { type ColorPick, ColorPicker } from "./ColorPicker";

const MODES: readonly TokenMode[] = ["light", "dark"];

/** A token name as CSS wants it: `--brand`, whether or not it was typed with the dashes. */
export const tokenName = (typed: string) => {
  const t = typed.trim();
  return t.startsWith("--") ? t : `--${t}`;
};

/**
 * The design's tokens, at the bottom of the left sidebar: the CSS custom properties in its
 * `@theme` (Light) and `.dark` (Dark) blocks, each value editable in place. Colors get a swatch
 * that opens the color picker. Clearing a value takes the token out of that mode.
 */
export function TokensSection({ designId }: { designId: string }) {
  const [tokens, setTokens] = useState<readonly Token[] | null>(null);
  const [failed, setFailed] = useState<string>();
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    let live = true;
    finite.request("tokens.get", { designId }).then(
      (t) => live && setTokens(t),
      (e: Error) => live && setFailed(e.message),
    );
    return () => {
      live = false;
    };
  }, [designId]);

  const save = async (name: string, mode: TokenMode, value: string | null) => {
    try {
      setTokens(await finite.request("tokens.set", { designId, name, mode, value }));
      setFailed(undefined);
      return true;
    } catch (e) {
      setFailed(e instanceof Error ? e.message : String(e));
      return false;
    }
  };

  return (
    <section aria-label="Tokens" {...stylex.props(styles.section)}>
      <div {...stylex.props(styles.head)}>
        <span>Tokens</span>
        <IconButton
          size="small"
          variant="ghost"
          icon="plus"
          label="Add token"
          onClick={() => setAdding(true)}
        />
      </div>
      <div {...stylex.props(styles.columns)}>
        <span />
        <span>Light</span>
        <span>Dark</span>
      </div>
      {tokens?.length === 0 && !adding && <p {...stylex.props(styles.note)}>No tokens yet</p>}
      {tokens?.map((t) => (
        <div key={t.name} {...stylex.props(styles.row)}>
          <span title={t.name} {...stylex.props(styles.name)}>
            {displayName(t.name)}
          </span>
          {MODES.map((mode) => (
            <ValueField
              key={mode}
              name={t.name}
              value={t[mode] ?? ""}
              onSave={(v) => void save(t.name, mode, v.trim() === "" ? null : v.trim())}
            />
          ))}
        </div>
      ))}
      {adding && (
        <NewToken
          onCancel={() => setAdding(false)}
          onAdd={async (name, value) => {
            if (await save(tokenName(name), "light", value)) setAdding(false);
          }}
        />
      )}
      {failed && (
        <p role="alert" {...stylex.props(styles.failed)}>
          {failed}
        </p>
      )}
    </section>
  );
}

function ValueField({
  name,
  value,
  onSave,
}: {
  name: string;
  value: string;
  onSave: (value: string) => void;
}) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <span {...stylex.props(styles.value)}>
      {isColor(value) && <ColorSwatch name={name} color={value} onPick={onSave} />}
      <input
        value={text}
        aria-label={`${displayName(name)} value`}
        placeholder="—"
        spellCheck={false}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => text !== value && onSave(text)}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            setText(value);
            e.currentTarget.blur();
          }
        }}
        {...stylex.props(styles.input)}
      />
    </span>
  );
}

function NewToken({
  onAdd,
  onCancel,
}: {
  onAdd: (name: string, value: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const keys = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && name.trim() && value.trim()) onAdd(name, value.trim());
    if (e.key === "Escape") onCancel();
  };
  return (
    <div {...stylex.props(styles.row)}>
      <input
        autoFocus
        value={name}
        placeholder="name"
        aria-label="New token name"
        onChange={(e) => setName(e.target.value)}
        onKeyDown={keys}
        {...stylex.props(styles.input)}
      />
      <input
        value={value}
        placeholder="value"
        aria-label="New token value"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={keys}
        {...stylex.props(styles.input, styles.span2)}
      />
    </div>
  );
}

function ColorSwatch({
  name,
  color,
  onPick,
}: {
  name: string;
  color: string;
  onPick: (color: string) => void;
}) {
  const [button, setButton] = useState<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  // What the picker shows until it closes: a token is saved once, not on every drag.
  const [picked, setPicked] = useState<string | null>(null);
  const kept = useRef<string | null>(null);
  const parsed = typeof document === "undefined" ? undefined : hexOf(picked ?? color);
  const toColor = (pick: ColorPick) =>
    pick.alpha < 100 ? setAlpha(pick.hex, pick.alpha) : pick.hex;
  const close = () => {
    setOpen(false);
    setPicked(null);
    kept.current = null;
    if (picked !== null && picked !== color) onPick(picked);
  };
  return (
    <>
      <button
        ref={setButton}
        type="button"
        aria-label={`Pick a color for ${name}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
        {...stylex.props(styles.swatch, open && styles.swatchOpen)}
        style={{ background: picked ?? color }}
      />
      {open && button && (
        <ColorPicker
          anchor={button}
          title={`Color for ${displayName(name)}`}
          color={parsed?.hex ?? "#000000"}
          alpha={Math.round((parsed?.alpha ?? 1) * 100)}
          edit={{
            preview: (pick) => setPicked(toColor(pick)),
            commit: (pick) => {
              kept.current = toColor(pick);
              setPicked(kept.current);
            },
            cancel: () => setPicked(kept.current),
          }}
          onClose={close}
        />
      )}
    </>
  );
}

const styles = stylex.create({
  section: {
    display: "flex",
    flexDirection: "column",
    gap: space.xs,
    paddingBlock: space.sm,
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: colors.borderSoft,
    fontFamily: fonts.sans,
  },
  head: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    height: size.sm,
    paddingInline: space.ms,
    color: colors.text,
    fontSize: 13,
    fontWeight: 500,
  },
  columns: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr 1fr",
    gap: space.xs,
    paddingInline: space.ms,
    color: colors.faint,
    fontSize: 11,
  },
  row: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr 1fr",
    alignItems: "center",
    gap: space.xs,
    minHeight: size.sm,
    paddingInline: space.ms,
  },
  name: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    color: colors.text,
    fontFamily: fonts.mono,
    fontSize: 12,
  },
  value: { display: "flex", alignItems: "center", gap: space.xs, minWidth: 0 },
  input: {
    minWidth: 0,
    width: "100%",
    height: size.xs,
    paddingInline: space.xs,
    borderWidth: 0,
    borderRadius: radii.sm,
    backgroundColor: { default: "transparent", ":hover": colors.sunk, ":focus": colors.sunk },
    boxShadow: { default: "none", ":focus": shadows.field },
    color: colors.text,
    fontFamily: fonts.mono,
    fontSize: 12,
    outline: "none",
  },
  span2: { gridColumn: "span 2" },
  swatch: {
    width: 12,
    height: 12,
    flexShrink: 0,
    padding: 0,
    borderWidth: 0,
    borderRadius: radii.xs,
    boxShadow: shadows.edge,
    cursor: "pointer",
  },
  swatchOpen: { outline: `1px solid ${colors.brand}`, outlineOffset: 1 },
  note: { margin: 0, paddingInline: space.ms, color: colors.faint, fontSize: 12 },
  failed: { margin: 0, paddingInline: space.ms, color: colors.danger, fontSize: 12 },
});
