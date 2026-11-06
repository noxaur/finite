"use client";

import * as stylex from "@stylexjs/stylex";
import {
  Children,
  createContext,
  Fragment,
  isValidElement,
  type ComponentPropsWithRef,
  type ReactElement,
  type ReactNode,
  useContext,
} from "react";
import { raised, strip } from "@/styles/raised";
import { colors, fonts, radii, size, space } from "@/styles/tokens.stylex";
import type { IconName } from "@/lib/icons";
import { Icon } from "./Icons";

/**
 * The app's two control heights. `regular` (27px) is for inspector rows, fields, strips
 * in panels, dialogs and the title bar; `small` (24px) is for compact headers and rows.
 */
export type ButtonSize = "regular" | "small";

/** `control` is the plain raised face, `brand` the cyan primary, `ghost` no face until hovered. */
export type ButtonVariant = "control" | "brand" | "ghost";

/**
 * What a caller may set on a button or strip: where it sits (margin, flex, alignment,
 * width) and its text color. Never its height, padding, type or corners, which come
 * from `size`, so every control of one size matches.
 */
export type LayoutStyle = stylex.StyleXStylesWithout<{
  height: null;
  minHeight: null;
  maxHeight: null;
  padding: null;
  paddingInline: null;
  paddingBlock: null;
  paddingLeft: null;
  paddingRight: null;
  paddingTop: null;
  paddingBottom: null;
  font: null;
  fontFamily: null;
  fontSize: null;
  fontWeight: null;
  lineHeight: null;
  borderRadius: null;
}>;

/** The one icon size inside buttons and strips. */
const ICON = 15;

/**
 * A button's whole look, for an element that isn't a `<Button>` but must match one: a
 * `Dropdown` trigger, or an `<a download>` that acts as a button.
 */
export function buttonStyle({
  variant = "control",
  size = "regular",
  square = false,
  pressed = false,
  picked = false,
  disabled = false,
}: {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** An icon button: as wide as it's tall. */
  square?: boolean;
  /** Held on, or open: the pressed-in face. */
  pressed?: boolean;
  /** The chosen one of a set, like the current tool: a ghost takes the resting raised face. */
  picked?: boolean;
  disabled?: boolean;
}) {
  return [
    styles.base,
    variant === "ghost" ? raised.ghost : raised.control,
    variant === "brand" && raised.brand,
    picked && raised.control,
    styles[size],
    square && (size === "regular" ? styles.squareRegular : styles.squareSmall),
    pressed && raised.on,
    pressed && styles.pressed,
    disabled && (variant === "ghost" ? styles.ghostDisabled : raised.disabled),
  ] as const;
}

type ButtonProps = Omit<ComponentPropsWithRef<"button">, "style" | "className"> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** An icon before the label. */
  icon?: IconName;
  /** Held on, like a toggle: the pressed-in face, and `aria-pressed`. */
  pressed?: boolean | undefined;
  /**
   * The menu, popover or panel it opens is open: the pressed-in face, and `aria-expanded`
   * (never `aria-pressed`), for a disclosure button.
   */
  expanded?: boolean | undefined;
  /**
   * The chosen one of a set, like the current tool: the resting raised face, on a ghost
   * too. It says nothing to screen readers, so the caller sets `aria-pressed` or `aria-checked`.
   */
  picked?: boolean | undefined;
  style?: LayoutStyle;
};

/** A text button, optionally with a leading icon. */
export function Button({
  variant = "control",
  size = "regular",
  icon,
  pressed,
  expanded,
  picked,
  disabled,
  style,
  type = "button",
  children,
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      aria-pressed={pressed}
      aria-expanded={expanded}
      disabled={disabled}
      {...props}
      {...stylex.props(
        ...buttonStyle({
          variant,
          size,
          pressed: !!pressed || !!expanded,
          picked: !!picked,
          disabled: !!disabled,
        }),
        style,
      )}
    >
      {icon && <Icon name={icon} size={ICON} />}
      {children}
    </button>
  );
}

/**
 * A square button that shows only an icon. `label` names it for screen readers and,
 * unless `title` says more, in its tooltip. `icon` is an icon's name, or a glyph where
 * the icon set has none yet.
 */
export function IconButton({
  icon,
  label,
  title = label,
  variant = "control",
  size = "regular",
  pressed,
  expanded,
  picked,
  disabled,
  style,
  type = "button",
  ...props
}: Omit<ButtonProps, "icon" | "children"> & {
  icon: IconName | ReactElement;
  label: string;
}) {
  return (
    <button
      type={type}
      aria-label={label}
      title={title}
      aria-pressed={pressed}
      aria-expanded={expanded}
      disabled={disabled}
      {...props}
      {...stylex.props(
        ...buttonStyle({
          variant,
          size,
          square: true,
          pressed: !!pressed || !!expanded,
          picked: !!picked,
          disabled: !!disabled,
        }),
        style,
      )}
    >
      {typeof icon === "string" ? <Icon name={icon} size={ICON} /> : icon}
    </button>
  );
}

/** What a strip's items are, so each item takes the matching role and state. */
type StripRoleName = "tablist" | "radiogroup" | "group";

const StripRole = createContext<{ role: StripRoleName; size: ButtonSize }>({
  role: "tablist",
  size: "regular",
});

/** How many items a strip has, looking through fragments, so `<>a b</>` counts as two. */
function countItems(node: ReactNode): number {
  return Children.toArray(node).reduce<number>(
    (n, child) =>
      n +
      (isValidElement<{ children?: ReactNode }>(child) && child.type === Fragment
        ? countItems(child.props.children)
        : 1),
    0,
  );
}

