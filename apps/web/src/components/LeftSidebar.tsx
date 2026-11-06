"use client";

import * as stylex from "@stylexjs/stylex";
import { type ReactNode, useRef, useState } from "react";
import { colors, motion, radii, shadows, size, space } from "@/styles/tokens.stylex";
import { IconButton, Strip, StripItem } from "./Button";
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
 * and layers or its tokens. The canvas
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
  inert,
  style,
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
  /** Out of reach of the pointer, focus and screen readers, as while it's hidden. */
  inert?: boolean;
  /** The canvas's own placement for the panel, applied last: how it hides and comes back. */
  style?: stylex.StyleXStyles;
}) {
  const [query, setQuery] = useState<string | null>(null);
  const [pagesOpen, setPagesOpen] = useState(true);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [dropPage, setDropPage] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  return (
    <aside
      data-camera-ignore
      aria-label="Design"
      inert={inert}
      {...stylex.props(styles.panel, style)}
    >
      <header {...stylex.props(styles.head)}>
        <NameInput
          key={name ?? ""}
          label="Design name"
          value={name ?? ""}
          placeholder="…"
          onRename={onRename}
          style={styles.name}
        />
        <IconButton
          icon="search"
          label="Search layers"
          size="small"
          expanded={query !== null}
          onClick={() => {
            onMode("design");
            if (query === null) {
              setQuery("");
              requestAnimationFrame(() => searchRef.current?.focus());
            } else setQuery(null);
          }}
        />
      </header>

      <Strip role="tablist" aria-label="Sidebar" style={styles.switch}>
        {(["design", "tokens"] as const).map((m) => (
          <StripItem key={m} picked={mode === m} onClick={() => onMode(m)}>
            {m === "design" ? "Design" : "Tokens"}
          </StripItem>
        ))}
      </Strip>

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
                  Pages
                  <span {...stylex.props(styles.chevron, pagesOpen && styles.chevronOpen)}>
                    <Icon name="next" size={12} />
                  </span>
                </button>
                <IconButton
                  icon="plus"
                  label="Add page"
                  size="small"
                  onClick={() => {
                    setPagesOpen(true);
                    pageActions.add();
                  }}
                  style={styles.onHover}
                />
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
                        <div {...stylex.props(styles.row, styles.rowOn)}>
                          <span {...stylex.props(styles.rowIcon, styles.rowIconOn)}>
                            <Icon name="page" size={15} />
                          </span>
                          <NameInput
                            label="Page name"
                            value={p.name}
                            autoFocus
                            onRename={(next) => pageActions.rename(p.id, next)}
                            onDone={() => setRenaming(null)}
                            style={styles.pageInput}
                          />
                        </div>
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
                          <span
                            {...stylex.props(styles.rowIcon, p.id === page && styles.rowIconOn)}
                          >
                            <Icon name="page" size={15} />
                          </span>
                          <span {...stylex.props(styles.rowName)}>{p.name}</span>
                        </button>
                      )}
                      {pages.length > 1 && p.id === page && renaming !== p.id && (
                        <IconButton
                          icon="close"
                          label={`Delete ${p.name}`}
                          title="Delete page and its artboards (⌘Z brings it back)"
                          size="small"
                          onClick={() => pageActions.remove(p.id)}
                          style={[styles.pageDelete, styles.onHover]}
                        />
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
    </aside>
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
  /** The design's name: plain text until it's edited, then a sunk field. */
  name: {
    flexGrow: 1,
    minWidth: 0,
    height: size.xs,
    marginLeft: `calc(-1 * ${space.xs})`,
    paddingInline: space.xs,
    borderWidth: 0,
    borderRadius: radii.sm,
    backgroundColor: {
      default: "transparent",
      ":hover": colors.hoverFill,
      ":focus": colors.sunk,
    },
    boxShadow: { default: "none", ":focus": shadows.field },
    color: colors.text,
    font: "inherit",
    fontSize: 14,
    fontWeight: 500,
    textOverflow: "ellipsis",
    outline: { default: "none", ":focus": `1px solid ${colors.brand}` },
  },

  /** The Design and Tokens tabs, as one strip; the open one is pressed in. */
  switch: {
    marginInline: space.ms,
    marginTop: space.ms,
    marginBottom: space.xs,
  },

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
  /** Layers runs to the bottom edge: the list scrolls there, with its own room after the last row. */
  grow: { flexGrow: 1, flexShrink: 1, minHeight: 0, paddingBottom: 0 },
  labelRow: {
    display: "flex",
    alignItems: "center",
    paddingRight: space.ms,
  },
  /** Shown while the pointer is over its row, or the control has focus. */
  onHover: {
    opacity: {
      default: 0,
      [stylex.when.ancestor(":hover")]: 1,
      ":focus-visible": 1,
    },
  },
  pageItem: {
    position: "relative",
    display: "flex",
    alignItems: "center",
  },
  /** On the current page's row, as far in from the side as the + above it. */
  pageDelete: {
    position: "absolute",
    right: space.ms,
  },

  /** Over the name, as in Layers: a sunk field ringed in the brand while it's typed in. */
  pageInput: {
    flexGrow: 1,
    minWidth: 0,
    height: size.xs,
    marginLeft: `calc(-1 * ${space.xs})`,
    paddingInline: space.xs,
    borderWidth: 0,
    borderRadius: radii.sm,
    backgroundColor: colors.sunk,
    boxShadow: shadows.field,
    color: colors.text,
    font: "inherit",
    fontSize: 14,
    outline: `1px solid ${colors.brand}`,
  },

  /** Where artboards dragged from Layers would move, ringed in the brand. */
  rowDrop: { boxShadow: shadows.target },
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
    lineHeight: "15px",
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
    lineHeight: "15px",
    cursor: "var(--cursor-pointer, pointer)",
  },
  chevron: {
    display: "flex",
    color: colors.faint,
    transition: `transform ${motion.base} ${motion.out}`,
  },
  chevronOpen: { transform: "rotate(90deg)" },
  pages: {
    display: "flex",
    flexDirection: "column",
    gap: space.px,
    maxHeight: 180,
    margin: 0,
    paddingBlock: 0,
    paddingInline: space.sm,
    overflowY: "auto",
    listStyle: "none",
  },
  row: {
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    width: "100%",
    height: size.sm,
    flexShrink: 0,
    paddingInline: space.xs,
    borderWidth: 0,
    borderRadius: radii.sm,
    backgroundColor: { default: "transparent", ":hover": colors.hoverFill },
    color: colors.text,
    font: "inherit",
    fontSize: 14,
    lineHeight: "20px",
    textAlign: "left",
    cursor: "var(--cursor-pointer, pointer)",
  },
  /** The page on the canvas. */
  rowOn: {
    backgroundColor: { default: colors.activeFill, ":hover": colors.activeFill },
  },

  rowIcon: { display: "flex", flexShrink: 0, color: colors.faint },
  rowIconOn: { color: colors.text },
  rowName: {
    flexGrow: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    textAlign: "left",
  },
  search: {
    height: size.xs,
    marginInline: space.ms,
    marginBottom: space.xs,
    paddingInline: space.sm,
    borderWidth: 0,
    borderRadius: radii.sm,
    backgroundColor: colors.sunk,
    boxShadow: shadows.field,
    color: colors.text,
    font: "inherit",
    fontSize: 12,
    outline: { default: "none", ":focus": `1px solid ${colors.brand}` },
    "::placeholder": { color: colors.faint },
  },
});
