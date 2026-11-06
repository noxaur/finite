import * as stylex from "@stylexjs/stylex";
import { motion, size } from "./tokens.stylex";

/**
 * Hide mode's choreography, shared by the canvas and the tool rail. Hiding:
 * the sidebars slide off (240ms) and the rail and the zoom travel to their
 * places on a longer 280ms, so they trail the sidebars out; the panels'
 * faces fade in as they leave the sidebars (140ms, from 20ms). Showing, the
 * rail and the zoom travel home (260ms) a little ahead of the sidebars
 * sliding in behind them (280ms), and their faces fade out as they land
 * (140ms, from 60ms). Every part is a CSS transition of `transform` or
 * `opacity`, and the moves have no delay, so a toggle mid-way turns back at
 * once from where it is. With reduced motion,
 * nothing travels: the sidebars fade, and the rail and the zoom dip out and
 * back in where they land.
 */
const REDUCED = "@media (prefers-reduced-motion: reduce)";
/** On-screen travel: the iOS drawer curve, quick off the mark and long to settle. */
const DRAWER = "cubic-bezier(0.32, 0.72, 0, 1)";
const FADE = "150ms";

const dip = stylex.keyframes({
  "0%": { opacity: 1 },
  "50%": { opacity: 0 },
  "100%": { opacity: 1 },
});
// The same dip under another name, so going back runs it again.
const dipBack = stylex.keyframes({
  "0%": { opacity: 1 },
  "51%": { opacity: 0 },
  "100%": { opacity: 1 },
});

export const hideMode = stylex.create({
  /** A sidebar, or the rail's column, while it's shown: how it slides back in. */
  panel: {
    transitionProperty: { default: "transform", [REDUCED]: "opacity, transform" },
    transitionDuration: { default: "280ms", [REDUCED]: `${FADE}, 0s` },
    transitionDelay: "0s",
    transitionTimingFunction: { default: DRAWER, [REDUCED]: "ease" },
  },
  /** Hidden: it slides off, then stops drawing and taking clicks. */
  panelHidden: {
    visibility: "hidden",
    opacity: { default: 1, [REDUCED]: 0 },
    transitionProperty: {
      default: "transform, visibility",
      [REDUCED]: "opacity, transform, visibility",
    },
    transitionDuration: { default: "240ms, 0s", [REDUCED]: `${FADE}, 0s, 0s` },
    transitionDelay: { default: "0s, 240ms", [REDUCED]: `0s, ${FADE}, ${FADE}` },
    transitionTimingFunction: { default: DRAWER, [REDUCED]: "ease" },
  },
  /** Off the left edge, with the rail: the sidebar and the rail's column move as one. */
  offLeft: { transform: `translateX(calc(-1 * (${size.left} + ${size.rail})))` },
  offRight: { transform: "translateX(100%)" },

  /** Something that travels to a corner, while it's home. */
  travel: {
    transitionProperty: "transform",
    transitionDuration: { default: "260ms", [REDUCED]: "0s" },
    transitionDelay: { default: "0s", [REDUCED]: "100ms" },
    transitionTimingFunction: DRAWER,
  },
  /** Hidden: a longer move than the sidebars', so it trails them out. */
  travelHidden: {
    transitionDuration: { default: "280ms", [REDUCED]: "0s" },
  },
  /** With reduced motion, the traveller dips out and back in instead, over its jump. */
  dip: { animationName: { default: "none", [REDUCED]: dipBack }, animationDuration: "200ms" },
  dipHidden: { animationName: { default: "none", [REDUCED]: dip } },

  /** A floating panel's surface, border and shadow, faded out while it's docked. */
  face: {
    opacity: 0,
    transitionProperty: "opacity",
    transitionDuration: { default: "140ms", [REDUCED]: FADE },
    transitionDelay: { default: "60ms", [REDUCED]: "0s" },
    transitionTimingFunction: motion.out,
  },
  faceShown: {
    opacity: 1,
    transitionDuration: { default: "140ms", [REDUCED]: FADE },
    transitionDelay: { default: "20ms", [REDUCED]: "0s" },
  },

  /** On load and for ⌘\: everything at once. */
  instant: { transitionProperty: "none", animationName: "none" },
});
