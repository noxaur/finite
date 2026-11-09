import type { ToolDef } from "./host";
import { notBuilt } from "./host";

export const pen = {
  id: "pen",
  group: "pen",
  label: "Pen",
  keys: { key: "p" },
  icon: "pen",
  cursor: "crosshair",
  enabled: false,
  sticky: true,
  down: notBuilt("The pen"),
} as const satisfies ToolDef<"pen">;

export const pencil = {
  id: "pencil",
  group: "pen",
  label: "Pencil",
  keys: { key: "p", shift: true },
  icon: "pencil",
  cursor: "crosshair",
  enabled: false,
  sticky: true,
  down: notBuilt("The pencil"),
} as const satisfies ToolDef<"pencil">;
