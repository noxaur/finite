import type { ToolDef } from "./host";
import { notBuilt } from "./host";

export const section = {
  id: "section",
  group: "frame",
  label: "Section",
  keys: { key: "s", shift: true },
  icon: "section",
  cursor: "crosshair",
  enabled: false,
  down: notBuilt("Sections"),
} as const satisfies ToolDef<"section">;
