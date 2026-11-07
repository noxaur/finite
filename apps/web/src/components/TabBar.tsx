"use client";

import * as stylex from "@stylexjs/stylex";
import { useRouter } from "next/navigation";
import {
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useDesigns } from "@/client/finite";
import { closeTab, openTab, pruneTabs, renameTab, stepTab, type Tab, tabsStore } from "@/lib/tabs";
import { raised } from "@/styles/raised";
import { colors, fonts, motion, radii, size, space } from "@/styles/tokens.stylex";
import { IconButton } from "./Button";
import { Icon } from "./Icons";

const designHref = (id: string) => `/design/?id=${id}`;

/** Where the strip was scrolled, so a remount doesn't move the tabs under the pointer. */
let stripScroll = 0;

/** Whether the page runs in the macOS desktop app, whose window buttons sit in this bar. */
const inMacApp = () => typeof window !== "undefined" && window.finite?.platform === "darwin";
const noSubscribe = () => () => {};

/** Minimal typing for the Navigation API, which lib.dom doesn't have everywhere. */
interface HistoryNavigation extends EventTarget {
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
}

/**
 * Whether history can go back and forward, from the Navigation API where the
 * browser has it. Without it both stay on, and a press with nowhere to go
 * does nothing.
 */
function useHistoryEnds(): { back: boolean; forward: boolean } {
  const [ends, setEnds] = useState({ back: true, forward: true });
  useEffect(() => {
    const nav = (window as { navigation?: HistoryNavigation }).navigation;
    if (!nav || typeof nav.canGoBack !== "boolean") return;
    // Next pushes history inside an insertion effect, where React allows no updates: wait for it.
    const update = () =>
      queueMicrotask(() => setEnds({ back: nav.canGoBack, forward: nav.canGoForward }));
    update();
    nav.addEventListener("currententrychange", update);
    return () => nav.removeEventListener("currententrychange", update);
  }, []);
  return ends;
}

export interface TabBarProps {
  /** The design on screen, or `null` on the designs list. */
  readonly current: string | null;
  /** Its name from its own socket, which is ahead of the design list's. */
  readonly currentName?: string | null | undefined;
  /** Agents working on it right now: they put a spinner on its tab. */
  readonly working?: ReadonlyArray<{ readonly name: string; readonly status: string | null }>;
  /** Hides the bar while it stays mounted, as in interactive mode. */
  readonly hidden?: boolean;
  /** The design's own actions, at the bar's right end. */
  readonly children?: ReactNode;
}

/**
 * The window's top row: history arrows, the left sidebar's toggle, a tab per
 * open design, and the design's actions on the right. In the macOS app it's
 * the title bar too: the window buttons sit at its left and it drags the window.
 */
