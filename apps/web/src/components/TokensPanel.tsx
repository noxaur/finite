"use client";

import * as stylex from "@stylexjs/stylex";
import { useRef, useState } from "react";
import { setAlpha } from "@/design/editing/colors";
import type { TokenTable } from "@/design/replica";
import type { Node } from "@/design/schema";
import { aliasOf, bezierOf, displayName, hexOf, isColor, resolveToken } from "@/lib/tokens";
import { strip } from "@/styles/raised";
import { colors, fonts, motion, radii, shadows, size, space } from "@/styles/tokens.stylex";
import { Button, buttonStyle, IconButton, Strip, StripAction, StripItem } from "./Button";
import { type ColorPick, ColorPicker } from "./ColorPicker";
import { Icon } from "./Icons";
import { Dropdown } from "./Menu";

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

type Kind = "Color" | "Type" | "Space" | "Radius" | "Shadow" | "Motion" | "Other";
type Group = Kind | "Primitives";
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

/** What a token holds, from its name and value, which picks its preview. */
function kindOf(name: string, value: string): Kind {
  if (isColor(value)) return "Color";
  if (/shadow/.test(name)) return "Shadow";
  if (/^--(t|font|text|type)-/.test(name) || /\d+px\s*\/\s*\d/.test(value)) return "Type";
  if (/^--(r|radius)-/.test(name)) return "Radius";
  if (/^-?[\d.]+m?s$|cubic-bezier|^ease/.test(value.trim())) return "Motion";
  if (/^-?[\d.]+(px|rem|em)$/.test(value.trim())) return "Space";
  return "Other";
}

/**
 * Which list a token goes in. Tokens other tokens point at are the
 * palette the rest are built from, so they go last, folded.
 */
