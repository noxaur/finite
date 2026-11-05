"use client";

import * as stylex from "@stylexjs/stylex";
import { type ReactNode, useRef, useState } from "react";
import type { Listener, Presence } from "@/design/schema";
import { colors, radii, shadows, size, space } from "@/styles/tokens.stylex";
import { Icon } from "./Icons";

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
 * drawn. Agents create and fill pages; people switch between them.
 */
export function LeftSidebar({
  name,
  onRename,
  mode,
  onMode,
  pages,
  page,
  onPage,
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
  /** The layers of the shown page, matching the search typed. */
  layers: (query: string) => ReactNode;
  tokens: ReactNode;
  presence: ReadonlyArray<Presence>;
  listening: ReadonlyArray<Listener>;
}) {
  const [query, setQuery] = useState<string | null>(null);
  const [pagesOpen, setPagesOpen] = useState(true);
  const searchRef = useRef<HTMLInputElement>(null);

  return (
    <aside data-camera-ignore aria-label="Design" {...stylex.props(styles.panel)}>
      <header {...stylex.props(styles.head)}>
        <input
          key={name ?? ""}
          aria-label="Design name"
          defaultValue={name ?? ""}
          placeholder="…"
          spellCheck={false}
          onBlur={(e) => {
            const next = e.target.value.trim();
            if (next && next !== name) onRename(next);
            else e.target.value = name ?? "";
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            else if (e.key === "Escape") {
              e.currentTarget.value = name ?? "";
              e.currentTarget.blur();
            }
          }}
          {...stylex.props(styles.name)}
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
              <button
                type="button"
                aria-expanded={pagesOpen}
                onClick={() => setPagesOpen(!pagesOpen)}
                {...stylex.props(styles.label, styles.toggle)}
              >
                <span {...stylex.props(styles.chevron, pagesOpen && styles.chevronOpen)}>
                  <Icon name="next" size={10} />
                </span>
                Pages
              </button>
              {pagesOpen && (
                <ol {...stylex.props(styles.pages)}>
                  {pages.map((p) => (
                    <li key={p.id}>
                      <button
                        type="button"
                        aria-current={p.id === page ? "page" : undefined}
                        onClick={() => onPage(p.id)}
                        title={p.name}
                        {...stylex.props(styles.row, p.id === page && styles.rowOn)}
                      >
                        <span {...stylex.props(styles.rowIcon)}>
                          <Icon name="page" size={14} />
                        </span>
                        <span {...stylex.props(styles.rowName)}>{p.name}</span>
                        <span {...stylex.props(styles.count)}>{p.artboardCount}</span>
                      </button>
                    </li>
                  ))}
                </ol>
              )}
            </section>
          )}
          <section aria-label="Layers" {...stylex.props(styles.section, styles.grow)}>
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
            {layers(query ?? "")}
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
      {open && (
        <ul {...stylex.props(styles.agents)}>
          {agents.length === 0 && <li {...stylex.props(styles.idle)}>No agents connected.</li>}
          {agents.map((a) => (
            <li key={a.id} {...stylex.props(styles.agent)}>
              <span {...stylex.props(styles.chip, a.status !== null && styles.chipOn)}>
                {a.name}
              </span>
              <span {...stylex.props(styles.status)} title={a.status ?? undefined}>
                {a.status ?? "Idle"}
              </span>
            </li>
          ))}
        </ul>
      )}
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        {...stylex.props(styles.footerButton)}
      >
        <span {...stylex.props(styles.chevron, styles.chevronUp, open && styles.chevronDown)}>
          <Icon name="next" size={10} />
        </span>
        <span {...stylex.props(styles.rowName)}>Agents</span>
        {working > 0 && <span {...stylex.props(styles.count)}>{working} working</span>}
        <span {...stylex.props(styles.count)}>{agents.length}</span>
      </button>
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
    paddingRight: space.sm,
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
    marginBottom: space.sm,
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
    paddingTop: space.ms,
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: colors.borderSoft,
  },
  grow: { flexGrow: 1, flexShrink: 1, minHeight: 0 },
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
  chevronUp: { transform: "rotate(-90deg)" },
  chevronDown: { transform: "rotate(90deg)" },
  pages: {
    display: "flex",
    flexDirection: "column",
    gap: space.px,
    maxHeight: 180,
    margin: 0,
    marginBottom: space.sm,
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
    fontSize: 12,
    fontVariantNumeric: "tabular-nums",
    whiteSpace: "nowrap",
  },
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
    backgroundColor: { default: "transparent", ":hover": colors.bg },
    color: colors.text,
    font: "inherit",
    fontSize: 14,
    fontWeight: 500,
    cursor: "var(--cursor-pointer, pointer)",
  },
  agents: {
    display: "flex",
    flexDirection: "column",
    gap: space.xs,
    maxHeight: 200,
    margin: 0,
    paddingTop: space.sm,
    paddingInline: space.ms,
    overflowY: "auto",
    listStyle: "none",
  },
  idle: { color: colors.muted, fontSize: 12 },
  agent: { display: "flex", alignItems: "center", gap: space.sm, minWidth: 0 },
  chip: {
    flexShrink: 0,
    paddingInline: 6,
    height: 22,
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
    fontSize: 13,
  },
});
