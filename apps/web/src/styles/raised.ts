import * as stylex from "@stylexjs/stylex";
import { colors, face, fonts, radii, shadows, space } from "./tokens.stylex";

/**
 * The approved Finite button look, for any control that presses: `control` is the
 * plain face, `brand` the cyan primary, and `on` a control that's held or toggled on.
 * Put `on` after the face so it wins.
 */
export const raised = stylex.create({
  control: {
    borderWidth: 0,
    backgroundImage: {
      default: `linear-gradient(180deg, ${face.top}, ${face.bottom})`,
      ":hover": `linear-gradient(180deg, ${face.hoverTop}, ${face.hoverBottom})`,
      ":active": `linear-gradient(180deg, ${face.pressedTop}, ${face.pressed})`,
    },
    boxShadow: {
      default: shadows.control,
      ":hover": shadows.controlHover,
      ":active": shadows.controlPressed,
    },
    color: colors.text,
  },
  brand: {
    borderWidth: 0,
    backgroundImage: {
      default: `linear-gradient(180deg, ${face.brandTop}, ${face.brandBottom})`,
      ":hover": `linear-gradient(180deg, ${face.brandHover}, ${face.brandTop})`,
      ":active": `linear-gradient(180deg, ${face.brandPressed}, ${face.brandPressed})`,
    },
    boxShadow: { default: shadows.controlBrand, ":active": shadows.controlBrandPressed },
    color: colors.onAccent,
  },
  on: {
    backgroundImage: {
      default: `linear-gradient(180deg, ${face.pressedTop}, ${face.pressed})`,
      ":hover": `linear-gradient(180deg, ${face.pressedTop}, ${face.pressed})`,
    },
    boxShadow: { default: shadows.controlPressed, ":hover": shadows.controlPressed },
  },
  /**
   * No face, so a row of them stays quiet: the neutral `hoverFill` under the pointer and
   * `activeFill` while held, like the rows and tools around it. The app's one ghost look,
   * for `<Button variant="ghost">` and the small buttons inside fields alike.
   */
  ghost: {
    borderWidth: 0,
    backgroundColor: {
      default: "transparent",
      ":hover": colors.hoverFill,
      ":active": colors.activeFill,
    },
    backgroundImage: "none",
    boxShadow: "none",
    color: { default: colors.muted, ":hover": colors.text },
  },
  disabled: {
    backgroundImage: "none",
    backgroundColor: face.disabled,
    boxShadow: shadows.controlPressed,
    color: face.disabledText,
    cursor: "default",
  },
});

/**
 * A strip's parts: a row of choices, like tabs or a segmented control, in a sunk `track`.
 * Items are flat and muted, with no hover effect, and fill the track's height and the
 * track's width between them. Only the picked item (`strip.picked`) looks like a raised
 * button, with its outline inside its own box. `strip.action` is a fixed-width item, like
 * +, that looks pressed only while it's held down. A strip with more items than fit
 * scrolls them inside `strip.scroll`. The track's height and an action's width come from
 * the size `<Strip>` is given, so build strips with it, not with these alone.
 */
export const strip = stylex.create({
  track: {
    display: "flex",
    flexShrink: 0,
    minWidth: 0,
    backgroundColor: colors.sunk,
    boxShadow: shadows.field,
    borderRadius: radii.sm,
  },
  scroll: {
    display: "flex",
    flexGrow: 1,
    minWidth: 0,
    overflowX: "auto",
    scrollbarWidth: "none",
  },
  item: {
    flexGrow: 1,
    flexBasis: 0,
    minWidth: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: space.sm,
    height: "100%",
    padding: 0,
    borderWidth: 0,
    borderRadius: radii.sm,
    backgroundColor: "transparent",
    backgroundImage: "none",
    boxShadow: "none",
    color: colors.muted,
    fontFamily: fonts.sans,
    fontSize: 12,
    fontWeight: 500,
    lineHeight: "15px",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    cursor: "var(--cursor-pointer, pointer)",
    outline: { default: "none", ":focus-visible": `1px solid ${colors.brand}` },
    outlineOffset: -1,
  },
  /**
   * The picked item: the raised button face, with its outline inside. No hover change.
   * The shadow is `shadows.control` with the outline drawn inside the box (`inset 0 0 0 1px`
   * instead of the outer spread) and no drop, so the item never reaches past the strip.
   * The colors are the same as in `tokens.stylex.ts`.
   */
  picked: {
    backgroundImage: `linear-gradient(180deg, ${face.top}, ${face.bottom})`,
    boxShadow: {
      default: "inset 0 .5px 0 rgba(251, 252, 252, 0.9), inset 0 0 0 1px rgba(23, 26, 28, 0.16)",
      "@media (prefers-color-scheme: dark)":
        "inset 0 .5px 0 rgba(225, 232, 235, 0.15), inset 0 0 0 1px rgba(187, 196, 201, 0.2)",
    },
    color: colors.text,
  },
  /** A fixed-width item, like +, flat until it's pressed, then `shadows.controlPressed` with its outline inside. */
  action: {
    flexGrow: 0,
    flexBasis: "auto",
    backgroundImage: {
      default: "none",
      ":active": `linear-gradient(180deg, ${face.pressedTop}, ${face.pressed})`,
    },
    boxShadow: {
      default: "none",
      ":active": {
        default: "inset 0 1px 1px rgba(23, 26, 28, 0.1), inset 0 0 0 1px rgba(23, 26, 28, 0.14)",
        "@media (prefers-color-scheme: dark)":
          "inset 0 1px 1px rgba(6, 7, 8, 0.07), inset 0 .5px 0 rgba(225, 232, 235, 0.08), inset 0 0 0 1px rgba(187, 196, 201, 0.15)",
      },
    },
    color: { default: colors.muted, ":active": colors.text },
  },
});
