import type { ToolDef } from "./host";
import { notBuilt } from "./host";

export const measure = {
  id: "measure",
  group: "comment",
  label: "Measurement",
  keys: { key: "m", shift: true },
  icon: "measure",
  cursor: "crosshair",
  enabled: false,
  sticky: true,
  down: notBuilt("Measurement"),
} as const satisfies ToolDef<"measure">;
