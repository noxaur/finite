import type { ToolDef } from "./host";
import { notBuilt } from "./host";

export const text = {
  id: "text",
  group: "text",
  label: "Text",
  keys: { key: "t" },
  icon: "text",
  cursor: "var(--cursor-text, text)",
  enabled: false,
  down: notBuilt("The text tool"),
} as const satisfies ToolDef<"text">;

export const textOnPath = {
  id: "textOnPath",
  group: "text",
  label: "Text on path",
  keys: null,
  icon: "textOnPath",
  cursor: "var(--cursor-text, text)",
  enabled: false,
  down: notBuilt("Text on path"),
} as const satisfies ToolDef<"textOnPath">;
