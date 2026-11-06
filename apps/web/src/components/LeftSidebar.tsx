"use client";

import * as stylex from "@stylexjs/stylex";
import { type ReactNode, useRef, useState } from "react";
import type { Listener, Presence } from "@/design/schema";
import { colors, fonts, radii, shadows, size, space } from "@/styles/tokens.stylex";
import { Icon } from "./Icons";
import { NameInput } from "./NameInput";

export type LeftMode = "design" | "tokens";

interface PageRow {
  readonly id: string;
  readonly name: string;
  readonly artboardCount: number;
}

/**
 * The left side of the canvas: the design's name, then either its pages
 * and layers or its tokens, and the agents working on it. The canvas
 * shows one page at a time, so picking one swaps which artboards are
 * drawn. People and agents add, rename and delete pages; artboards dragged
 * from Layers onto a page move there.
 */
export function LeftSidebar({
  name,
  onRename,
  mode,
  onMode,
  pages,
  page,
  onPage,
  pageActions,
  layers,
  tokens,
  presence,
  listening,
}: {
  name: string | null;
  onRename: (name: string) => void;
  mode: LeftMode;
  onMode: (mode: LeftMode) => void;
  pages: ReadonlyArray<PageRow>;
  page: string | null;
  onPage: (id: string) => void;
  pageActions: {
    add(): void;
    rename(id: string, name: string): void;
    remove(id: string): void;
  };
  /** The layers of the shown page, matching the search typed. A drag over a page calls `onDropPage`. */
  layers: (query: string, onDropPage: (page: string | null) => void) => ReactNode;
  tokens: ReactNode;
  presence: ReadonlyArray<Presence>;
  listening: ReadonlyArray<Listener>;
}) {
  const [query, setQuery] = useState<string | null>(null);
  const [pagesOpen, setPagesOpen] = useState(true);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [dropPage, setDropPage] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  return (
    <aside data-camera-ignore aria-label="Design" {...stylex.props(styles.panel)}>
      <header {...stylex.props(styles.head)}>
        <NameInput
          key={name ?? ""}
          label="Design name"
          value={name ?? ""}
          placeholder="…"
          onRename={onRename}
          style={styles.name}
        />
        <button
          type="button"
          aria-label="Search layers"
          aria-expanded={query !== null}
          title="Search layers"
          onClick={() => {
            onMode("design");
            if (query === null) {
              setQuery("");
              requestAnimationFrame(() => searchRef.current?.focus());
            } else setQuery(null);
          }}
          {...stylex.props(styles.iconButton, query !== null && styles.iconButtonOn)}
        >
          <Icon name="search" size={16} />
        </button>
      </header>

      <div role="tablist" aria-label="Sidebar" {...stylex.props(styles.switch)}>
        {(["design", "tokens"] as const).map((m) => (
          <button
            key={m}
            type="button"
            role="tab"
            aria-selected={mode === m}
            onClick={() => onMode(m)}
            {...stylex.props(styles.seg, mode === m && styles.segOn)}
          >
            {m === "design" ? "Design" : "Tokens"}
          </button>
        ))}
      </div>

      {mode === "tokens" ? (
        tokens
      ) : (
        <>
          {query === null && pages.length > 0 && (
            <section aria-label="Pages" {...stylex.props(styles.section)}>
              <div {...stylex.props(stylex.defaultMarker(), styles.labelRow)}>
                <button
                  type="button"
                  aria-expanded={pagesOpen}
                  onClick={() => setPagesOpen(!pagesOpen)}
                  {...stylex.props(styles.label, styles.toggle)}
                >
                  <span {...stylex.props(styles.chevron, pagesOpen && styles.chevronOpen)}>
                    <Icon name="next" size={16} />
                  </span>
                  Pages
                </button>
                <button
                  type="button"
                  aria-label="Add page"
                  title="Add page"
                  onClick={() => {
                    setPagesOpen(true);
                    pageActions.add();
                  }}
                  {...stylex.props(styles.iconButton, styles.small, styles.onHover)}
                >
                  <Icon name="plus" size={14} />
                </button>
              </div>
              {pagesOpen && (
                <ol {...stylex.props(styles.pages)}>
                  {pages.map((p) => (
                    <li
                      key={p.id}
                      data-page-id={p.id}
                      {...stylex.props(stylex.defaultMarker(), styles.pageItem)}
                    >
                      {renaming === p.id ? (
                        <NameInput
                          label="Page name"
                          value={p.name}
                          autoFocus
                          onRename={(next) => pageActions.rename(p.id, next)}
                          onDone={() => setRenaming(null)}
                          style={styles.pageInput}
                        />
                      ) : (
                        <button
                          type="button"
                          aria-current={p.id === page ? "page" : undefined}
                          onClick={() => onPage(p.id)}
                          onDoubleClick={() => setRenaming(p.id)}
                          title={`${p.name}, ${p.artboardCount} ${p.artboardCount === 1 ? "artboard" : "artboards"} (double-click to rename)`}
                          {...stylex.props(
                            styles.row,
                            p.id === page && styles.rowOn,
                            dropPage === p.id && styles.rowDrop,
                          )}
                        >
                          <span {...stylex.props(styles.rowIcon)}>
                            <Icon name="page" size={16} />
                          </span>
                          <span {...stylex.props(styles.rowName)}>{p.name}</span>
                        </button>
                      )}
                      {pages.length > 1 && p.id === page && renaming !== p.id && (
                        <button
                          type="button"
                          aria-label={`Delete ${p.name}`}
                          title="Delete page and its artboards (⌘Z brings it back)"
                          onClick={() => pageActions.remove(p.id)}
                          {...stylex.props(
                            styles.iconButton,
                            styles.small,
                            styles.pageDelete,
                            styles.onHover,
                          )}
                        >
                          <Icon name="close" size={12} />
                        </button>
                      )}
                    </li>
                  ))}
                </ol>
              )}
            </section>
          )}
          <section
            aria-label="Layers"
            {...stylex.props(
              styles.section,
              styles.grow,
              query === null && pages.length > 0 && styles.rule,
            )}
          >
            {query === null ? (
              <p {...stylex.props(styles.label)}>Layers</p>
            ) : (
              <input
                ref={searchRef}
                type="search"
                aria-label="Find a layer"
                placeholder="Find a layer"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setQuery(null);
                }}
                {...stylex.props(styles.search)}
              />
            )}
            {layers(query ?? "", setDropPage)}
          </section>
        </>
      )}

      <AgentsFooter presence={presence} listening={listening} />
    </aside>
  );
}

