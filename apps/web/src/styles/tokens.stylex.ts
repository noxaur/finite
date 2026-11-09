import * as stylex from "@stylexjs/stylex";

const DARK = "@media (prefers-color-scheme: dark)";

// The brand's grays carry a faint cool tint (a third of the chroma of the old blue-charcoal), and nothing is pure white or black:
// slate-0 is the lightest and slate-900 the darkest. The dark end is the approved
// button palette (components › Finite buttons in the brand design).
const slate = {
  0: "#f8f9f9",
  50: "#f0f1f2",
  100: "#e6e8e9",
  200: "#d5d8d9",
  300: "#babec1",
  400: "#969a9d",
  500: "#74797d",
  600: "#5b6064",
  700: "#44494d",
  750: "#3c4145",
  800: "#2a2e31",
  850: "#202426",
  900: "#171a1c",
};

/** The brand cyan, the one saturated color in an otherwise gray palette. */
const cyan = {
  hover: "#a3d8e0",
  top: "#95ced7",
  bottom: "#8bc8d1",
  pressed: "#83bec8",
  /** Cyan deep enough to read as text and lines on the light theme. */
  deep: "#2c7a87",
  /** Text and icons on a cyan face. */
  on: "#0b161b",
};

export const colors = stylex.defineVars({
  bg: { default: slate[50], [DARK]: slate[850] },
  surface: { default: slate[0], [DARK]: slate[800] },
  /** Pressed controls, the current row, and fields. */
  sunk: { default: slate[100], [DARK]: slate[900] },
  /** Behind artboards on the canvas. */
  canvas: { default: slate[100], [DARK]: "#121416" },
  /** Deliberately softer than white or black: a faintly cool off-white in dark mode, a charcoal in light. */
  text: { default: "#2a2f32", [DARK]: "#d8dbdc" },
  muted: { default: slate[600], [DARK]: "#aaaeb0" },
  faint: { default: slate[500], [DARK]: "#878b8f" },
  border: { default: slate[300], [DARK]: slate[700] },
  /** Rules between sections inside one panel. */
  borderSoft: { default: slate[200], [DARK]: "#34393c" },
  borderStrong: { default: slate[400], [DARK]: "#696f73" },
  /**
   * State fills for rows and items, laid over whatever is behind them, so they work on
   * `surface`, `bg` and `sunk` alike. `hoverFill` is the row under the pointer;
   * `activeFill`, a step stronger, is the selected, current or checked one, and stays
   * put while it's hovered. Both are neutral: text on them stays `text`. Dark mode lifts
   * the row toward the text color; light mode can't go lighter than `surface`, so it
   * shades toward ink instead, the gentlest step that still reads.
   */
  hoverFill: { default: "rgba(23, 26, 28, 0.05)", [DARK]: "rgba(216, 219, 220, 0.06)" },
  activeFill: { default: "rgba(23, 26, 28, 0.08)", [DARK]: "rgba(216, 219, 220, 0.1)" },
  /** Filled controls, like the active tool: the brand cyan face. */
  accent: cyan.top,
  /** Text and icons on an accent background. */
  onAccent: cyan.on,
  /** The brand cyan: tokens, focus, drop targets. Selection in the panels is `activeFill`. */
  brand: { default: cyan.deep, [DARK]: cyan.top },
  brandText: { default: cyan.deep, [DARK]: cyan.top },
  brandWash: { default: "#e0ecef", [DARK]: "#29383e" },
  /** Lines drawn over artboard content, on a `halo`, so they read on any artboard in either theme. */
  ink: slate[900],
  halo: slate[0],
  /** The outline on the selection and the node under the pointer, and the selection's corner marks. */
  hover: "#3a9fb0",
  ok: { default: "#15803d", [DARK]: "#4ade80" },
  danger: { default: "#b8341f", [DARK]: "#f0806c" },
  /** The Measure tool's drawing and card, over artboards in either theme. Equals `MEASURE_PURPLE`. */
  measure: "#8b3ff0",
  /** Claude's asterisk mark, next to the model's name in the composer. */
  claude: "#d97757",
  /** The floating composer's card: a step darker than the canvas around it. */
  composer: { default: slate[0], [DARK]: "#17191b" },
  /** Components and their instances on the canvas. */
  component: { default: "#7c3aed", [DARK]: "#a78bfa" },
  /** Text on a `component` fill. */
  onComponent: { default: slate[0], [DARK]: slate[900] },
});

/**
 * The faces of raised controls: a matte top-to-bottom gradient, a hairline highlight
 * on the top edge, a 1px outline and a soft drop. `raised.ts` puts them together.
 */
export const face = stylex.defineVars({
  top: { default: "#fbfbfb", [DARK]: slate[750] },
  bottom: { default: slate[50], [DARK]: "#303437" },
  hoverTop: { default: "#fcfdfd", [DARK]: "#4b5155" },
  hoverBottom: { default: "#f4f5f5", [DARK]: "#484e52" },
  pressedTop: { default: "#e3e5e6", [DARK]: "#2f3438" },
  pressed: { default: slate[100], [DARK]: "#33383c" },
  brandTop: cyan.top,
  brandBottom: cyan.bottom,
  brandHover: cyan.hover,
  brandPressed: cyan.pressed,
  disabled: { default: slate[100], [DARK]: "#373c40" },
  disabledText: { default: slate[400], [DARK]: "#a2a6a9" },
});

/** Spacing steps, all multiples of a 3px unit: 1u, 2u, 3u, 4u, 6u, 10u. */
export const space = stylex.defineVars({
  px: "3px",
  xs: "3px",
  sm: "6px",
  ms: "9px",
  md: "12px",
  lg: "18px",
  xl: "30px",
});