/**
 * A row of choices in a sunk track, like tabs or a segmented control. Its items
 * (`StripItem`) fill its height and share its width. A slim strip packs them edge to
 * edge; a wider one parts them by a gap that grows with its width, more for two items
 * than for three or more. With `actions` (`StripAction`s after the items), the items
 * scroll when they don't fit, and only they carry `role`.
 */
export function Strip({
  role,
  size = "regular",
  actions,
  style,
  children,
  ...props
}: Omit<ComponentPropsWithRef<"div">, "role" | "style" | "className"> & {
  /** `group` is a strip of `StripAction`s only, like rotate and flip. */
  role: StripRoleName;
  size?: ButtonSize;
  actions?: ReactNode;
  style?: LayoutStyle;
}) {
  const gap = countItems(children) + countItems(actions) > 2 ? styles.gapMany : styles.gapTwo;
  const track = [strip.track, size === "regular" ? styles.regularTrack : styles.smallTrack, gap];
  const items = (
    <StripRole value={{ role, size }}>
      {actions ? (
        <div role={role} {...props} {...stylex.props(strip.scroll, gap)}>
          {children}
        </div>
      ) : (
        children
      )}
      {actions}
    </StripRole>
  );
  return actions ? (
    <div {...stylex.props(...track, style)}>{items}</div>
  ) : (
    <div role={role} {...props} {...stylex.props(...track, style)}>
      {items}
    </div>
  );
}

/**
 * One choice in a `Strip`: flat and muted, and raised when `picked`. It takes the role
 * its strip's items have (tab or radio) and says whether it's picked the matching way.
 */
export function StripItem({
  picked,
  icon,
  style,
  type = "button",
  children,
  ...props
}: Omit<ComponentPropsWithRef<"button">, "style" | "className"> & {
  picked: boolean;
  /** An icon before the label, or in place of it. */
  icon?: IconName | undefined;
  style?: LayoutStyle;
}) {
  const { role } = useContext(StripRole);
  return (
    <button
      type={type}
      {...(role === "tablist"
        ? { role: "tab", "aria-selected": picked }
        : role === "radiogroup"
          ? { role: "radio", "aria-checked": picked }
          : { "aria-pressed": picked })}
      {...props}
      {...stylex.props(strip.item, styles.stripItem, picked && strip.picked, style)}
    >
      {icon && <Icon name={icon} size={ICON} />}
      {children}
    </button>
  );
}

/**
 * An icon button in a `Strip`, like + or −: square at the strip's end, or with `grow`,
 * sharing the strip's width with the others. It looks pressed only while held, and
 * raised while `picked`, like a flip that's on; the caller says so with `aria-pressed`.
 */
export function StripAction({
  icon,
  label,
  title = label,
  picked = false,
  grow = false,
  style,
  type = "button",
  ...props
}: Omit<ComponentPropsWithRef<"button">, "style" | "className" | "children"> & {
  icon: IconName;
  label: string;
  picked?: boolean;
  grow?: boolean;
  style?: LayoutStyle;
}) {
  const { size } = useContext(StripRole);
  return (
    <button
      type={type}
      aria-label={label}
      title={title}
      {...props}
      {...stylex.props(
        strip.item,
        styles.stripItem,
        strip.action,
        size === "regular" ? styles.squareRegular : styles.squareSmall,
        grow && styles.grow,
        picked && strip.picked,
        style,
      )}
    >
      <Icon name={icon} size={ICON} />
    </button>
  );
}

const styles = stylex.create({
  base: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: space.sm,
    flexShrink: 0,
    boxSizing: "border-box",
    margin: 0,
    borderRadius: radii.sm,
    fontFamily: fonts.sans,
    fontSize: 12,
    fontWeight: 500,
    lineHeight: "15px",
    whiteSpace: "nowrap",
    textDecoration: "none",
    cursor: { default: "var(--cursor-pointer, pointer)", ":disabled": "default" },
    outline: { default: "none", ":focus-visible": `1px solid ${colors.brand}` },
    outlineOffset: 2,
  },
  regular: { height: size.sm, paddingInline: space.md },
  small: { height: size.xs, paddingInline: space.ms },
  squareRegular: { width: size.sm, minWidth: size.sm, paddingInline: 0 },
  squareSmall: { width: size.xs, minWidth: size.xs, paddingInline: 0 },
  ghostDisabled: {
    backgroundColor: "transparent",
    color: colors.faint,
    cursor: "default",
  },
  pressed: { color: colors.text },
  /** The strip's label type, set here too so it holds wherever `strip.item` drifts. */
  stripItem: { fontSize: 12, fontWeight: 500, lineHeight: "15px" },
  /** A `StripAction` that shares the strip's width, like the items. */
  grow: { flexGrow: 1, flexBasis: 0, width: "auto", minWidth: 0 },
  regularTrack: { height: size.sm },
  smallTrack: { height: size.xs },
  /**
   * A gap that grows with the strip's width (a `%` gap resolves against it), on whole
   * pixels so edges stay crisp: two items part by 3% up to 6px, three or more by 2%
   * up to 3px, so a slim strip keeps its items edge to edge.
   */
  gapTwo: { columnGap: "clamp(0px, round(down, 3%, 1px), 6px)" },
  gapMany: { columnGap: "clamp(0px, round(down, 2%, 1px), 3px)" },
});