export function TabBar({ current, currentName, working = [], hidden, children }: TabBarProps) {
  const router = useRouter();
  const state = useSyncExternalStore(tabsStore.subscribe, tabsStore.get, tabsStore.getServer);
  const macApp = useSyncExternalStore(noSubscribe, inMacApp, () => false);
  const ends = useHistoryEnds();
  const designs = useDesigns();
  const stripRef = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState({ start: false, end: false });

  // Read by listeners set up once.
  const live = useRef({ current, router });
  live.current = { current, router };

  // Opening a design opens its tab, or focuses it; a new name renames it.
  useEffect(() => {
    if (!current) return;
    const name = currentName ?? designs?.find((d) => d.id === current)?.name;
    tabsStore.update((s) => openTab(s, current, name ?? undefined));
  }, [current, currentName, designs]);

  // The design list names the tabs and closes those of designs that are gone.
  useEffect(() => {
    if (!designs) return;
    const byId = new Map(designs.map((d) => [d.id, d]));
    const active = live.current.current;
    tabsStore.update((s) => {
      const kept = pruneTabs(s, (id) => byId.has(id));
      return kept.tabs.reduce((acc, tab) => renameTab(acc, tab.id, byId.get(tab.id)!.name), kept);
    });
    if (active !== null && !byId.has(active)) live.current.router.replace("/");
  }, [designs]);

  const go = (id: string | null) => {
    if (id === current) return;
    router.push(id ? designHref(id) : "/");
  };

  const close = (id: string) => {
    let next: string | null | undefined;
    tabsStore.update((s) => {
      const closed = closeTab(s, id, current);
      next = closed.next;
      return closed.state;
    });
    // Closing doesn't add a step to history: it replaces the closed design.
    if (next !== undefined) router.replace(next ? designHref(next) : "/");
  };
  const closeRef = useRef(close);
  closeRef.current = close;

  // The desktop app's menu: ⌘W closes the tab, ⌘⇧[ and ⌘⇧] step through them.
  useEffect(
    () =>
      window.finite?.onCommand?.((command) => {
        const { current: active, router: r } = live.current;
        if (command === "closeTab") {
          if (active) closeRef.current(active);
          return;
        }
        const id = stepTab(tabsStore.get(), active, command === "nextTab" ? 1 : -1);
        if (id && id !== active) r.push(designHref(id));
      }),
    [],
  );

  // Keep the active tab in view, and fade the strip's edges where it's cut off.
  const measure = () => {
    const el = stripRef.current;
    if (!el) return;
    const start = el.scrollLeft > 0;
    const end = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setOverflow((o) => (o.start === start && o.end === end ? o : { start, end }));
  };
  useLayoutEffect(() => {
    if (stripRef.current) stripRef.current.scrollLeft = stripScroll;
  }, []);
  useLayoutEffect(() => {
    const el = stripRef.current;
    const tab = el?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (el && tab) {
      // By hand, not scrollIntoView, which would also scroll the page's hidden overflow.
      // Clear of the faded edges, too.
      const left = tab.offsetLeft - FADE;
      const right = tab.offsetLeft + tab.offsetWidth + FADE;
      if (left < el.scrollLeft) el.scrollLeft = left;
      else if (right > el.scrollLeft + el.clientWidth) el.scrollLeft = right - el.clientWidth;
    }
    measure();
  }, [current, state.tabs.length]);
  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    const resize = new ResizeObserver(measure);
    resize.observe(el);
    return () => resize.disconnect();
  }, []);

  const busy = working.length > 0;
  const busyLabel = working
    .map(({ name, status }) => (status ? `${name}: ${status}` : `${name} is working`))
    .join("\n");

  const onTabKey = (e: React.KeyboardEvent, at: number) => {
    const tabs = state.tabs;
    const focus = (i: number) =>
      stripRef.current?.querySelectorAll<HTMLElement>('[role="tab"]')[i]?.focus();
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      focus((at + (e.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length);
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      focus(e.key === "Home" ? 0 : tabs.length - 1);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      go(tabs[at].id);
    } else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      close(tabs[at].id);
    }
  };

  return (
    <header
      data-app-region="drag"
      {...stylex.props(
        styles.bar,
        styles.columns,
        current === null && styles.sticky,
        hidden && styles.hidden,
      )}
    >
      {/* Over the left sidebar: the window buttons, then history, at its right edge. */}
      <div {...stylex.props(styles.column, styles.history, macApp && styles.macApp)}>
        <IconButton
          icon="previous"
          label="Back"
          variant="ghost"
          size="small"
          disabled={!ends.back}
          onClick={() => router.back()}
        />
        <IconButton
          icon="next"
          label="Forward"
          variant="ghost"
          size="small"
          disabled={!ends.forward}
          onClick={() => router.forward()}
        />
      </div>
      {/* Over the canvas and the right sidebar. */}
      <div {...stylex.props(styles.main)}>
        <div
          ref={stripRef}
          role="tablist"
          aria-label="Open designs"
          onScroll={(e) => {
            stripScroll = e.currentTarget.scrollLeft;
            measure();
          }}
          onWheel={(e) => {
            // A mouse wheel scrolls the tabs sideways.
            const el = stripRef.current;
            if (el && Math.abs(e.deltaY) > Math.abs(e.deltaX)) el.scrollLeft += e.deltaY;
          }}
          {...stylex.props(
            styles.strip,
            overflow.start && overflow.end && styles.fadeBoth,
            overflow.start && !overflow.end && styles.fadeStart,
            !overflow.start && overflow.end && styles.fadeEnd,
          )}
        >
          {state.tabs.map((tab, at) => (
            <TabItem
              key={tab.id}
              tab={tab}
              active={tab.id === current}
              busy={tab.id === current && busy}
              busyLabel={busyLabel}
              changed={false}
              onSelect={() => go(tab.id)}
              onClose={() => close(tab.id)}
              onKeyDown={(e) => onTabKey(e, at)}
            />
          ))}
        </div>
        <IconButton
          icon="plus"
          label="Open a design"
          title="Open a design from the list"
          variant="ghost"
          size="small"
          onClick={() => go(null)}
        />
        <span {...stylex.props(styles.spacer)} />
        {children && <div {...stylex.props(styles.actions)}>{children}</div>}
      </div>
    </header>
  );
}

