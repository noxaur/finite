import type { ToolDef } from "./host";

/** Drags the canvas anywhere, over frames too. */
export const hand = {
  id: "hand",
  group: "move",
  label: "Hand",
  keys: { key: "h" },
  icon: "hand",
  cursor: "var(--cursor-grab, grab)",
  enabled: true,
  sticky: true,
  pan: "always",
} as const satisfies ToolDef<"hand">;