/** Who's connected: each agent and what it says it's doing. Folded, it counts them. */
function AgentsFooter({
  presence,
  listening,
}: {
  presence: ReadonlyArray<Presence>;
  listening: ReadonlyArray<Listener>;
}) {
  const [open, setOpen] = useState(false);
  const agents = [
    ...presence.map((p) => ({ id: p.actor, name: p.name, status: p.status })),
    ...listening
      .filter((l) => !presence.some((p) => p.actor === l.actor))
      .map((l) => ({ id: l.actor, name: l.name, status: "Listening for comments" })),
  ];
  const working = presence.filter((p) => p.status).length;
  return (
    <footer aria-label="Agents" {...stylex.props(styles.footer)}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        {...stylex.props(styles.footerButton)}
      >
        <span {...stylex.props(styles.chevron, styles.footerChevron, open && styles.chevronOpen)}>
          <Icon name="next" size={16} />
        </span>
        <span {...stylex.props(styles.rowName)}>Agents</span>
        {!open && working > 0 && <span {...stylex.props(styles.working)}>{working} working</span>}
        <span {...stylex.props(styles.count)}>{agents.length}</span>
      </button>
      {open && (
        <ul {...stylex.props(styles.agents)}>
          {agents.length === 0 && <li {...stylex.props(styles.idle)}>No agents connected.</li>}
          {agents.map((a) => (
            <li key={a.id} {...stylex.props(styles.agent)}>
              <span {...stylex.props(styles.chip, a.status !== null && styles.chipOn)}>
                {a.name}
              </span>
              <span
                {...stylex.props(styles.status, a.status === null && styles.statusIdle)}
                title={a.status ?? undefined}
              >
                {a.status ?? "Idle"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </footer>
  );
}

const styles = stylex.create({
  panel: {
    gridArea: "left",
    display: "flex",
    flexDirection: "column",
    minHeight: 0,
    backgroundColor: colors.surface,
    borderRightWidth: 1,
    borderRightStyle: "solid",
    borderRightColor: colors.border,
  },
  head: {
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    height: size.lg,
    flexShrink: 0,
    paddingInline: space.ms,
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderBottomColor: colors.border,
  },
  name: {
    flexGrow: 1,
    minWidth: 0,
    height: size.xs,
    marginLeft: `calc(-1 * ${space.xs})`,
    paddingInline: space.xs,
    borderWidth: 0,
    borderRadius: radii.xs,
    backgroundColor: { default: "transparent", ":hover": colors.bg, ":focus": colors.bg },
    color: colors.text,
    font: "inherit",
    fontSize: 14,
    fontWeight: 500,
    textOverflow: "ellipsis",
    outline: { default: "none", ":focus-visible": `2px solid ${colors.brand}` },
  },
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
  iconButtonOn: { backgroundColor: colors.sunk, boxShadow: shadows.inset, color: colors.text },
  switch: {
    display: "flex",
    flexShrink: 0,
    marginInline: space.ms,
    marginTop: space.ms,
    marginBottom: space.xs,
    padding: space.px,
    borderRadius: radii.sm,
    backgroundColor: colors.sunk,
  },
  seg: {
    flexGrow: 1,
    flexBasis: 0,
    height: size.sm,
    padding: 0,
    borderWidth: 0,
    borderRadius: radii.xs,
    backgroundColor: "transparent",
    color: { default: colors.muted, ":hover": colors.text },
    font: "inherit",
    fontSize: 14,
    fontWeight: 500,
    cursor: "var(--cursor-pointer, pointer)",
  },
  segOn: { backgroundColor: colors.surface, boxShadow: shadows.inset, color: colors.text },
  section: {
    display: "flex",
    flexDirection: "column",
    gap: space.px,
    flexShrink: 0,
    paddingBlock: space.ms,
  },
  rule: {
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: colors.borderSoft,
  },
  grow: { flexGrow: 1, flexShrink: 1, minHeight: 0 },
  labelRow: {
    display: "flex",
    alignItems: "center",
    paddingRight: space.sm,
  },
  /** Shown while the pointer is over its row, or the control has focus. */
  onHover: {
    opacity: {
      default: 0,
      [stylex.when.ancestor(":hover")]: 1,
      ":focus-visible": 1,
    },
  },
  small: { width: 21, height: 21 },
  pageItem: {
    position: "relative",
    display: "flex",
    alignItems: "center",
  },
  pageDelete: {
    position: "absolute",
    right: space.sm,
    backgroundColor: { default: colors.sunk, ":hover": colors.bg },
  },
  pageInput: {
    flexGrow: 1,
    height: size.sm,
    marginInline: space.sm,
    paddingInline: space.xs,
    borderWidth: 0,
    borderRadius: radii.xs,
    backgroundColor: colors.surface,
    color: colors.text,
    font: "inherit",
    fontSize: 14,
    outline: `2px solid ${colors.brand}`,
  },
  rowDrop: { boxShadow: `inset 0 0 0 2px ${colors.brand}` },
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
    lineHeight: "16px",
  },
  toggle: {
    flexGrow: 1,
    width: "100%",
    borderWidth: 0,
    backgroundColor: "transparent",
    color: { default: colors.muted, ":hover": colors.text },
    font: "inherit",
    fontSize: 12,
    fontWeight: 500,
    lineHeight: "16px",
    cursor: "var(--cursor-pointer, pointer)",
  },
  chevron: {
    display: "flex",
    color: colors.faint,
    transition: "transform 200ms cubic-bezier(.23, 1, .32, 1)",
  },
  chevronOpen: { transform: "rotate(90deg)" },
  footerChevron: { color: colors.muted },
  pages: {
    display: "flex",
    flexDirection: "column",
    gap: space.px,
    maxHeight: 180,
    margin: 0,
    padding: 0,
    overflowY: "auto",
    listStyle: "none",
  },
  row: {
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    width: "100%",
    height: size.sm,
    paddingInline: space.ms,
    borderWidth: 0,
    backgroundColor: { default: "transparent", ":hover": colors.bg },
    color: colors.text,
    font: "inherit",
    fontSize: 14,
    lineHeight: "20px",
    textAlign: "left",
    cursor: "var(--cursor-pointer, pointer)",
  },
  rowOn: {
    backgroundColor: { default: colors.sunk, ":hover": colors.sunk },
    fontWeight: 500,
  },
  rowIcon: { display: "flex", color: colors.faint },
  rowName: {
    flexGrow: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    textAlign: "left",
  },
  count: {
    color: colors.faint,
    fontFamily: fonts.mono,
    fontSize: 12,
    fontVariantNumeric: "tabular-nums",
    whiteSpace: "nowrap",
  },
  working: { color: colors.muted, fontSize: 12, whiteSpace: "nowrap" },
  search: {
    height: size.xs,
    marginInline: space.ms,
    marginBottom: space.xs,
    paddingInline: space.sm,
    borderWidth: 0,
    borderRadius: radii.sm,
    backgroundColor: colors.sunk,
    color: colors.text,
    font: "inherit",
    fontSize: 13,
    outline: { default: "none", ":focus-visible": `2px solid ${colors.brand}` },
  },
  footer: {
    flexShrink: 0,
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: colors.border,
  },
  footerButton: {
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    width: "100%",
    height: `calc(${size.lg} - 1px)`,
    paddingInline: space.ms,
    borderWidth: 0,
    backgroundColor: "transparent",
    color: { default: colors.muted, ":hover": colors.text },
    font: "inherit",
    fontSize: 12,
    fontWeight: 500,
    cursor: "var(--cursor-pointer, pointer)",
  },
  agents: {
    display: "flex",
    flexDirection: "column",
    gap: space.sm,
    maxHeight: 198,
    margin: 0,
    paddingTop: 0,
    paddingBottom: space.ms,
    paddingInline: space.ms,
    overflowY: "auto",
    listStyle: "none",
  },
  idle: { color: colors.muted, fontSize: 12 },
  agent: { display: "flex", alignItems: "center", gap: space.sm, minWidth: 0 },
  chip: {
    flexShrink: 0,
    paddingInline: space.sm,
    height: 21,
    display: "inline-flex",
    alignItems: "center",
    borderRadius: radii.xs,
    backgroundColor: colors.sunk,
    color: colors.muted,
    fontSize: 12,
    fontWeight: 500,
  },
  chipOn: { backgroundColor: colors.accent, color: colors.onAccent },
  status: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    color: colors.muted,
    fontSize: 12,
  },
  statusIdle: { color: colors.faint },
});
