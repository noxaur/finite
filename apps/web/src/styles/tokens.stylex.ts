import * as stylex from "@stylexjs/stylex";

const DARK = "@media (prefers-color-scheme: dark)";

// The brand's grays carry a slight green tint, and nothing is pure white or black:
// gray-0 is the lightest and gray-850 the darkest.
const gray = {
  0: "#fafcfb",
  50: "#f2f5f3",
  100: "#e7ebe8",
  200: "#d5dbd7",
  300: "#bac2bd",
  400: "#97a09a",
  500: "#77817b",
  600: "#5b645f",
  700: "#454d48",
  750: "#3b433e",
  800: "#333a36",
  850: "#2a312d",
};

export const colors = stylex.defineVars({
  bg: { default: gray[50], [DARK]: gray[800] },
  surface: { default: gray[0], [DARK]: gray[850] },
  /** Pressed controls, the current row, and fields. */
  sunk: { default: gray[100], [DARK]: gray[750] },
  /** Behind artboards on the canvas. */
  canvas: { default: gray[100], [DARK]: "#232825" },
  text: { default: gray[800], [DARK]: gray[50] },
  muted: { default: gray[600], [DARK]: gray[300] },
  faint: { default: gray[500], [DARK]: gray[400] },
  border: { default: gray[300], [DARK]: gray[600] },
  /** Rules between sections inside one panel. */
  borderSoft: { default: gray[200], [DARK]: gray[700] },
  borderStrong: { default: gray[400], [DARK]: gray[500] },
  /** Ink-filled controls, like the active tool. */
  accent: { default: gray[800], [DARK]: gray[50] },
  /** Text and icons on an accent background. */
  onAccent: { default: gray[50], [DARK]: gray[800] },
  /** The brand blue: what's selected, tokens, focus. */
  brand: { default: "#3478ba", [DARK]: "#b9d6f2" },
  brandText: { default: "#2b669f", [DARK]: "#b9d6f2" },
  brandWash: { default: "#e6f0fa", [DARK]: "#3d4a5c" },
  /** Lines drawn over artboard content, on a `halo`, so they read on any artboard in either theme. */
  ink: "#1a1a18",
  halo: gray[0],
  /** The outline on the selection and the node under the pointer, and the selection's corner marks. */
  hover: "#3478ba",
  ok: { default: "#15803d", [DARK]: "#4ade80" },
  danger: { default: "#b8341f", [DARK]: "#f0806c" },
  /** Components and their instances on the canvas. */
  component: { default: "#7c3aed", [DARK]: "#a78bfa" },
});

export const space = stylex.defineVars({
  px: "2px",
  xs: "4px",
  sm: "8px",
  ms: "12px",
  md: "16px",
  lg: "24px",
  xl: "40px",
});

/** Control and row heights. */
export const size = stylex.defineVars({
  xs: "24px",
  sm: "28px",
  md: "36px",
  lg: "44px",
  /** The sidebars and the tool rail. */
  left: "248px",
  rail: "44px",
  right: "304px",
  bar: "40px",
});

export const radii = stylex.defineVars({
  xs: "2px",
  sm: "4px",
  md: "8px",
});

export const fonts = stylex.defineVars({
  sans: "'Helvetica Neue', Helvetica, Arial, sans-serif",
  mono: "'JetBrains Mono', ui-monospace, monospace",
});

export const shadows = stylex.defineVars({
  /** An even press-in on every edge, for pressed and selected controls. */
  inset: {
    default: "inset 0 0 0 1px rgba(42, 49, 45, 0.1), inset 0 0 2px 1px rgba(42, 49, 45, 0.12)",
    [DARK]: "inset 0 0 0 1px rgba(20, 23, 21, 0.35), inset 0 0 2px 1px rgba(20, 23, 21, 0.4)",
  },
  raised: {
    default: "0 4px 12px rgba(42, 49, 45, 0.09), 0 1px 3px rgba(42, 49, 45, 0.06)",
    [DARK]: "0 4px 12px rgba(20, 23, 21, 0.4), 0 1px 3px rgba(20, 23, 21, 0.3)",
  },
});

export const motion = stylex.defineVars({
  fast: "150ms",
  base: "200ms",
  out: "cubic-bezier(.23, 1, .32, 1)",
});
