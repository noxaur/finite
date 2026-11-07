"use client";

import * as stylex from "@stylexjs/stylex";
import type { Canvas, ThreadMeta, ThreadSection } from "@finite/protocol";
import { useRef, useState } from "react";
import { finite } from "@/client/finite";
import {
  groupThreads,
  shortAgo,
  SNOOZE_CHOICES,
  snoozeLeft,
  snoozeUntil,
  type ThreadRow,
} from "@/lib/threads";
import { colors, fonts, motion, radii, size, space } from "@/styles/tokens.stylex";
import { IconButton } from "./Button";
import { Icon } from "./Icons";
import { Menu } from "./Menu";
import { useNow } from "./TimeAgo";
import { toast } from "./Toast";

/** What the list opens: a thread, on one of its canvases. */
export interface ThreadTarget {
  readonly threadId: string;
  readonly canvasId: string | null;
}

/**
 * The Prototypes side of the left sidebar, after T3 Code's thread list: search, filter and new at
 * the top; the threads waiting on people, newest first; and Working, Snoozed and Settled as
 * collapsible sections at the bottom. A thread's child threads and extra canvases nest under it.
 */
export function ThreadList({
  designId,
  threads,
  canvases,
  current,
  showWorkingSeparately,
  onOpen,
  onNew,
}: {
  designId: string;
  threads: ReadonlyArray<ThreadMeta>;
  canvases: ReadonlyArray<Canvas>;
  current: ThreadTarget | null;
  showWorkingSeparately: boolean;
  onOpen: (target: ThreadTarget) => void;
  onNew: () => void;
}) {
  const now = useNow() || Date.now();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<Record<"working" | "snoozed" | "settled", boolean>>({
    working: true,
    snoozed: true,
    settled: false,
  });
  const [filterOpen, setFilterOpen] = useState(false);
  const filterRef = useRef<HTMLButtonElement>(null);
  const groups = groupThreads(threads, now, showWorkingSeparately, query);
  const names = new Map(canvases.map((c) => [c.id, c.name]));

  const act = (run: () => Promise<unknown>) =>
    void run().catch((e: unknown) => toast(e instanceof Error ? e.message : String(e)));

  const snooze = (meta: ThreadMeta, until: number | null) =>
    act(async () => {
      await finite.request("thread.snooze", { designId, threadId: meta.id, until });
      toast(until === null ? "Woken," : "Snoozed,", () =>
        act(() =>
          finite.request("thread.snooze", {
            designId,
            threadId: meta.id,
            until: meta.snoozedUntil ?? null,
          }),
        ),
      );
    });
  const settle = (meta: ThreadMeta, settled: boolean) =>
    act(async () => {
      await finite.request("thread.settle", { designId, threadId: meta.id, settled });
      toast(settled ? "Settled," : "Back in Active,", () =>
        act(() =>
          finite.request("thread.settle", { designId, threadId: meta.id, settled: !settled }),
        ),
      );
    });

  const rows = (list: ReadonlyArray<ThreadRow>, section: ThreadSection, depth = 0) =>
    list.map((row) => (
      <Thread
        key={row.meta.id}
        row={row}
        depth={depth}
        section={section}
        now={now}
        current={current}
        names={names}
        showWorkingSeparately={showWorkingSeparately}
        onOpen={onOpen}
        onSnooze={snooze}
        onSettle={settle}
        renderChildren={(children) => rows(children, section, depth + 1)}
      />
    ));

  const section = (key: "working" | "snoozed" | "settled", label: string) => {
    const list = groups[key];
    if (list.length === 0) return null;
    return (
      <section aria-label={label} {...stylex.props(styles.section)}>
        <button
          type="button"
          aria-expanded={open[key]}
          onClick={() => setOpen((o) => ({ ...o, [key]: !o[key] }))}
          {...stylex.props(styles.sectionHead)}
        >
          <span {...stylex.props(styles.sectionName)}>{label}</span>
          <span {...stylex.props(styles.count)}>{list.length}</span>
          <span {...stylex.props(styles.chevron, open[key] && styles.chevronOpen)}>
            <Icon name="next" size={12} />
          </span>
        </button>
        {open[key] && <ul {...stylex.props(styles.list)}>{rows(list, key)}</ul>}
      </section>
    );
  };

  const empty = threads.length === 0;

  return (
    <div {...stylex.props(styles.panel)}>
      <div {...stylex.props(styles.top)}>
        <label {...stylex.props(styles.search)}>
          <Icon name="search" size={15} />
          <input
            type="search"
            aria-label="Search prototypes"
            placeholder="Search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setQuery("");
            }}
            {...stylex.props(styles.searchInput)}
          />
        </label>
        <IconButton
          ref={filterRef}
          icon="filter"
          label="Filter"
          variant="ghost"
          size="small"
          expanded={filterOpen}
          onClick={() => setFilterOpen((o) => !o)}
        />
        <IconButton
          icon="compose"
          label="New prototype"
          variant="ghost"
          size="small"
          onClick={onNew}
        />
        {filterOpen && filterRef.current && (
          <Menu
            title="Filter"
            anchor={filterRef.current}
            trigger={filterRef.current}
            onClose={() => setFilterOpen(false)}
            items={[
              {
                key: "working",
                label: "Show Working separately",
                checked: showWorkingSeparately,
                run: () =>
                  void finite
                    .request("settings.set", {
                      settings: { showWorkingSeparately: !showWorkingSeparately },
                    })
                    .catch(() => {}),
              },
            ]}
          />
        )}
      </div>

      <div {...stylex.props(styles.scroll)}>
        {empty ? (
          <p {...stylex.props(styles.empty)}>
            No prototypes yet. Ask for one in the composer and it shows up here.
          </p>
        ) : (
          <ul aria-label="Active" {...stylex.props(styles.list)}>
            {rows(groups.active, "active")}
          </ul>
        )}
      </div>

      <div {...stylex.props(styles.bottom)}>
        {section("working", "Working")}
        {section("snoozed", "Snoozed")}
        {section("settled", "Settled")}
      </div>
    </div>
  );
}

