import * as stylex from "@stylexjs/stylex";

export const colors = stylex.defineVars({
  brand: "#95ced7",
  line: "#c8d3d6",
  ink: {
    default: "#1d2a2e",
    "@media (prefers-color-scheme: dark)": "#e3f1f3",
  },
});
