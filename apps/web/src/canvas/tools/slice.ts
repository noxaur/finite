import type { ToolDef } from "./host";
import { notBuilt } from "./host";

export const slice = {
  id: "slice",
  group: "frame",
  label: "Slice",
  keys: { key: "s" },
  icon: "slice",
  cursor: "crosshair",
  enabled: false,
  down: notBuilt("Slices"),
} as const satisfies ToolDef<"slice">;