function Thread({
  row,
  depth,
  section,
  now,
  current,
  names,
  showWorkingSeparately,
  onOpen,
  onSnooze,
  onSettle,
  renderChildren,
}: {
  row: ThreadRow;
  depth: number;
  section: ThreadSection;
  now: number;
  current: ThreadTarget | null;
  names: ReadonlyMap<string, string>;
  showWorkingSeparately: boolean;
  onOpen: (target: ThreadTarget) => void;
  onSnooze: (meta: ThreadMeta, until: number | null) => void;
  onSettle: (meta: ThreadMeta, settled: boolean) => void;
  renderChildren: (children: ReadonlyArray<ThreadRow>) => React.ReactNode;
}) {
  const { meta } = row;
  const [snoozing, setSnoozing] = useState(false);
  const clock = useRef<HTMLButtonElement>(null);
  const first = meta.canvasIds[0] ?? null;
  const on = current?.threadId === meta.id;
  const title = meta.title || "New prototype";
  const snoozed = section === "snoozed" && meta.snoozedUntil !== undefined;
  // One canvas is the thread itself; only two or more are worth listing under it.
  const nested = meta.canvasIds.length > 1 ? meta.canvasIds : [];
  const queued = meta.queued.length > 0 ? `${meta.queued.length} queued` : "";

  const status = meta.running ? (
    <span {...stylex.props(styles.working)}>
      <span {...stylex.props(styles.spinner)} aria-hidden />
      {showWorkingSeparately ? `Working ${shortAgo(meta.updatedAt, now)}` : "Working"}
    </span>
  ) : snoozed ? (
    <span {...stylex.props(styles.snoozed)}>
      <Icon name="clock" size={12} />
      {snoozeLeft(meta.snoozedUntil!, now) || "Until opened"}
    </span>
  ) : (
    <span {...stylex.props(styles.time)}>
      {shortAgo(meta.awaitingSince ?? meta.updatedAt, now)}
    </span>
  );

  return (
    <li {...stylex.props(styles.item)}>
      <div
        {...stylex.props(
          stylex.defaultMarker(),
          styles.row,
          on && nested.length === 0 && styles.rowOn,
          (snoozing || on) && styles.rowHeld,
        )}
        style={{ paddingLeft: `calc(${depth} * 15px + 9px)` }}
      >
        <button
          type="button"
          aria-current={on ? "page" : undefined}
          onClick={() => onOpen({ threadId: meta.id, canvasId: first })}
          {...stylex.props(styles.open)}
        >
          <span {...stylex.props(styles.line)}>
            <span {...stylex.props(styles.title, !meta.title && styles.untitled)}>{title}</span>
          </span>
          {(!first || queued) && (
            <span {...stylex.props(styles.sub)}>
              <Icon name={first ? "page" : "history"} size={12} />
              <span {...stylex.props(styles.subText)}>
                {first ? queued : queued ? `Chat · ${queued}` : "Chat"}
              </span>
            </span>
          )}
        </button>
        <span {...stylex.props(styles.status, section !== "settled" && styles.statusHides)}>
          {status}
        </span>
        <span {...stylex.props(styles.actions, snoozing && styles.actionsShown)}>
          {section === "settled" ? (
            <IconButton
              icon="previous"
              label="Back to Active"
              variant="ghost"
              size="small"
              onClick={() => onSettle(meta, false)}
            />
          ) : (
            <>
              <IconButton
                ref={clock}
                icon="clock"
                label={snoozed ? "Snooze again or wake" : "Snooze"}
                variant="ghost"
                size="small"
                expanded={snoozing}
                onClick={() => setSnoozing((s) => !s)}
              />
              <IconButton
                icon="check"
                label="Settle"
                title="Settle: done for now"
                variant="ghost"
                size="small"
                onClick={() => onSettle(meta, true)}
              />
            </>
          )}
        </span>
        {snoozing && clock.current && (
          <Menu
            title="Snooze"
            anchor={clock.current}
            trigger={clock.current}
            onClose={() => setSnoozing(false)}
            items={[
              ...SNOOZE_CHOICES.map(([choice, label]) => ({
                key: choice,
                label,
                run: () => onSnooze(meta, snoozeUntil(choice, Date.now())),
              })),
              ...(snoozed
                ? [
                    { key: "sep", label: "", separator: true, run: () => {} },
                    { key: "wake", label: "Wake now", run: () => onSnooze(meta, null) },
                  ]
                : []),
            ]}
          />
        )}
      </div>
      {nested.length > 0 && (
        <ul {...stylex.props(styles.list)}>
          {nested.map((canvasId) => (
            <li key={canvasId}>
              <button
                type="button"
                onClick={() => onOpen({ threadId: meta.id, canvasId })}
                {...stylex.props(
                  styles.canvasRow,
                  on && current?.canvasId === canvasId && styles.rowOn,
                )}
                style={{ paddingLeft: `calc(${depth + 1} * 15px + 9px)` }}
              >
                <Icon name="page" size={12} />
                <span {...stylex.props(styles.subText)}>{canvasLabel(names.get(canvasId))}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {row.children.length > 0 && (
        <ul {...stylex.props(styles.list)}>{renderChildren(row.children)}</ul>
      )}
    </li>
  );
}

/** A canvas's name, or "Prototype" while it has the placeholder one. */
const canvasLabel = (name: string | undefined) =>
  !name || name === "New prototype" ? "Prototype" : name;

const spin = stylex.keyframes({
  "0%": { transform: "rotate(0deg)" },
  "100%": { transform: "rotate(360deg)" },
});

const styles = stylex.create({
  panel: {
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    minHeight: 0,
    fontFamily: fonts.sans,
  },
  top: {
    display: "flex",
    alignItems: "center",
    gap: space.xs,
    paddingInline: space.ms,
    paddingTop: space.sm,
    paddingBottom: space.sm,
  },
  search: {
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    flexGrow: 1,
    minWidth: 0,
    height: size.xs,
    color: colors.faint,
  },
  searchInput: {
    flexGrow: 1,
    minWidth: 0,
    height: "100%",
    padding: 0,
    borderWidth: 0,
    backgroundColor: "transparent",
    color: colors.text,
    fontFamily: fonts.sans,
    fontSize: 14,
    outline: "none",
    "::placeholder": { color: colors.muted },
  },
  scroll: { flexGrow: 1, minHeight: 0, overflowY: "auto", paddingInline: space.xs },
  list: { margin: 0, padding: 0, listStyle: "none" },
  item: { display: "block" },
  empty: {
    margin: 0,
    padding: space.ms,
    color: colors.faint,
    fontSize: 12,
    lineHeight: "18px",
  },
  row: {
    position: "relative",
    display: "flex",
    alignItems: "flex-start",
    gap: space.sm,
    paddingRight: space.ms,
    paddingBlock: space.sm,
    borderRadius: radii.md,
    backgroundColor: { default: "transparent", ":hover": colors.hoverFill },
  },
  rowOn: { backgroundColor: { default: colors.activeFill, ":hover": colors.activeFill } },
  rowHeld: {},
  open: {
    display: "flex",
    flexDirection: "column",
    gap: space.xs,
    flexGrow: 1,
    minWidth: 0,
    padding: 0,
    borderWidth: 0,
    backgroundColor: "transparent",
    color: colors.text,
    textAlign: "left",
    font: "inherit",
    cursor: "var(--cursor-pointer, pointer)",
    outline: "none",
    // The whole row is the button's hit area.
    "::after": { content: '""', position: "absolute", inset: 0, borderRadius: radii.md },
    ":focus-visible::after": { outline: `1px solid ${colors.brand}`, outlineOffset: -1 },
  },
  line: { display: "flex", alignItems: "baseline", gap: space.sm, minWidth: 0 },
  title: {
    flexGrow: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: 14,
    lineHeight: "18px",
  },
  untitled: { color: colors.muted },
  sub: {
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    minWidth: 0,
    color: colors.faint,
  },
  subText: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: 12,
    lineHeight: "15px",
  },
  status: {
    position: "relative",
    flexShrink: 0,
    display: "flex",
    alignItems: "center",
    height: 18,
    pointerEvents: "none",
  },
  statusHides: {
    opacity: { default: 1, [stylex.when.ancestor(":hover")]: 0 },
  },
  time: { color: colors.faint, fontSize: 12, lineHeight: "15px" },
  working: {
    display: "inline-flex",
    alignItems: "center",
    gap: space.sm,
    color: colors.brandText,
    fontSize: 12,
    lineHeight: "15px",
    whiteSpace: "nowrap",
  },
  snoozed: {
    display: "inline-flex",
    alignItems: "center",
    gap: space.xs,
    color: colors.brandText,
    fontSize: 12,
    lineHeight: "15px",
  },
  spinner: {
    width: 11,
    height: 11,
    borderRadius: "50%",
    borderWidth: 1.5,
    borderStyle: "dashed",
    borderColor: colors.brand,
    animationName: spin,
    animationDuration: "2.4s",
    animationTimingFunction: "linear",
    animationIterationCount: "infinite",
  },
  actions: {
    position: "absolute",
    top: space.xs,
    right: space.sm,
    display: "flex",
    gap: 0,
    opacity: {
      default: 0,
      [stylex.when.ancestor(":hover")]: 1,
      [stylex.when.ancestor(":focus-within")]: 1,
    },
    transition: `opacity ${motion.fast} ease`,
  },
  actionsShown: { opacity: 1 },
  canvasRow: {
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    width: "100%",
    height: size.xs,
    paddingRight: space.ms,
    borderWidth: 0,
    borderRadius: radii.sm,
    backgroundColor: { default: "transparent", ":hover": colors.hoverFill },
    color: colors.muted,
    textAlign: "left",
    cursor: "var(--cursor-pointer, pointer)",
    outline: { default: "none", ":focus-visible": `1px solid ${colors.brand}` },
  },
  bottom: {
    flexShrink: 0,
    maxHeight: "50%",
    overflowY: "auto",
    paddingInline: space.xs,
  },
  section: { display: "flex", flexDirection: "column", paddingBottom: space.xs },
  sectionHead: {
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    height: size.md,
    paddingInline: space.ms,
    borderWidth: 0,
    borderRadius: radii.sm,
    backgroundColor: "transparent",
    color: { default: colors.muted, ":hover": colors.text },
    fontFamily: fonts.sans,
    fontSize: 13,
    fontWeight: 500,
    cursor: "var(--cursor-pointer, pointer)",
    outline: { default: "none", ":focus-visible": `1px solid ${colors.brand}` },
  },
  sectionName: { flexGrow: 1, textAlign: "left" },
  count: { color: colors.faint, fontSize: 13, fontVariantNumeric: "tabular-nums" },
  chevron: {
    display: "flex",
    color: colors.faint,
    transition: `transform ${motion.base} ${motion.out}`,
  },
  chevronOpen: { transform: "rotate(90deg)" },
});
