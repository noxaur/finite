"use client";

import * as stylex from "@stylexjs/stylex";
import type { Canvas } from "@finite/protocol";
import { type ReactNode, useState } from "react";
import { finite } from "@/client/finite";
import { colors, fonts, motion, radii, shadows, size, space } from "@/styles/tokens.stylex";
import { IconButton, Strip, StripItem } from "./Button";
import { Icon } from "./Icons";
import { NameInput } from "./NameInput";
import { toast, ToastSlot } from "./Toast";

export type LeftMode = "design" | "prototypes";

/**
 * The left side of the design screen. Design: the pages (Routes, Brand, Components and the
 * design's own), the shown page's layers, and the tokens at the bottom, all in one scroll.
 * Prototypes: the thread list. Settings and the last toast sit at the foot.
 */
export function LeftSidebar({
  designId,
  name,
  mode,
  onMode,
  canvases,
  page,
  onPage,
  layers,
  tokens,
  prototypes,
  onSettings,
}: {
  designId: string;
  name: string;
  mode: LeftMode;
  onMode: (mode: LeftMode) => void;
  canvases: ReadonlyArray<Canvas>;
  /** The page on the canvas in Design mode. */
  page: string | null;
  onPage: (canvasId: string) => void;
  layers: ReactNode;
  tokens: ReactNode;
  prototypes: ReactNode;
  onSettings: () => void;
}) {
  const [pagesOpen, setPagesOpen] = useState(true);
  const [removedOpen, setRemovedOpen] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const pages = canvases.filter((c) => c.kind === "page" && c.removedAt === undefined);
  const removed = canvases.filter((c) => c.kind === "page" && c.removedAt !== undefined);

  const fail = (e: unknown) => toast(e instanceof Error ? e.message : String(e));
  const add = async () => {
    setPagesOpen(true);
    const taken = new Set(pages.map((p) => p.name));
    let n = pages.length + 1;
    while (taken.has(`Page ${n}`)) n++;
    try {
      const canvas = await finite.request("canvas.create", {
        designId,
        kind: "page",
        name: `Page ${n}`,
      });
      onPage(canvas.id);
      setRenaming(canvas.id);
    } catch (e) {
      fail(e);
    }
  };
  const rename = (canvasId: string, next: string) =>
    void finite.request("canvas.rename", { designId, canvasId, name: next }).catch(fail);
  const restore = (canvasId: string) =>
    finite.request("canvas.restore", { designId, canvasId }).catch(fail);
  const remove = async (p: Canvas) => {
    try {
      await finite.request("canvas.remove", { designId, canvasId: p.id });
      if (p.id === page) {
        const next = pages.find((x) => x.id !== p.id);
        if (next) onPage(next.id);
      }
      toast(`Removed ${p.name},`, () => void restore(p.id));
    } catch (e) {
      fail(e);
    }
  };

  return (
    <aside data-camera-ignore aria-label="Design" {...stylex.props(styles.panel)}>
      <header {...stylex.props(styles.head)}>
        <span title={name} {...stylex.props(styles.name)}>
          {name || "Untitled"}
        </span>
      </header>

      <Strip role="tablist" aria-label="Sidebar" style={styles.switch}>
        <StripItem picked={mode === "design"} onClick={() => onMode("design")}>
          Design
        </StripItem>
        <StripItem picked={mode === "prototypes"} onClick={() => onMode("prototypes")}>
          Prototypes
        </StripItem>
      </Strip>

      {mode === "prototypes" ? (
        prototypes
      ) : (
        <div {...stylex.props(styles.scroll)}>
          <section aria-label="Pages" {...stylex.props(styles.section)}>
            <div {...stylex.props(stylex.defaultMarker(), styles.labelRow)}>
              <SectionToggle
                label="Pages"
                open={pagesOpen}
                onToggle={() => setPagesOpen((o) => !o)}
              />
              <IconButton
                icon="plus"
                label="Add page"
                size="small"
                variant="ghost"
                onClick={() => void add()}
                style={styles.onHover}
              />
            </div>
            {pagesOpen && (
              <ol {...stylex.props(styles.rows)}>
                {pages.map((p) => (
                  <li key={p.id} {...stylex.props(stylex.defaultMarker(), styles.pageItem)}>
                    {renaming === p.id ? (
                      <div {...stylex.props(styles.row, styles.rowOn)}>
                        <span {...stylex.props(styles.rowIcon)}>
                          <Icon name="page" size={15} />
                        </span>
                        <NameInput
                          label="Page name"
                          value={p.name}
                          autoFocus
                          onRename={(next) => rename(p.id, next)}
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
                        title={`${p.name} (double-click to rename)`}
                        {...stylex.props(styles.row, p.id === page && styles.rowOn)}
                      >
                        <span {...stylex.props(styles.rowIcon, p.id === page && styles.rowIconOn)}>
                          <Icon name="page" size={15} />
                        </span>
                        <span {...stylex.props(styles.rowName)}>{p.name}</span>
                      </button>
                    )}
                    {renaming !== p.id && pages.length > 1 && (
                      <IconButton
                        icon="close"
                        label={`Remove ${p.name}`}
                        title="Remove page (restore it for 30 days)"
                        size="small"
                        variant="ghost"
                        onClick={() => void remove(p)}
                        style={[styles.pageAction, styles.onHover]}
                      />
                    )}
                  </li>
                ))}
                {removed.length > 0 && (
                  <li>
                    <button
                      type="button"
                      aria-expanded={removedOpen}
                      onClick={() => setRemovedOpen((o) => !o)}
                      {...stylex.props(styles.row, styles.removedToggle)}
                    >
                      <span {...stylex.props(styles.rowIcon)}>
                        <Icon name="trash" size={15} />
                      </span>
                      <span {...stylex.props(styles.rowName)}>Removed ({removed.length})</span>
                    </button>
                    {removedOpen && (
                      <ol {...stylex.props(styles.rows)}>
                        {removed.map((p) => (
                          <li key={p.id} {...stylex.props(styles.pageItem)}>
                            <span {...stylex.props(styles.row, styles.removedRow)}>
                              <span {...stylex.props(styles.rowName)}>{p.name}</span>
                            </span>
                            <IconButton
                              icon="rotate"
                              label={`Restore ${p.name}`}
                              size="small"
                              variant="ghost"
                              onClick={() => void restore(p.id)}
                              style={styles.pageAction}
                            />
                          </li>
                        ))}
                      </ol>
                    )}
                  </li>
                )}
              </ol>
            )}
          </section>

          <section aria-label="Layers" {...stylex.props(styles.section, styles.rule)}>
            <p {...stylex.props(styles.label)}>Layers</p>
            {layers}
          </section>

          <section aria-label="Tokens" {...stylex.props(styles.rule)}>
            {tokens}
          </section>
        </div>
      )}

      <footer {...stylex.props(styles.foot)}>
        <IconButton
          icon="gear"
          label="Settings"
          variant="ghost"
          size="small"
          onClick={onSettings}
        />
        <ToastSlot style={styles.toast} />
      </footer>
    </aside>
  );
}