function TabItem({
  tab,
  active,
  busy,
  busyLabel,
  changed,
  onSelect,
  onClose,
  onKeyDown,
}: {
  tab: Tab;
  active: boolean;
  busy: boolean;
  busyLabel: string;
  changed: boolean;
  onSelect: () => void;
  onClose: () => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
}) {
  const name = tab.name || "Untitled";
  const title = busy
    ? `${name}\n${busyLabel}`
    : changed
      ? `${name}\nChanged since you looked`
      : name;
  return (
    <div
      role="tab"
      aria-selected={active}
      tabIndex={active ? 0 : -1}
      title={title}
      onClick={onSelect}
      onKeyDown={onKeyDown}
      // A middle click closes the tab; stop its autoscroll first.
      onMouseDown={(e) => e.button === 1 && e.preventDefault()}
      onAuxClick={(e) => {
        if (e.button !== 1) return;
        e.preventDefault();
        onClose();
      }}
      {...stylex.props(
        stylex.defaultMarker(),
        styles.tab,
        active ? [raised.control, styles.active] : styles.inactive,
      )}
    >
      {busy ? (
        <span role="img" aria-label="An agent is working" {...stylex.props(styles.status)}>
          <span {...stylex.props(styles.spinner)} />
        </span>
      ) : changed ? (
        <span role="img" aria-label="Changed" {...stylex.props(styles.status)}>
          <span {...stylex.props(styles.dot)} />
        </span>
      ) : null}
      <span
        {...stylex.props(
          styles.name,
          !active && styles.nameUnderClose,
          !tab.name && styles.unnamed,
        )}
      >
        {name}
      </span>
      <button
        type="button"
        tabIndex={-1}
        aria-label={`Close ${name}`}
        title="Close tab"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        {...stylex.props(styles.close, active ? styles.closeInline : styles.closeOver)}
      >
        <Icon name="close" size={8} />
      </button>
    </div>
  );
}

const spin = stylex.keyframes({
  "0%": { transform: "rotate(0deg)" },
  "100%": { transform: "rotate(360deg)" },
});
const breathe = stylex.keyframes({
  "0%": { opacity: 1 },
  "50%": { opacity: 0.35 },
  "100%": { opacity: 1 },
});

/** How far the strip fades out where tabs are cut off, as in `styles.fadeStart`. */
const FADE = 18;

/** Where the macOS window buttons sit, from `trafficLightPosition` in apps/desktop/src/main.ts. */
const MAC_BUTTONS = 78;

