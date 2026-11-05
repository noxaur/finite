"use client";

import * as stylex from "@stylexjs/stylex";
import { colors, radii, space } from "@/styles/tokens.stylex";

interface PageRow {
  readonly id: string;
  readonly name: string;
  readonly artboardCount: number;
}

/**
 * The design's pages, down the left side. The canvas shows one page at a
 * time, so picking one swaps which artboards are drawn. Agents create and
 * fill pages; people only switch between them.
 */
export function PagesSidebar({
  pages,
  current,
  onSelect,
}: {
  pages: ReadonlyArray<PageRow>;
  current: string;
  onSelect: (id: string) => void;
}) {
  return (
    <nav data-camera-ignore data-canvas-chrome aria-label="Pages" {...stylex.props(styles.panel)}>
      <p {...stylex.props(styles.title)}>Pages</p>
      <ol {...stylex.props(styles.list)}>
        {pages.map((page) => (
          <li key={page.id}>
            <button
              type="button"
              aria-current={page.id === current ? "page" : undefined}
              onClick={() => onSelect(page.id)}
              title={page.name}
              {...stylex.props(styles.row, page.id === current && styles.rowCurrent)}
            >
              <span {...stylex.props(styles.name)}>{page.name}</span>
              <span {...stylex.props(styles.count)}>{page.artboardCount}</span>
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );
}

const styles = stylex.create({
  panel: {
    position: "absolute",
    top: 52,
    left: space.sm,
    width: 200,
    maxHeight: "calc(100% - 52px - 200px)",
    display: "flex",
    flexDirection: "column",
    gap: space.xs,
    padding: space.xs,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  title: {
    margin: 0,
    paddingInline: space.xs,
    paddingTop: 2,
    color: colors.muted,
    fontSize: 12,
    fontWeight: 500,
  },
  list: {
    display: "flex",
    flexDirection: "column",
    gap: 1,
    minHeight: 0,
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
    height: 28,
    paddingInline: space.sm,
    borderWidth: 0,
    borderRadius: 4,
    backgroundColor: { default: "transparent", ":hover": colors.bg },
    color: "inherit",
    font: "inherit",
    textAlign: "left",
    cursor: "var(--cursor-pointer, pointer)",
  },
  rowCurrent: {
    backgroundColor: { default: colors.bg, ":hover": colors.bg },
    fontWeight: 500,
  },
  name: {
    flexGrow: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  count: {
    color: colors.muted,
    fontSize: 12,
    fontVariantNumeric: "tabular-nums",
  },
});
