"use client";

import * as stylex from "@stylexjs/stylex";
import { useState } from "react";
import type { TokenTable } from "@/design/replica";
import type { Node } from "@/design/schema";
import { isColor, resolveToken } from "@/lib/tokens";
import { colors, fonts, radii, shadows, size, space } from "@/styles/tokens.stylex";
import { Icon } from "./Icons";

/** A change to send: modes by name in order, and tokens by name (see `Api.setTokens`). */
export interface TokensChange {
  readonly modes?: ReadonlyArray<string>;
  readonly tokens?: Readonly<Record<string, Readonly<Record<string, string | null>> | null>>;
}

/** Each returns why it failed, or `undefined`. */
export interface TokensActions {
  readonly save: (change: TokensChange) => Promise<string | undefined>;
  readonly deleteMode: (modeId: string) => Promise<string | undefined>;
  readonly setArtboardMode: (boardId: string, modeId: string) => Promise<string | undefined>;
}

type Group = "Color" | "Type" | "Space" | "Radius" | "Shadow" | "Motion" | "Other" | "Primitives";
const GROUPS: ReadonlyArray<Group> = [
  "Color",
  "Type",
  "Space",
  "Radius",
  "Shadow",
  "Motion",
  "Other",
  "Primitives",
];

/**
 * Which list a token goes in, from its name and value. Tokens other
 * tokens point at are the palette the rest are built from, so they go
 * last, folded.
 */
function groupOf(name: string, value: string, used: ReadonlySet<string>): Group {
  if (used.has(name)) return "Primitives";
  if (isColor(value)) return "Color";
  if (/shadow/.test(name)) return "Shadow";
  if (/^--(t|font|text|type)-/.test(name) || /\d+px\s*\/\s*\d/.test(value)) return "Type";
  if (/^--(r|radius)-/.test(name)) return "Radius";
  if (/^-?[\d.]+m?s$|cubic-bezier|^ease/.test(value.trim())) return "Motion";
  if (/^-?[\d.]+(px|rem|em)$/.test(value.trim())) return "Space";
  return "Other";
}

/**
 * The design's tokens, in the left sidebar. A row per token shows its
 * value in the mode picked at the top; people and agents edit the same
 * tokens, and each value saves on Enter or when it loses focus, as one
 * edit. Below, the mode each artboard on the page renders in.
 */
