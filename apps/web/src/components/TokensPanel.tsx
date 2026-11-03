"use client";

import * as stylex from "@stylexjs/stylex";
import { useState } from "react";
import type { TokenTable } from "@/design/replica";
import type { Node } from "@/design/schema";
import { colors, radii, space } from "@/styles/tokens.stylex";

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

/** A token's value in `mode`, following whole-value `var(--x)` aliases, as the browser would. */
function resolve(table: TokenTable, name: string, mode: string, depth = 0): string | undefined {
  const values = table.tokens[name];
  if (!values || depth > 8) return undefined;
  const value = values[mode] ?? values[table.modes[0]?.id ?? ""] ?? Object.values(values)[0];
  const alias = value?.match(/^\s*var\(\s*(--[\w-]+)\s*\)\s*$/);
  return alias ? resolve(table, alias[1]!, mode, depth + 1) : value;
}

const isColor = (value: string | undefined) =>
  value !== undefined && typeof CSS !== "undefined" && CSS.supports("color", value);

/**
 * The design's tokens, as a table like Figma's variables: a row per token,
 * a column per mode. People and agents edit the same tokens; each cell
 * saves on Enter or when it loses focus, as one edit. Below it, the mode
 * each artboard on the page renders in.
 */
export function TokensPanel({
  table,
  artboards,
  modeOf,
  actions,
  onClose,
}: {
  table: TokenTable;
  /** The artboards on the shown page. */
  artboards: ReadonlyArray<Node>;
  /** The id of the mode an artboard renders in. */
  modeOf: (board: Node) => string;
  actions: TokensActions;
  onClose: () => void;
}) {
  const [failed, setFailed] = useState<string>();
  const [adding, setAdding] = useState({ name: "", value: "" });
  const modes = table.modes;
  const first = modes[0]?.id ?? "";
  const names = Object.keys(table.tokens);

  const run = async (send: Promise<string | undefined>) => {
    const failure = await send;
    setFailed(failure);
    return failure === undefined;
  };
  const setValue = (name: string, mode: string, value: string) => {
    const current = table.tokens[name]?.[mode] ?? "";
    if (value.trim() === current) return;
    void run(actions.save({ tokens: { [name]: { [mode]: value.trim() || null } } }));
  };
  const rename = (from: string, to: string) => {
    const name = to.trim();
    if (name === from || name === "") return;
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
    const name = adding.name.trim().startsWith("--")
      ? adding.name.trim()
      : `--${adding.name.trim()}`;
    if (name === "--" || adding.value.trim() === "") return;
    if (await run(actions.save({ tokens: { [name]: { [first]: adding.value.trim() } } })))
      setAdding({ name: "", value: "" });
  };
  // Commits an input's text on Enter, the way it does when it loses focus.
  const onEnter = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") e.currentTarget.blur();
  };

  return (
    <section
      data-camera-ignore
      aria-label="Tokens"
      {...stylex.props(styles.panel)}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onClose();
        }
      }}
    >
      <div {...stylex.props(styles.head)}>
        <p {...stylex.props(styles.title)}>Tokens</p>
        <button type="button" onClick={onClose} {...stylex.props(styles.button)}>
          Close
        </button>
      </div>
      <p {...stylex.props(styles.muted)}>
        CSS variables every artboard can use as <code>var(--name)</code>. A mode left empty uses the
        first mode’s value.
      </p>
      <div {...stylex.props(styles.scroll)}>
        <table {...stylex.props(styles.table)}>
          <thead>
            <tr>
              <th {...stylex.props(styles.th)}>Name</th>
              {modes.map((mode) => (
                <th key={mode.id} {...stylex.props(styles.th)}>
                  <span {...stylex.props(styles.modeHead)}>
                    <input
                      key={mode.name}
                      aria-label={`Mode name, ${mode.name}`}
                      defaultValue={mode.name}
                      onBlur={(e) => renameMode(mode.id, e.target.value)}
                      onKeyDown={onEnter}
                      {...stylex.props(styles.input, styles.modeName)}
                    />
                    {modes.length > 1 && (
                      <button
                        type="button"
                        aria-label={`Delete mode ${mode.name}`}
                        title="Delete this mode and its values"
                        onClick={() => void run(actions.deleteMode(mode.id))}
                        {...stylex.props(styles.icon)}
                      >
                        ×
                      </button>
                    )}
                  </span>
                </th>
              ))}
              <th {...stylex.props(styles.th)}>
                <button type="button" onClick={addMode} {...stylex.props(styles.button)}>
                  + Mode
                </button>
              </th>
            </tr>
          </thead>
          <tbody>
            {names.map((name) => (
              <tr key={name}>
                <td {...stylex.props(styles.td)}>
                  <input
                    key={name}
                    aria-label="Token name"
                    defaultValue={name}
                    spellCheck={false}
                    onBlur={(e) => rename(name, e.target.value)}
                    onKeyDown={onEnter}
                    {...stylex.props(styles.input, styles.code)}
                  />
                </td>
                {modes.map((mode) => {
                  const own = table.tokens[name]?.[mode.id];
                  const shown = resolve(table, name, mode.id);
                  return (
                    <td key={mode.id} {...stylex.props(styles.td)}>
                      <span {...stylex.props(styles.cell)}>
                        {isColor(shown) && (
                          <span
                            aria-hidden
                            {...stylex.props(styles.swatch)}
                            style={{ background: shown }}
                          />
                        )}
                        <input
                          key={own ?? ""}
                          aria-label={`${name} in ${mode.name}`}
                          defaultValue={own ?? ""}
                          placeholder={mode.id === first ? "" : (table.tokens[name]?.[first] ?? "")}
                          spellCheck={false}
                          onBlur={(e) => setValue(name, mode.id, e.target.value)}
                          onKeyDown={onEnter}
                          {...stylex.props(styles.input, styles.code)}
                        />
                      </span>
                    </td>
                  );
                })}
                <td {...stylex.props(styles.td)}>
                  <button
                    type="button"
                    aria-label={`Delete ${name}`}
                    title="Delete this token"
                    onClick={() => void run(actions.save({ tokens: { [name]: null } }))}
                    {...stylex.props(styles.icon)}
                  >
                    ×
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {names.length === 0 && <p {...stylex.props(styles.muted)}>No tokens yet.</p>}
      </div>
      <form
        aria-label="Add a token"
        {...stylex.props(styles.add)}
        onSubmit={(e) => {
          e.preventDefault();
          void addToken();
        }}
      >
        <input
          aria-label="New token name"
          placeholder="--brand"
          value={adding.name}
          spellCheck={false}
          onChange={(e) => setAdding({ ...adding, name: e.target.value })}
          {...stylex.props(styles.input, styles.code)}
        />
        <input
          aria-label="New token value"
          placeholder="#c2410c"
          value={adding.value}
          spellCheck={false}
          onChange={(e) => setAdding({ ...adding, value: e.target.value })}
          {...stylex.props(styles.input, styles.code)}
        />
        <button type="submit" {...stylex.props(styles.button, styles.primary)}>
          Add
        </button>
      </form>
      {failed && (
        <p role="alert" {...stylex.props(styles.failed)}>
          {failed}
        </p>
      )}
      {modes.length > 1 && artboards.length > 0 && (
        <div {...stylex.props(styles.boards)}>
          <p {...stylex.props(styles.title)}>Artboards on this page</p>
          {artboards.map((board) => (
            <label key={board.id} {...stylex.props(styles.board)}>
              <span {...stylex.props(styles.boardName)}>{board.name ?? board.tag}</span>
              <select
                value={modeOf(board)}
                onChange={(e) => void run(actions.setArtboardMode(board.id, e.target.value))}
                {...stylex.props(styles.input, styles.select)}
              >
                {modes.map((mode) => (
                  <option key={mode.id} value={mode.id}>
                    {mode.name}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
      )}
    </section>
  );
}

const styles = stylex.create({
  panel: {
    position: "absolute",
    top: 52,
    right: space.sm,
    bottom: 52,
    width: 520,
    maxWidth: `calc(100% - 2 * ${space.sm})`,
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
  head: { display: "flex", alignItems: "center", justifyContent: "space-between" },
  title: { margin: 0, fontWeight: 500 },
  muted: { margin: 0, color: colors.muted },
  scroll: { flexGrow: 1, minHeight: 0, overflow: "auto" },
  table: { borderCollapse: "collapse", width: "100%" },
  th: {
    position: "sticky",
    top: 0,
    padding: space.xs,
    textAlign: "left",
    fontWeight: 500,
    color: colors.muted,
    backgroundColor: colors.surface,
    whiteSpace: "nowrap",
  },
  td: {
    padding: space.xs,
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: colors.border,
  },
  modeHead: { display: "flex", alignItems: "center", gap: space.xs },
  modeName: { width: 96, fontWeight: 500 },
  cell: { display: "flex", alignItems: "center", gap: space.xs },
  swatch: {
    flexShrink: 0,
    width: 14,
    height: 14,
    borderRadius: 3,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
  },
  input: {
    minWidth: 0,
    width: "100%",
    height: 26,
    paddingInline: space.xs,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: { default: "transparent", ":hover": colors.border, ":focus": colors.accent },
    borderRadius: radii.sm,
    backgroundColor: { default: "transparent", ":focus": colors.bg },
    color: "inherit",
    font: "inherit",
    outline: "none",
  },
  code: { fontFamily: "ui-monospace, monospace", fontSize: 12 },
  select: { width: "auto", borderColor: colors.border },
  icon: {
    flexShrink: 0,
    width: 22,
    height: 22,
    padding: 0,
    borderWidth: 0,
    borderRadius: radii.sm,
    backgroundColor: { default: "transparent", ":hover": colors.bg },
    color: colors.muted,
    font: "inherit",
    cursor: "var(--cursor-pointer, pointer)",
  },
  add: { display: "flex", gap: space.xs },
  failed: { margin: 0, color: colors.danger },
  boards: {
    display: "flex",
    flexDirection: "column",
    gap: space.xs,
    maxHeight: 180,
    overflow: "auto",
    paddingTop: space.sm,
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: colors.border,
  },
  board: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: space.sm },
  boardName: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  button: {
    height: 26,
    paddingInline: space.sm,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    borderRadius: radii.sm,
    backgroundColor: { default: "transparent", ":hover": colors.bg },
    color: "inherit",
    font: "inherit",
    whiteSpace: "nowrap",
    cursor: "var(--cursor-pointer, pointer)",
  },
  primary: {
    borderColor: colors.accent,
    backgroundColor: colors.accent,
    color: colors.onAccent,
  },
});
