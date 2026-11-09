import type { ToolDef } from "./host";
import { pressTargets, select } from "./move";

/** Lets the pointer into the frames, to click through the real app. Esc leaves it. */
export const interact = {
  id: "interact",
  group: "move",
  label: "Interact",
  keys: { key: "i" },
  icon: "interact",
  cursor: "",
  enabled: true,
  sticky: true,
  pan: "empty",
  down(host, p) {
    const { handle, titleId } = pressTargets(p.target);
    return p.frame && !handle && !titleId ? "pass" : select.down(host, p);
  },
} as const satisfies ToolDef<"interact">;
