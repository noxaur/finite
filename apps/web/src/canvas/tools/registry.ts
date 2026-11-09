import { autoLayoutCommands } from "./autoLayout";
import { COMMANDS, type CommandDef, type KeyEnv } from "./commands";
import { comment, annotation } from "./comment";
import { hand } from "./hand";
import type { KeyCombo, KeyInput, ToolDef, ToolGroup } from "./host";
import { interact } from "./interact";
import { measure } from "./measure";
import { select } from "./move";
import { pen, pencil } from "./pen";
import { scale } from "./scale";
import { section } from "./section";
import { arrow, ellipse, frame, image, line, polygon, rectangle, star } from "./shapes";
import { slice } from "./slice";
import { text, textOnPath } from "./text";
import { vectorCommands } from "./vectorEdit";

export type { KeyEnv } from "./commands";

/** The one list. The toolbar, shortcuts, menu hints and cursors all derive from it. */
export const TOOLS = [
  select,
  hand,
  scale,
  interact,
  frame,
  section,
  slice,
  rectangle,
  line,
  arrow,
  ellipse,
  polygon,
  star,
  image,
  pen,
  pencil,
  text,
  textOnPath,
  comment,
  annotation,
  measure,
] as const satisfies readonly ToolDef[];

export type ToolId = (typeof TOOLS)[number]["id"];

export const ALL_COMMANDS: readonly CommandDef[] = [
  ...COMMANDS,
  ...autoLayoutCommands,
  ...vectorCommands,
];

const byId = new Map<string, ToolDef>(TOOLS.map((t) => [t.id, t]));

export function toolOf(id: string): ToolDef {
  return byId.get(id) ?? select;
}

export const GROUPS: readonly ToolGroup[] = ["move", "frame", "shape", "pen", "text", "comment"];

/** The enabled tools of a group, in registry order. */
export function toolsIn(group: ToolGroup): ToolDef[] {
  return TOOLS.filter((t) => t.group === group && t.enabled);
}

export type KeyAction = { kind: "tool"; id: ToolId } | { kind: "command"; id: string };

function matches(combo: KeyCombo, e: KeyInput): boolean {
  if (combo.code !== undefined && combo.code !== e.code) return false;
  if (combo.key !== undefined && combo.key !== e.key.toLowerCase()) return false;
  if (combo.loose) return true;
  return (
    !!combo.shift === e.shiftKey &&
    !!combo.alt === e.altKey &&
    !!combo.mod === (e.metaKey || e.ctrlKey)
  );
}

/**
 * What a key means now, or `null` for nothing. Mod combos and Escape always work. Everything else
 * is off while an editor has the keys, and for a key forwarded out of a frame in Interact mode,
 * which belongs to the app in the frame.
 */
export function resolveKey(e: KeyInput, env: KeyEnv): KeyAction | null {
  const blocked = env.editing || (env.interact && env.source === "frame");
  for (const command of ALL_COMMANDS) {
    if (!command.enabled || (blocked && !command.always)) continue;
    if (command.when && !command.when(env)) continue;
    if (command.keys.some((combo) => matches(combo, e))) return { kind: "command", id: command.id };
  }
  if (blocked) return null;
  for (const tool of TOOLS) {
    if (tool.enabled && tool.keys && matches(tool.keys, e)) return { kind: "tool", id: tool.id };
  }
  return null;
}

/** Every shortcut, tools and commands alike, for a test to catch collisions. */
export function shortcutList(): Array<{ owner: string; combo: KeyCombo }> {
  return [
    ...TOOLS.flatMap((t) => (t.keys ? [{ owner: t.id, combo: t.keys }] : [])),
    ...ALL_COMMANDS.flatMap((c) => c.keys.map((combo) => ({ owner: c.id, combo }))),
  ];
}

const isMac = () =>
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform ?? "");

/** A shortcut as the toolbar's menu shows it: `⇧⌘K`. */
export function keyHint(combo: KeyCombo): string {
  const key = (combo.key ?? combo.code ?? "").toUpperCase();
  const mod = combo.mod ? (isMac() ? "⌘" : "Ctrl+") : "";
  return `${combo.shift ? "⇧" : ""}${combo.alt ? "⌥" : ""}${mod}${key}`;
}
