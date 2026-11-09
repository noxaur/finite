import type { ToolDef } from "./host";
import { notBuilt } from "./host";

export const scale = {
  id: "scale",
  group: "move",
  label: "Scale",
  keys: { key: "k" },
  icon: "scale",
  cursor: "",
  enabled: false,
  down: notBuilt("Scale"),
} as const satisfies ToolDef<"scale">;