const groupOf = (name: string, kind: Kind, used: ReadonlySet<string>): Group =>
  used.has(name) ? "Primitives" : kind;

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
  const kinds = new Map<string, Kind>();
  const grouped = new Map<Group, string[]>();
  for (const name of names) {
    const kind = kindOf(name, resolveToken(table, name, mode?.id ?? first) ?? "");
    const group = groupOf(name, kind, used);
    kinds.set(name, kind);
    grouped.set(group, [...(grouped.get(group) ?? []), name]);
  }

  return (
    <section data-camera-ignore aria-label="Tokens" {...stylex.props(styles.panel)}>
      <div {...stylex.props(styles.head)}>
        <span {...stylex.props(styles.label, styles.headLabel)}>Mode</span>
        {modes.length === 1 ? (
          // One mode is nothing to choose between: its name, and + to add another.
          <>
            {renaming === modes[0]!.id ? (
              <input
                aria-label={`Mode name, ${modes[0]!.name}`}
                defaultValue={modes[0]!.name}
                autoFocus
                onBlur={(e) => {
                  setRenaming(null);
                  renameMode(modes[0]!.id, e.target.value);
                }}
                onKeyDown={onEnter}
                {...stylex.props(styles.input, styles.sans, styles.onlyMode)}
              />
            ) : (
              <span
                title="Double-click to rename"
                onDoubleClick={() => setRenaming(modes[0]!.id)}
                {...stylex.props(styles.onlyMode, styles.onlyModeName)}
              >
                {modes[0]!.name}
              </span>
            )}
            <IconButton variant="ghost" icon="plus" label="Add a mode" onClick={addMode} />
          </>
        ) : (
          <Strip
            role="tablist"
            aria-label="Modes"
            style={styles.modeStrip}
            actions={
              <>
                <StripAction icon="plus" label="Add a mode" onClick={addMode} />
                {mode && modes.length > 1 && (
                  <StripAction
                    icon="minus"
                    label={`Delete mode ${mode.name}`}
                    title="Delete this mode and its values"
                    onClick={() => {
                      setPicked(null);
                      void run(actions.deleteMode(mode.id));
                    }}
                  />
                )}
              </>
            }
          >
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
                  {...stylex.props(strip.item, styles.mode, styles.modeField)}
                />
              ) : (
                <StripItem
                  key={m.id}
                  picked={m.id === mode?.id}
                  onClick={() => setPicked(m.id)}
                  onDoubleClick={() => setRenaming(m.id)}
                  title="Double-click to rename"
                  style={styles.mode}
                >
                  {m.name}
                </StripItem>
              ),
            )}
          </Strip>
        )}
      </div>

      {adding === null ? (
        <Button
          icon="plus"
          onClick={() => setAdding({ name: "", value: "" })}
          style={styles.create}
        >
          Create token
        </Button>
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
            placeholder="brand"
            value={adding.name}
            autoFocus
            spellCheck={false}
            onChange={(e) => setAdding({ ...adding, name: e.target.value })}
            {...stylex.props(styles.input, styles.field, styles.sans)}
          />
          <input
            aria-label="New token value"
            placeholder="#95ced7"
            value={adding.value}
            spellCheck={false}
            onChange={(e) => setAdding({ ...adding, value: e.target.value })}
            {...stylex.props(styles.input, styles.field)}
          />
          <Button type="submit" variant="brand">
            Add
          </Button>
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
            No tokens yet. Tokens are the colors, type and spacing every artboard shares, with a
            value for each mode, like Light and Dark.
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
                <span {...stylex.props(styles.count)}>{grouped.get(group)!.length}</span>
              </button>
              {open &&
                grouped.get(group)!.map((name) => {
                  const modeId = mode?.id ?? first;
                  const own = table.tokens[name]?.[modeId];
                  const fallback = modeId === first ? undefined : table.tokens[name]?.[first];
                  const value = resolveToken(table, name, modeId);
                  const kind = kinds.get(name) ?? "Other";
                  const alias = aliasOf(own);
                  return (
                    <div key={name} {...stylex.props(styles.row)}>
                      {kind === "Color" ? (
                        <ColorSwatch
                          name={name}
                          color={value ?? ""}
                          onPick={(color) => setValue(name, modeId, color)}
                        />
                      ) : (
                        <Preview kind={kind} value={value ?? ""} />
                      )}
                      <input
                        key={name}
                        aria-label="Token name"
                        defaultValue={displayName(name)}
                        title={name}
                        spellCheck={false}
                        onBlur={(e) => rename(name, e.target.value)}
                        onKeyDown={onEnter}
                        {...stylex.props(styles.input, styles.sans, styles.name)}
                      />
                      {alias ? (
                        <AliasPill
                          label={`${name} in ${mode?.name ?? ""}`}
                          alias={alias}
                          color={isColor(value) ? value : undefined}
                          choices={names.filter((n) => n !== name && kinds.get(n) === kind)}
                          onPick={(to) => setValue(name, modeId, `var(${to})`)}
                          onDetach={() => setValue(name, modeId, value ?? "")}
                        />
                      ) : (
                        <input
                          key={`${modeId}:${own ?? ""}`}
                          aria-label={`${name} in ${mode?.name ?? ""}`}
                          defaultValue={own ?? ""}
                          placeholder={
                            aliasOf(fallback) ? displayName(aliasOf(fallback)!) : (fallback ?? "")
                          }
                          title={value}
                          spellCheck={false}
                          onBlur={(e) => setValue(name, modeId, e.target.value)}
                          onKeyDown={onEnter}
                          {...stylex.props(styles.input, styles.value)}
                        />
                      )}
                      <IconButton
                        size="small"
                        variant="ghost"
                        icon="close"
                        label={`Delete ${name}`}
                        title="Delete this token"
                        onClick={() => void run(actions.save({ tokens: { [name]: null } }))}
                        style={styles.delete}
                      />
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
              <div key={board.id} {...stylex.props(styles.row)}>
                <span {...stylex.props(styles.boardName)}>{board.name ?? board.tag}</span>
                <Dropdown
                  label={`Mode for ${board.name ?? board.tag}`}
                  value={modeOf(board)}
                  options={modes.map((m) => [m.id, m.name] as const)}
                  onPick={(id) => void run(actions.setArtboardMode(board.id, id))}
                  style={[...buttonStyle({ size: "small" }), styles.select]}
                >
                  <span {...stylex.props(styles.selectText)}>
                    {modes.find((m) => m.id === modeOf(board))?.name}
                  </span>
                  <Icon name="chevronDown" size={12} />
                </Dropdown>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

/** A color token's swatch. Clicking it opens the color picker, which saves when it closes. */
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
  // The last gesture kept, which Escape goes back to.
  const kept = useRef<string | null>(null);
  const parsed = typeof document === "undefined" ? undefined : hexOf(picked ?? color);
  const hex = parsed?.hex ?? "#000000";
  const alpha = Math.round((parsed?.alpha ?? 1) * 100);
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
        title="Pick a color"
        aria-label={`Pick a color for ${name}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
        {...stylex.props(styles.swatch, styles.pickable, open && styles.swatchOpen)}
        style={{ background: picked ?? color }}
      />
      {open && button && (
        <ColorPicker
          anchor={button}
          title={`Color for ${name}`}
          color={hex}
          alpha={alpha}
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

/** A small picture of a token's value: a glyph in its font, a corner, a shadow, a bar, a curve. */
function Preview({ kind, value }: { kind: Kind; value: string }) {
  const v = value.trim();
  if (kind === "Type") {
    const style: React.CSSProperties = /^\d{3}$/.test(v)
      ? { fontWeight: v }
      : /^[\d.]+(px|rem|em)$/.test(v)
        ? { fontSize: `clamp(8px, ${v}, 15px)` }
        : /\d(px|rem|em)/.test(v)
          ? { font: v, fontSize: 13, lineHeight: "16px" }
          : { fontFamily: v };
    return (
      <span aria-hidden {...stylex.props(styles.swatch, styles.glyph)} style={style}>
        Aa
      </span>
    );
  }
  if (kind === "Radius")
    return (
      <span aria-hidden {...stylex.props(styles.swatch, styles.frame)}>
        <span {...stylex.props(styles.corner)} style={{ borderTopLeftRadius: `min(${v}, 14px)` }} />
      </span>
    );
  if (kind === "Shadow")
    return (
      <span aria-hidden {...stylex.props(styles.swatch, styles.frame)}>
        <span {...stylex.props(styles.card)} style={{ boxShadow: v }} />
      </span>
    );
  if (kind === "Space")
    return (
      <span aria-hidden {...stylex.props(styles.swatch, styles.frame)}>
        <span {...stylex.props(styles.bar)} style={{ width: `max(2px, min(${v}, 16px))` }} />
      </span>
    );
  if (kind === "Motion") {
    const [x1, y1, x2, y2] = bezierOf(v) ?? bezierOf("ease")!;
    // Drawn in a 16 box with y up, from (2, 14) to (14, 2).
    const at = (x: number, y: number) => `${2 + x * 12} ${14 - y * 12}`;
    return (
      <span aria-hidden {...stylex.props(styles.swatch, styles.frame)}>
        <svg width={16} height={16} viewBox="0 0 16 16" fill="none">
          <path
            d={`M${at(0, 0)} C${at(x1, y1)} ${at(x2, y2)} ${at(1, 1)}`}
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinecap="round"
          />
        </svg>
      </span>
    );
  }
  return <span aria-hidden {...stylex.props(styles.swatch, styles.noSwatch)} />;
}

/**
 * A value that points at another token, shown as that token's name. The pill
 * is a select over it, listing tokens of the same kind and a way to detach
 * into the plain value.
 */
function AliasPill({
  label,
  alias,
  color,
  choices,
  onPick,
  onDetach,
}: {
  label: string;
  alias: string;
  color: string | undefined;
  choices: ReadonlyArray<string>;
  onPick: (name: string) => void;
  onDetach: () => void;
}) {
  const options = choices.includes(alias) ? choices : [alias, ...choices];
  return (
    <span title={`Points at ${alias}`} {...stylex.props(styles.pill)}>
      {color && <span aria-hidden {...stylex.props(styles.dot)} style={{ background: color }} />}
      <span {...stylex.props(styles.pillName)}>{displayName(alias)}</span>
      <select
        aria-label={label}
        value={alias}
        onChange={(e) => (e.target.value === "" ? onDetach() : onPick(e.target.value))}
        {...stylex.props(styles.pillSelect)}
      >
        {options.map((n) => (
          <option key={n} value={n}>
            {displayName(n)}
          </option>
        ))}
        <option value="">Detach (use the value)</option>
      </select>
    </span>
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
  /** The Mode row: a regular strip with 6px above and below, like the title bar's buttons. */
  head: {
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    flexShrink: 0,
    paddingBlock: space.sm,
    paddingInline: space.ms,
  },
  /** The row is already inset, so its label lines up with the rows' labels without its own. */
  headLabel: { paddingInline: 0 },
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
    transition: `transform ${motion.base} ${motion.out}`,
  },
  chevronOpen: { transform: "rotate(90deg)" },
  /** Mode: the mode tabs, then + and −, all in one strip; the open mode is pressed in. */
  modeStrip: { flexGrow: 1, flexShrink: 1, minWidth: 0 },
  /** The only mode's name, or the field that renames it: as tall as the strip it stands in for. */
  onlyMode: { flexGrow: 1, minWidth: 0, height: size.sm },
  onlyModeName: {
    display: "flex",
    alignItems: "center",
    paddingInline: space.xs,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    color: colors.text,
    fontFamily: fonts.sans,
    fontSize: 12,
    fontWeight: 500,
    lineHeight: "15px",
  },
  mode: { flexShrink: 0, flexBasis: "auto", minWidth: 60, maxWidth: 120 },
  modeField: {
    cursor: "text",
    backgroundColor: colors.surface,
    boxShadow: shadows.field,
    color: colors.text,
  },
  /** A row's delete button: a ghost, fainter than the row until it's under the pointer. */
  delete: { color: { default: colors.faint, ":hover": colors.danger } },
  create: { alignSelf: "flex-start", marginInline: space.ms, marginBottom: space.sm },

  add: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr auto",
    gap: space.xs,
    flexShrink: 0,
    marginInline: space.ms,
    marginBottom: space.sm,
  },
  /** A sunk field. */
  field: {
    height: size.sm,
    paddingInline: space.sm,
    borderRadius: radii.sm,
    backgroundColor: colors.sunk,
    boxShadow: shadows.field,
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
    // Inset and rounded, as the rows in Layers and Pages; the content stays 9px in.
    marginInline: space.sm,
    paddingLeft: space.xs,
    paddingRight: 0,
    borderRadius: radii.sm,
    backgroundColor: { default: "transparent", ":hover": colors.hoverFill },
  },
  swatch: {
    width: 12,
    height: 12,
    flexShrink: 0,
    borderRadius: radii.xs,
    boxShadow: shadows.edge,
  },
  noSwatch: { boxShadow: "none", backgroundColor: colors.sunk },
  pickable: { padding: 0, borderWidth: 0, cursor: "var(--cursor-pointer, pointer)" },
  /** The swatch whose picker is open. */
  swatchOpen: { outline: `1px solid ${colors.brand}`, outlineOffset: 1 },
  frame: {
    display: "grid",
    placeItems: "center",
    overflow: "hidden",
    boxShadow: "none",
    backgroundColor: colors.sunk,
    color: colors.muted,
  },
  glyph: {
    display: "grid",
    placeItems: "center",
    overflow: "hidden",
    boxShadow: "none",
    color: colors.text,
    fontSize: 13,
    lineHeight: "16px",
  },
  corner: {
    width: 12,
    height: 12,
    marginTop: 3,
    marginLeft: 3,
    borderTopWidth: 1.5,
    borderLeftWidth: 1.5,
    borderTopStyle: "solid",
    borderLeftStyle: "solid",
    borderColor: colors.muted,
  },
  card: { width: 9, height: 9, borderRadius: 1, backgroundColor: colors.surface },
  bar: { height: 3, borderRadius: 1, backgroundColor: colors.muted },
  count: { color: colors.faint, fontWeight: 400 },
  pill: {
    position: "relative",
    display: "flex",
    alignItems: "center",
    gap: space.xs,
    flexGrow: 1,
    flexBasis: 0,
    minWidth: 0,
    height: size.xs,
    paddingInline: space.sm,
    borderRadius: radii.sm,
    backgroundColor: colors.sunk,
    backgroundImage: {
      default: "none",
      ":hover": `linear-gradient(${colors.hoverFill}, ${colors.hoverFill})`,
    },
    color: colors.text,
    fontSize: 12,
    outline: { default: "none", ":focus-within": `1px solid ${colors.brand}` },
  },

  dot: {
    width: 9,
    height: 9,
    flexShrink: 0,
    borderRadius: radii.xs,
    boxShadow: shadows.edge,
  },

  pillName: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  pillSelect: {
    position: "absolute",
    inset: 0,
    width: "100%",
    opacity: 0,
    font: "inherit",
    cursor: "var(--cursor-pointer, pointer)",
  },
  /** Plain text in a row; it sinks into a field, ringed in the brand, while it's typed in. */
  input: {
    minWidth: 0,
    paddingInline: space.xs,
    borderWidth: 0,
    borderRadius: radii.sm,
    backgroundColor: { default: "transparent", ":focus": colors.sunk },
    boxShadow: { default: "none", ":focus": shadows.field },
    color: colors.text,
    fontFamily: fonts.mono,
    fontSize: 12,
    outline: { default: "none", ":focus": `1px solid ${colors.brand}` },
    "::placeholder": { color: colors.faint },
  },

  sans: { fontFamily: fonts.sans },
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
  /** An artboard's mode picker: a small button, its chevron close to its label. */
  select: { gap: space.xs },

  selectText: { color: colors.text },
});