/** Control and row heights. */
export const size = stylex.defineVars({
  xs: "24px",
  sm: "27px",
  md: "36px",
  lg: "42px",
  /** The sidebars and the tool rail. */
  left: "246px",
  /** 27px tools, 6px from each edge. */
  rail: "39px",
  right: "303px",
  /** The window's top row, the tab bar: room for macOS's window buttons in the desktop app. */
  bar: "42px",
});

/** A container's radius is its items' radius plus its padding, so nested corners stay concentric. */
export const radii = stylex.defineVars({
  xs: "3px",
  sm: "3px",
  /** Around 3px-radius items with 3px padding. */
  md: "6px",
  /** Around 3px-radius items with 6px padding. */
  lg: "9px",
});

export const fonts = stylex.defineVars({
  sans: "'Helvetica Neue', Helvetica, Arial, sans-serif",
  mono: "'JetBrains Mono', ui-monospace, monospace",
});

export const shadows = stylex.defineVars({
  /** An even press-in on every edge, for pressed and selected controls. */
  inset: {
    default: "inset 0 1px 1px rgba(23, 26, 28, 0.08), inset 0 0 0 1px rgba(23, 26, 28, 0.12)",
    [DARK]: "inset 0 1px 1px rgba(6, 7, 8, 0.2), inset 0 0 0 1px rgba(6, 7, 8, 0.35)",
  },
  /** A 1px line drawn inside a control's edge, which takes no room. */
  edge: `inset 0 0 0 1px ${colors.borderStrong}`,
  /** A 2px brand line inside a row's edge: what a drag would drop into. */
  target: `inset 0 0 0 2px ${colors.brand}`,
  raised: {
    default: "0 9px 24px rgba(23, 26, 28, 0.12), 0 2px 6px rgba(23, 26, 28, 0.08)",
    [DARK]: "0 9px 24px rgba(6, 7, 8, 0.34), 0 2px 6px rgba(6, 7, 8, 0.2)",
  },
  /** A raised control at rest: top highlight, 1px outline, soft drop. */
  control: {
    default:
      "inset 0 .5px 0 rgba(251, 252, 252, 0.9), 0 0 0 1px rgba(23, 26, 28, 0.16), 0 1px 1.5px rgba(23, 26, 28, 0.12)",
    [DARK]:
      "inset 0 .5px 0 rgba(225, 232, 235, 0.15), 0 0 0 1px rgba(187, 196, 201, 0.2), 0 1px 1.5px rgba(6, 7, 8, 0.2)",
  },
  controlHover: {
    default:
      "inset 0 .5px 0 rgba(251, 252, 252, 0.9), 0 0 0 1px rgba(23, 26, 28, 0.22), 0 1px 1.5px rgba(23, 26, 28, 0.12)",
    [DARK]:
      "inset 0 .5px 0 rgba(225, 232, 235, 0.15), 0 0 0 1px rgba(197, 206, 211, 0.27), 0 1px 1.5px rgba(6, 7, 8, 0.2)",
  },
  /** Held down, or on: pressed in, with no drop. */
  controlPressed: {
    default: "inset 0 1px 1px rgba(23, 26, 28, 0.1), 0 0 0 1px rgba(23, 26, 28, 0.14)",
    [DARK]:
      "inset 0 1px 1px rgba(6, 7, 8, 0.07), inset 0 .5px 0 rgba(225, 232, 235, 0.08), 0 0 0 1px rgba(187, 196, 201, 0.15)",
  },
  controlBrand: {
    default:
      "inset 0 .5px 0 rgba(240, 252, 255, 0.5), 0 0 0 1px rgba(44, 122, 135, 0.45), 0 1px 1.5px rgba(23, 26, 28, 0.14)",
    [DARK]:
      "inset 0 .5px 0 rgba(240, 252, 255, 0.35), 0 0 0 1px rgba(149, 206, 215, 0.35), 0 1px 1.5px rgba(6, 7, 8, 0.2)",
  },
  controlBrandPressed: {
    default: "inset 0 1px 1px rgba(23, 26, 28, 0.12), 0 0 0 1px rgba(44, 122, 135, 0.45)",
    [DARK]: "inset 0 1px 1px rgba(6, 7, 8, 0.07), 0 0 0 1px rgba(149, 206, 215, 0.35)",
  },
  /** A field: sunk, with a soft press-in at the top. */
  field: {
    default: "inset 0 1px 1px rgba(23, 26, 28, 0.08), inset 0 0 0 1px rgba(23, 26, 28, 0.1)",
    [DARK]: "inset 0 1px 1px rgba(6, 7, 8, 0.16), inset 0 0 0 1px rgba(187, 196, 201, 0.08)",
  },
});

/** Outlines, for focus and for what is open. */
export const outlines = stylex.defineVars({
  focus: `2px solid ${colors.brand}`,
});

export const motion = stylex.defineVars({
  fast: "150ms",
  base: "200ms",
  out: "cubic-bezier(.23, 1, .32, 1)",
});

/** Pointer images, for what a plain `cursor` keyword can't say. */
export const cursors = stylex.defineVars({
  /** Two arrowheads, ◀ ▶, touching: over a number that scrubs. DraftField draws the same pair, apart, while it's held. */
  scrub:
    "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24'%3E%3Cpath d='M10.25 6.5 3.5 12l6.75 5.5ZM13.75 6.5l6.75 5.5-6.75 5.5Z' fill='%23f8f9f9' stroke='%23171a1c' stroke-width='1.5' stroke-linejoin='round'/%3E%3C/svg%3E\") 12 12, ew-resize",
});
