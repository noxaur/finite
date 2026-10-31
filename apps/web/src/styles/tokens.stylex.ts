import * as stylex from "@stylexjs/stylex";

const DARK = "@media (prefers-color-scheme: dark)";

export const colors = stylex.defineVars({
  bg: { default: "#f6f5f1", [DARK]: "#141413" },
  surface: { default: "#ffffff", [DARK]: "#1f1f1d" },
  /** Behind artboards on the canvas. */
  canvas: { default: "#e9e8e3", [DARK]: "#0e0e0d" },
  text: { default: "#1a1a18", [DARK]: "#ecebe6" },
  muted: { default: "#6b6a64", [DARK]: "#9c9b94" },
  border: { default: "#e2e0d8", [DARK]: "#33332f" },
  accent: { default: "#c2410c", [DARK]: "#fb923c" },
  ok: { default: "#15803d", [DARK]: "#4ade80" },
  danger: { default: "#b91c1c", [DARK]: "#f87171" },
});

export const space = stylex.defineVars({
  xs: "4px",
  sm: "8px",
  md: "16px",
  lg: "24px",
  xl: "40px",
});

export const radii = stylex.defineVars({
  sm: "6px",
  md: "10px",
});