export function TokensPanel({
  table,
  artboards,
  modeOf,
  actions,
}: {
  table: TokenTable;
  /** The artboards on the shown page. */
  artboards: ReadonlyArray<Node>;
  /** The id of the mode an artboard renders in. */
  modeOf: (board: Node) => string;
  actions: TokensActions;
}) {
  const [failed, setFailed] = useState<string>();
  const [adding, setAdding] = useState<{ name: string; value: string } | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [folded, setFolded] = useState<ReadonlySet<Group>>(() => new Set(["Primitives"]));
  const modes = table.modes;
  const first = modes[0]?.id ?? "";
  const mode = modes.find((m) => m.id === picked) ?? modes[0];
  const names = Object.keys(table.tokens).sort();

  const run = async (send: Promise<string | undefined>) => {
    const failure = await send;
    setFailed(failure);
    return failure === undefined;
  };
  const setValue = (name: string, modeId: string, value: string) => {
    const current = table.tokens[name]?.[modeId] ?? "";
    if (value.trim() === current) return;
    void run(actions.save({ tokens: { [name]: { [modeId]: value.trim() || null } } }));
  };
  const rename = (from: string, to: string) => {
    const name = to.trim().startsWith("--") ? to.trim() : `--${to.trim()}`;
    if (name === from || name === "--") return;
    const values = table.tokens[from] ?? {};
    void run(actions.save({ tokens: { [from]: null, [name]: values } }));
  };
  const renameMode = (id: string, name: string) => {
    if (name.trim() === "" || modes.find((m) => m.id === id)?.name === name.trim()) return;
    void run(actions.save({ modes: modes.map((m) => (m.id === id ? name.trim() : m.name)) }));
  };
  const addMode = () => {
    let n = modes.length + 1;
    while (modes.some((m) => m.name === `Mode ${n}`)) n += 1;
    void run(actions.save({ modes: [...modes.map((m) => m.name), `Mode ${n}`] }));
  };
  const addToken = async () => {
    if (!adding) return;
    const name = adding.name.trim().startsWith("--")
      ? adding.name.trim()
      : `--${adding.name.trim()}`;
    if (name === "--" || adding.value.trim() === "") return;
    // A token starts in the mode shown, which falls back to the first mode's value elsewhere.
    if (
      await run(actions.save({ tokens: { [name]: { [mode?.id ?? first]: adding.value.trim() } } }))
    )
      setAdding(null);
  };
  // Commits an input's text on Enter, the way it does when it loses focus.
  const onEnter = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") e.currentTarget.blur();
  };

  const used = new Set<string>();
  for (const values of Object.values(table.tokens)) {
    for (const value of Object.values(values)) {
      for (const [, ref] of value.matchAll(/var\(\s*(--[\w-]+)/g)) used.add(ref!);
    }
  }
  const grouped = new Map<Group, string[]>();
  for (const name of names) {
    const group = groupOf(name, resolveToken(table, name, mode?.id ?? first) ?? "", used);
    grouped.set(group, [...(grouped.get(group) ?? []), name]);
  }

  return (
    <section data-camera-ignore aria-label="Tokens" {...stylex.props(styles.panel)}>
      <div {...stylex.props(styles.head)}>
        <span {...stylex.props(styles.label)}>Mode</span>
        <div role="tablist" aria-label="Modes" {...stylex.props(styles.modes)}>
          {modes.map((m) =>
            renaming === m.id ? (
              <input
                key={m.id}
                aria-label={`Mode name, ${m.name}`}
                defaultValue={m.name}
                autoFocus
                onBlur={(e) => {
                  setRenaming(null);
                  renameMode(m.id, e.target.value);
                }}
                onKeyDown={onEnter}
                {...stylex.props(styles.input, styles.mode, styles.modeOn)}
              />
            ) : (
              <button
                key={m.id}
                type="button"
                role="tab"
                aria-selected={m.id === mode?.id}
                onClick={() => setPicked(m.id)}
                onDoubleClick={() => setRenaming(m.id)}
                title="Double-click to rename"
                {...stylex.props(styles.mode, m.id === mode?.id && styles.modeOn)}
              >
                {m.name}
              </button>
            ),
          )}
        </div>
        <button
          type="button"
          aria-label="Add a mode"
          title="Add a mode"
          onClick={addMode}
          {...stylex.props(styles.iconButton)}
        >
          <Icon name="plus" size={14} />
        </button>
        {mode && modes.length > 1 && (
          <button
            type="button"
            aria-label={`Delete mode ${mode.name}`}
            title="Delete this mode and its values"
            onClick={() => {
              setPicked(null);
              void run(actions.deleteMode(mode.id));
            }}
            {...stylex.props(styles.iconButton)}
          >
            <Icon name="minus" size={14} />
          </button>
        )}
      </div>

      {adding === null ? (
        <button
          type="button"
          onClick={() => setAdding({ name: "", value: "" })}
          {...stylex.props(styles.create)}
        >
          <Icon name="plus" size={14} />
          Create token
        </button>
      ) : (
        <form
          aria-label="Add a token"
          {...stylex.props(styles.add)}
          onSubmit={(e) => {
            e.preventDefault();
            void addToken();
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") setAdding(null);
          }}
        >
          <input
            aria-label="New token name"
            placeholder="--brand"
            value={adding.name}
            autoFocus
            spellCheck={false}
            onChange={(e) => setAdding({ ...adding, name: e.target.value })}
            {...stylex.props(styles.input, styles.field)}
          />
          <input
            aria-label="New token value"
            placeholder="#3478ba"
            value={adding.value}
            spellCheck={false}
            onChange={(e) => setAdding({ ...adding, value: e.target.value })}
            {...stylex.props(styles.input, styles.field)}
          />
          <button type="submit" {...stylex.props(styles.addButton)}>
            Add
          </button>
        </form>
      )}
      {failed && (
        <p role="alert" {...stylex.props(styles.failed)}>
          {failed}
        </p>
      )}

      <div {...stylex.props(styles.scroll)}>
        {names.length === 0 && (
          <p {...stylex.props(styles.muted)}>
            No tokens yet. Tokens are CSS variables every artboard can use as{" "}
            <code>var(--name)</code>.
          </p>
        )}
        {GROUPS.filter((g) => grouped.has(g)).map((group) => {
          const open = !folded.has(group);
          return (
            <div key={group} role="group" aria-label={group} {...stylex.props(styles.group)}>
              <button
                type="button"
                aria-expanded={open}
                onClick={() =>
                  setFolded((was) => {
                    const next = new Set(was);
                    if (!next.delete(group)) next.add(group);
                    return next;
                  })
                }
                {...stylex.props(styles.label, styles.toggle)}
              >
                <span {...stylex.props(styles.chevron, open && styles.chevronOpen)}>
                  <Icon name="next" size={10} />
                </span>
                {group}
              </button>
              {open &&
                grouped.get(group)!.map((name) => {
                  const modeId = mode?.id ?? first;
                  const own = table.tokens[name]?.[modeId];
                  const value = resolveToken(table, name, modeId);
                  return (
                    <div key={name} {...stylex.props(styles.row)}>
                      <span
                        aria-hidden
                        {...stylex.props(styles.swatch, !isColor(value) && styles.noSwatch)}
                        style={isColor(value) ? { background: value } : undefined}
                      />
                      <input
                        key={name}
                        aria-label="Token name"
                        defaultValue={name}
                        spellCheck={false}
                        onBlur={(e) => rename(name, e.target.value)}
                        onKeyDown={onEnter}
                        {...stylex.props(styles.input, styles.name)}
                      />
                      <input
                        key={`${modeId}:${own ?? ""}`}
                        aria-label={`${name} in ${mode?.name ?? ""}`}
                        defaultValue={own ?? ""}
                        placeholder={modeId === first ? "" : (table.tokens[name]?.[first] ?? "")}
                        title={value}
                        spellCheck={false}
                        onBlur={(e) => setValue(name, modeId, e.target.value)}
                        onKeyDown={onEnter}
                        {...stylex.props(styles.input, styles.value)}
                      />
                      <button
                        type="button"
                        aria-label={`Delete ${name}`}
                        title="Delete this token"
                        onClick={() => void run(actions.save({ tokens: { [name]: null } }))}
                        {...stylex.props(styles.iconButton, styles.delete)}
                      >
                        <Icon name="close" size={12} />
                      </button>
                    </div>
                  );
                })}
            </div>
          );
        })}

        {modes.length > 1 && artboards.length > 0 && (
          <div role="group" aria-label="Artboard modes" {...stylex.props(styles.group)}>
            <p {...stylex.props(styles.label)}>Artboards on this page</p>
            {artboards.map((board) => (
              <label key={board.id} {...stylex.props(styles.row)}>
                <span {...stylex.props(styles.boardName)}>{board.name ?? board.tag}</span>
                <select
                  value={modeOf(board)}
                  onChange={(e) => void run(actions.setArtboardMode(board.id, e.target.value))}
                  {...stylex.props(styles.select)}
                >
                  {modes.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

const styles = stylex.create({
  panel: {
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    minHeight: 0,
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: colors.borderSoft,
  },
  head: {
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    height: size.lg,
    flexShrink: 0,
    paddingInline: space.ms,
  },
  label: {
    display: "flex",
    alignItems: "center",
    gap: space.xs,
    height: size.xs,
    margin: 0,
    paddingInline: space.ms,
    color: colors.muted,
    fontSize: 12,
    fontWeight: 500,
  },
  toggle: {
    width: "100%",
    borderWidth: 0,
    backgroundColor: "transparent",
    color: { default: colors.muted, ":hover": colors.text },
    font: "inherit",
    fontSize: 12,
    fontWeight: 500,
    cursor: "var(--cursor-pointer, pointer)",
  },
  chevron: {
    display: "flex",
    color: colors.faint,
    transition: "transform 200ms cubic-bezier(.23, 1, .32, 1)",
  },
  chevronOpen: { transform: "rotate(90deg)" },
  modes: {
    display: "flex",
    flexGrow: 1,
    minWidth: 0,
    padding: space.px,
    borderRadius: radii.sm,
    backgroundColor: colors.sunk,
    overflowX: "auto",
  },
  mode: {
    flexGrow: 1,
    height: size.xs,
    paddingInline: space.sm,
    borderWidth: 0,
    borderRadius: radii.xs,
    backgroundColor: "transparent",
    color: { default: colors.muted, ":hover": colors.text },
    font: "inherit",
    fontSize: 12,
    fontWeight: 500,
    whiteSpace: "nowrap",
    cursor: "var(--cursor-pointer, pointer)",
  },
  modeOn: { backgroundColor: colors.surface, boxShadow: shadows.inset, color: colors.text },
  iconButton: {
    display: "grid",
    placeItems: "center",
    width: size.xs,
    height: size.xs,
    flexShrink: 0,
    padding: 0,
    borderWidth: 0,
    borderRadius: radii.xs,
    backgroundColor: { default: "transparent", ":hover": colors.sunk },
    color: { default: colors.muted, ":hover": colors.text },
    cursor: "var(--cursor-pointer, pointer)",
  },
  delete: { color: { default: colors.faint, ":hover": colors.danger } },
  create: {
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    flexShrink: 0,
    height: size.sm,
    marginInline: space.ms,
    marginBottom: space.sm,
    paddingInline: space.sm,
    borderWidth: 0,
    borderRadius: radii.sm,
    backgroundColor: { default: "transparent", ":hover": colors.bg },
    color: colors.text,
    font: "inherit",
    fontSize: 14,
    fontWeight: 500,
    cursor: "var(--cursor-pointer, pointer)",
  },
  add: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr auto",
    gap: space.xs,
    flexShrink: 0,
    marginInline: space.ms,
    marginBottom: space.sm,
  },
  field: {
    height: size.sm,
    paddingInline: space.sm,
    borderRadius: radii.sm,
    backgroundColor: colors.sunk,
  },
  addButton: {
    height: size.sm,
    paddingInline: space.ms,
    borderWidth: 0,
    borderRadius: radii.sm,
    backgroundColor: { default: colors.brand, ":hover": colors.brandText },
    color: colors.surface,
    font: "inherit",
    fontSize: 12,
    fontWeight: 500,
    cursor: "var(--cursor-pointer, pointer)",
  },
  failed: { margin: 0, paddingInline: space.ms, color: colors.danger, fontSize: 12 },
  muted: { margin: 0, paddingInline: space.ms, color: colors.muted, fontSize: 12 },
  scroll: { flexGrow: 1, minHeight: 0, overflowY: "auto", paddingBottom: space.sm },
  group: {
    display: "flex",
    flexDirection: "column",
    gap: space.px,
    paddingTop: space.sm,
  },
  row: {
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    height: size.sm,
    paddingInline: space.ms,
    paddingRight: space.xs,
    backgroundColor: { default: "transparent", ":hover": colors.bg },
  },
  swatch: {
    width: 16,
    height: 16,
    flexShrink: 0,
    borderRadius: radii.xs,
    boxShadow: `inset 0 0 0 1px ${colors.borderStrong}`,
  },
  noSwatch: { boxShadow: "none", backgroundColor: colors.sunk },
  input: {
    minWidth: 0,
    borderWidth: 0,
    backgroundColor: "transparent",
    color: colors.text,
    fontFamily: fonts.mono,
    fontSize: 12,
    outline: { default: "none", ":focus-visible": `1px solid ${colors.brand}` },
    "::placeholder": { color: colors.faint },
  },
  name: { flexGrow: 1, flexBasis: 0, height: size.xs },
  value: { flexGrow: 1, flexBasis: 0, height: size.xs, color: colors.muted },
  boardName: {
    flexGrow: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: 14,
  },
  select: {
    height: size.xs,
    borderWidth: 0,
    borderRadius: radii.xs,
    backgroundColor: colors.sunk,
    color: colors.text,
    font: "inherit",
    fontSize: 12,
  },
});