function SectionToggle({
  label,
  open,
  onToggle,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={onToggle}
      {...stylex.props(styles.label, styles.toggle)}
    >
      {label}
      <span {...stylex.props(styles.chevron, open && styles.chevronOpen)}>
        <Icon name="next" size={12} />
      </span>
    </button>
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
    color: colors.text,
    fontFamily: fonts.sans,
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
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: 14,
    fontWeight: 500,
  },
  switch: { flexShrink: 0, marginInline: space.ms, marginTop: space.ms, marginBottom: space.xs },
  scroll: { flexGrow: 1, minHeight: 0, overflowY: "auto" },
  section: {
    display: "flex",
    flexDirection: "column",
    gap: space.px,
    paddingBlock: space.ms,
  },
  rule: { borderTopWidth: 1, borderTopStyle: "solid", borderTopColor: colors.borderSoft },
  labelRow: { display: "flex", alignItems: "center", paddingRight: space.ms },
  onHover: {
    opacity: {
      default: 0,
      [stylex.when.ancestor(":hover")]: 1,
      ":focus-visible": 1,
    },
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
    lineHeight: "15px",
  },
  toggle: {
    flexGrow: 1,
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
  rows: {
    display: "flex",
    flexDirection: "column",
    gap: space.px,
    margin: 0,
    paddingBlock: 0,
    paddingInline: space.sm,
    listStyle: "none",
  },
  pageItem: { position: "relative", display: "flex", alignItems: "center" },
  pageAction: { position: "absolute", right: space.xs },
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
    outline: { default: "none", ":focus-visible": `1px solid ${colors.brand}` },
  },
  rowOn: { backgroundColor: { default: colors.activeFill, ":hover": colors.activeFill } },
  rowIcon: { display: "flex", flexShrink: 0, color: colors.faint },
  rowIconOn: { color: colors.text },
  rowName: {
    flexGrow: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  removedToggle: { color: colors.muted, fontSize: 13 },
  removedRow: { color: colors.faint, fontSize: 13, cursor: "default", paddingLeft: 27 },
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
  foot: {
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    flexShrink: 0,
    height: size.lg,
    paddingInline: space.sm,
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: colors.borderSoft,
  },
  toast: { flexGrow: 1, justifyContent: "flex-end", paddingRight: space.xs, overflow: "hidden" },
});
