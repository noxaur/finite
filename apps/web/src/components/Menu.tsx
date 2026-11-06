"use client";

import * as stylex from "@stylexjs/stylex";
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { colors, fonts, radii, shadows, size, space } from "@/styles/tokens.stylex";
import { Icon, type IconName } from "./Icons";

export interface MenuItem {
  readonly key: string;
  readonly label: string;
  readonly note?: string | undefined;
  readonly icon?: IconName;
  readonly swatch?: React.CSSProperties | undefined;
  readonly separator?: boolean;
  /** Marks the current choice with a check; any item with it makes the menu a list of choices. */
  readonly checked?: boolean;
  readonly run: () => void;
}

/** Room kept between a menu and the window's edge. */
const EDGE = 6;

/**
 * The app's own menu, as every dropdown opens it: a list under `anchor`
 * (above it when there's no room), where arrow keys move, Enter picks,
 * typing a letter jumps to the item that starts with it, and Escape, a
 * press outside, a scroll or Tab closes it. `trigger` is the button that
 * opened it; a press on that is the button's own, and focus goes back to
 * it when the menu closes from the keyboard or with a pick.
 */
export function Menu({
  title,
  items,
  empty = "",
  anchor,
  trigger,
  align = "right",
  matchWidth = false,
  onClose,
}: {
  title: string;
  items: ReadonlyArray<MenuItem>;
  /** What the menu says when `items` has none. */
  empty?: string;
  anchor: HTMLElement;
  trigger: HTMLElement | null;
  /** Which edge of `anchor` the menu lines up with. */
  align?: "left" | "right";
  /** The menu is at least as wide as `anchor`. */
  matchWidth?: boolean;
  onClose: () => void;
}) {
  const list = useRef<HTMLDivElement>(null);
  const typed = useRef({ text: "", at: 0 });
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);
  const [minWidth] = useState(() =>
    matchWidth ? Math.max(anchor.getBoundingClientRect().width, 120) : undefined,
  );
  const close = useRef(onClose);
  close.current = onClose;
  const choices = items.some((i) => i.checked !== undefined);

  // Measured once it's drawn, so it can open upward or slide back into the window.
  useLayoutEffect(() => {
    const menu = list.current;
    if (!menu) return;
    const a = anchor.getBoundingClientRect();
    const w = menu.offsetWidth;
    const h = menu.offsetHeight;
    const left = align === "right" ? a.right - w : a.left;
    const below = window.innerHeight - a.bottom - EDGE;
    const top = h > below && a.top > below ? a.top - h - 2 : a.bottom + 2;
    setAt({
      left: Math.max(EDGE, Math.min(left, window.innerWidth - w - EDGE)),
      top: Math.max(EDGE, Math.min(top, window.innerHeight - h - EDGE)),
    });
  }, [anchor, align]);

  const buttons = () => [
    ...(list.current?.querySelectorAll<HTMLElement>("[role^='menuitem']") ?? []),
  ];
  // Focus waits for the menu to be placed: a hidden one can't take it.
  const placed = at !== null;
  useEffect(() => {
    if (!placed) return;
    const current = list.current?.querySelector<HTMLElement>("[aria-checked='true']");
    (current ?? buttons()[0] ?? list.current)?.focus();
  }, [placed]);
  useEffect(() => {
    const away = (e: PointerEvent) => {
      const target = e.target as globalThis.Node | null;
      if (!list.current?.contains(target) && !trigger?.contains(target)) close.current();
    };
    // Escape closes the menu and nothing else, so the selection stays.
    const escape = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      trigger?.focus();
      close.current();
    };
    const leave = (e: Event) => {
      if (!list.current?.contains(e.target as globalThis.Node | null)) close.current();
    };
    window.addEventListener("pointerdown", away, true);
    window.addEventListener("keydown", escape, true);
    window.addEventListener("scroll", leave, true);
    window.addEventListener("resize", leave);
    return () => {
      window.removeEventListener("pointerdown", away, true);
      window.removeEventListener("keydown", escape, true);
      window.removeEventListener("scroll", leave, true);
      window.removeEventListener("resize", leave);
    };
    // The trigger and what's listed are fixed while it's open.
  }, []);

  const move = (e: React.KeyboardEvent) => {
    const all = buttons();
    const now = all.indexOf(document.activeElement as HTMLElement);
    let to: number | null = null;
    if (e.key === "ArrowDown") to = (now + 1) % all.length;
    else if (e.key === "ArrowUp") to = (now <= 0 ? all.length : now) - 1;
    else if (e.key === "Home") to = 0;
    else if (e.key === "End") to = all.length - 1;
    else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey && e.key !== " ") {
      const t = typed.current;
      const text = e.timeStamp - t.at < 700 ? t.text + e.key.toLowerCase() : e.key.toLowerCase();
      typed.current = { text, at: e.timeStamp };
      // The same letter again goes on to the next item that starts with it.
      const again = text.split("").every((c) => c === text[0]);
      const word = again ? text[0]! : text;
      const from = again ? now + 1 : Math.max(now, 0);
      for (let i = 0; i < all.length; i++) {
        const next = (from + i) % all.length;
        if (all[next]!.textContent?.trim().toLowerCase().startsWith(word)) {
          to = next;
          break;
        }
      }
    }
    // The editor listens to keys on the window; these belong to the menu.
    if (to !== null || e.key === "Enter" || e.key === " ") e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      (document.activeElement as HTMLElement | null)?.click();
    }
    if (to === null) return;
    e.preventDefault();
    all[to]?.focus();
  };

  return createPortal(
    <div
      ref={list}
      role="menu"
      aria-label={title}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === "Tab") return close.current();
        move(e);
      }}
      style={{
        top: at?.top ?? 0,
        left: at?.left ?? 0,
        visibility: at ? "visible" : "hidden",
        minWidth,
      }}
      {...stylex.props(styles.menu)}
    >
      {items.length === 0 && <p {...stylex.props(styles.empty)}>{empty}</p>}
      {items.map((item) =>
        item.separator ? (
          <span key={item.key} role="separator" {...stylex.props(styles.sep)} />
        ) : (
          <button
            key={item.key}
            type="button"
            role={choices ? "menuitemradio" : "menuitem"}
            aria-checked={choices ? !!item.checked : undefined}
            onPointerMove={(e) => e.currentTarget.focus({ preventScroll: true })}
            onClick={() => {
              trigger?.focus();
              close.current();
              item.run();
            }}
            {...stylex.props(styles.item, item.checked && styles.checked)}
          >
            {choices && (
              <span {...stylex.props(styles.check)}>
                {item.checked && <Icon name="check" size={14} />}
              </span>
            )}
            {item.icon && (
              <span {...stylex.props(styles.icon)}>
                <Icon name={item.icon} size={16} />
              </span>
            )}
            {item.swatch && <span {...stylex.props(styles.swatch)} style={item.swatch} />}
            <span {...stylex.props(styles.label)}>{item.label}</span>
            {item.note && <span {...stylex.props(styles.note)}>{item.note}</span>}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}

/**
 * A button that opens the app's menu with one of `options` to pick, as the
 * replacement for the browser's own select menu. What the button looks like is up to
 * `style` and `children`; it has no chrome of its own. `value` is the
 * option that's checked.
 */
export function Dropdown({
  label,
  title = label,
  value,
  options,
  onPick,
  disabled = false,
  align = "left",
  anchor,
  style,
  children,
}: {
  label: string;
  title?: string;
  value: string | null;
  options: ReadonlyArray<readonly [string, string]>;
  onPick: (value: string) => void;
  disabled?: boolean;
  align?: "left" | "right";
  /** The element the menu lines up under, where it isn't the button's own parent. */
  anchor?: () => HTMLElement | null;
  style?: stylex.StyleXArray<stylex.CompiledStyles | null | undefined | boolean>;
  /** What the button shows; a function gets whether the menu is open. */
  children: ReactNode | ((open: boolean) => ReactNode);
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={button}
        type="button"
        title={title}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        {...stylex.props(styles.trigger, style)}
      >
        {typeof children === "function" ? children(open) : children}
      </button>
      {open && button.current && (
        <Menu
          title={label}
          items={options.map(([v, name]) => ({
            key: v,
            label: name,
            checked: v === value,
            run: () => onPick(v),
          }))}
          anchor={anchor?.() ?? button.current.parentElement ?? button.current}
          trigger={button.current}
          align={align}
          matchWidth
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

const styles = stylex.create({
  /** A bare button: the caller gives it a look. */
  trigger: {
    padding: 0,
    borderWidth: 0,
    backgroundColor: "transparent",
    color: "inherit",
    font: "inherit",
    textAlign: "left",
    outline: "none",
    cursor: { default: "var(--cursor-pointer, pointer)", ":disabled": "default" },
  },
  menu: {
    position: "fixed",
    zIndex: 50,
    display: "flex",
    flexDirection: "column",
    minWidth: 183,
    maxWidth: 264,
    maxHeight: 318,
    overflowY: "auto",
    padding: space.xs,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    borderRadius: radii.md,
    backgroundColor: colors.sunk,
    boxShadow: shadows.raised,
    outline: "none",
  },
  item: {
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    height: size.sm,
    flexShrink: 0,
    paddingInline: space.sm,
    borderWidth: 0,
    borderRadius: radii.sm,
    backgroundColor: { default: "transparent", ":focus": colors.borderSoft },
    color: colors.text,
    fontFamily: fonts.sans,
    fontSize: 13,
    lineHeight: "20px",
    textAlign: "left",
    whiteSpace: "nowrap",
    outline: "none",
    cursor: "var(--cursor-pointer, pointer)",
  },
  check: { display: "flex", flexShrink: 0, width: 12, color: colors.brandText },
  checked: { fontWeight: 600 },
  icon: { display: "flex", color: colors.muted },
  swatch: {
    flexShrink: 0,
    width: 12,
    height: 12,
    borderRadius: radii.xs,
    boxShadow: `inset 0 0 0 1px ${colors.borderStrong}`,
  },
  label: { flexGrow: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" },
  note: {
    flexShrink: 0,
    color: colors.faint,
    fontFamily: fonts.sans,
    fontSize: 12,
    lineHeight: "16px",
  },
  sep: {
    flexShrink: 0,
    height: 1,
    marginBlock: space.xs,
    marginInline: `calc(-1 * ${space.xs})`,
    backgroundColor: colors.borderSoft,
  },
  empty: {
    margin: 0,
    padding: space.sm,
    color: colors.muted,
    fontSize: 12,
    lineHeight: "16px",
    whiteSpace: "normal",
  },
});