const styles = stylex.create({
  // Its columns are the panels' below, from the same tokens, so they line up.
  bar: {
    gridArea: "bar",
    display: "grid",
    flexShrink: 0,
    height: size.bar,
    minWidth: 0,
    backgroundColor: colors.surface,
    // A line inside the box, which the tab strip stops above.
    boxShadow: `inset 0 -1px 0 ${colors.border}`,
    color: colors.text,
    fontFamily: fonts.sans,
    userSelect: "none",
  },
  columns: { gridTemplateColumns: `${size.left} minmax(0, 1fr)` },
  // Over the designs list, which scrolls under it.
  sticky: { position: "sticky", top: 0, zIndex: 1 },
  hidden: { display: "none" },
  column: {
    display: "flex",
    alignItems: "center",
    minWidth: 0,
    // Stops 1px short of the bar's bottom line, which runs under it.
    height: "calc(100% - 1px)",
    borderRightWidth: 1,
    borderRightStyle: "solid",
    borderRightColor: colors.border,
  },
  history: {
    justifyContent: "flex-end",
    paddingLeft: space.sm,
    paddingRight: space.sm,
  },
  macApp: { paddingLeft: MAC_BUTTONS },
  main: {
    display: "flex",
    alignItems: "center",
    gap: space.xs,
    minWidth: 0,
    paddingInline: space.sm,
  },
  strip: {
    // The tabs' offsetParent, so their offsetLeft is within the strip.
    position: "relative",
    display: "flex",
    alignItems: "center",
    flexGrow: 0,
    flexShrink: 1,
    minWidth: 0,
    // Above the bar's bottom line, so the 27px tabs center on whole pixels.
    height: "calc(100% - 1px)",
    alignSelf: "flex-start",
    // Room for the raised tab's outline and drop, which draw outside its box
    // and the scroller would clip; the margin keeps the tabs where they were.
    paddingInline: 2,
    marginInline: -2,
    overflowX: "auto",
    overflowY: "hidden",
    scrollbarWidth: "none",
  },
  // Where tabs are cut off, the strip fades out over 18px.
  fadeStart: { maskImage: "linear-gradient(90deg, transparent, black 18px)" },
  fadeEnd: { maskImage: "linear-gradient(90deg, black calc(100% - 18px), transparent)" },
  fadeBoth: {
    maskImage:
      "linear-gradient(90deg, transparent, black 18px, black calc(100% - 18px), transparent)",
  },
  tab: {
    position: "relative",
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    // As wide as the name, up to 210px; past that it truncates. Tabs never
    // squeeze: when they don't fit, the strip scrolls.
    flexGrow: 0,
    flexShrink: 0,
    flexBasis: "auto",
    minWidth: 60,
    maxWidth: 210,
    height: size.sm,
    paddingInline: space.md,
    borderRadius: radii.sm,
    fontSize: 13,
    fontWeight: 500,
    lineHeight: "16px",
    whiteSpace: "nowrap",
    cursor: "var(--cursor-pointer, pointer)",
    outline: { default: "none", ":focus-visible": `1px solid ${colors.brand}` },
    outlineOffset: -1,
  },
  // The raised button face (`raised.control`), like the picked rail tool.
  active: {
    paddingRight: space.sm,
    color: colors.text,
  },
  inactive: {
    backgroundColor: {
      default: "transparent",
      ":hover": colors.hoverFill,
    },
    color: { default: colors.muted, ":hover": colors.text },
    transitionProperty: "background-color, color",
    transitionDuration: motion.fast,
    transitionTimingFunction: "ease",
  },
  name: {
    flexGrow: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  // An inactive tab's × shows over the end of its name, which fades under it, so the tab keeps its width.
  nameUnderClose: {
    maskImage: {
      default: "none",
      [stylex.when.ancestor(":hover")]:
        "linear-gradient(90deg, black calc(100% - 15px), transparent calc(100% - 3px))",
    },
  },
  unnamed: { color: colors.faint },
  status: {
    display: "grid",
    placeItems: "center",
    flexShrink: 0,
    width: 11,
    height: 11,
  },
  spinner: {
    width: 11,
    height: 11,
    borderRadius: "50%",
    borderWidth: 1.5,
    borderStyle: "solid",
    borderColor: `color-mix(in srgb, ${colors.muted} 35%, transparent)`,
    borderTopColor: colors.muted,
    animationName: { default: spin, "@media (prefers-reduced-motion: reduce)": breathe },
    animationDuration: { default: "700ms", "@media (prefers-reduced-motion: reduce)": "1.6s" },
    animationTimingFunction: "linear",
    animationIterationCount: "infinite",
  },
  // The brand cyan, the one color in the bar: #95ced7 in dark mode, and the
  // deeper cyan in light mode, where the pale one is a faint speck on the bar.
  dot: {
    width: 6,
    height: 6,
    borderRadius: "50%",
    backgroundColor: colors.brand,
  },
  close: {
    display: "grid",
    placeItems: "center",
    flexShrink: 0,
    width: 15,
    height: 18,
    padding: 0,
    borderWidth: 0,
    backgroundColor: "transparent",
    color: { default: colors.muted, ":hover": colors.text },
    cursor: "var(--cursor-pointer, pointer)",
    transitionProperty: "opacity, color",
    transitionDuration: motion.fast,
    transitionTimingFunction: "ease",
    outline: { default: "none", ":focus-visible": `1px solid ${colors.brand}` },
  },
  closeInline: { opacity: 1 },
  // Over the inactive tab's right padding, shown on hover.
  closeOver: {
    position: "absolute",
    right: space.xs,
    top: "50%",
    transform: "translateY(-50%)",
    opacity: {
      default: 0,
      [stylex.when.ancestor(":hover")]: 1,
      ":focus-visible": 1,
    },
  },
  spacer: { flexGrow: 1, minWidth: space.md },
  actions: {
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    flexShrink: 0,
  },
});
