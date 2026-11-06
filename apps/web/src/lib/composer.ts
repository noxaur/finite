import type { Loc, ModelInfo, Selection, SendMode, Settings } from "@finite/protocol";

/**
 * What Enter does in the composer. An idle thread just starts a turn ("steer" and "queue" are the
 * same then). While the agent works, Enter does the default from Settings, and ⌥Enter the other.
 */
export function sendModeFor(running: boolean, defaultMode: SendMode, alt: boolean): SendMode {
  if (!running) return "steer";
  if (!alt) return defaultMode;
  return defaultMode === "steer" ? "queue" : "steer";
}

/** What the send button's tooltip says, for the same choice. */
export function sendLabel(running: boolean, defaultMode: SendMode): string {
  if (!running) return "Send (⏎)";
  const other = defaultMode === "steer" ? "queue" : "steer";
  return `${defaultMode === "steer" ? "Steer" : "Queue"} (⏎) · ${other} (⌥⏎)`;
}

export type ExploreKind = "layout" | "style" | "color" | "typography" | "surprise" | "custom";

export const EXPLORE_KINDS: ReadonlyArray<readonly [ExploreKind, string]> = [
  ["layout", "Layout"],
  ["style", "Style"],
  ["color", "Color"],
  ["typography", "Typography"],
  ["surprise", "Surprise me"],
  ["custom", "Custom…"],
];

/** "Explore 3 layout directions for Pricing card". `custom` is the person's own words for the kind. */
export function explorePrompt(
  kind: ExploreKind,
  count: number,
  target: string,
  custom = "",
): string {
  const n = Math.max(1, Math.round(count));
  const what =
    kind === "surprise" ? "surprising" : kind === "custom" ? custom.trim() || "new" : kind;
  return `Explore ${n} ${what} ${n === 1 ? "direction" : "directions"} for ${target}`;
}

const FAMILIES = ["opus", "sonnet", "haiku", "fable"] as const;

/**
 * What Claude says about a model: the exact entry, else the family alias Claude lists for a full
 * id (`claude-opus-5-5` → `opus`), so its effort levels and fast mode are known.
 */
export function findModel(models: ReadonlyArray<ModelInfo>, value: string): ModelInfo | undefined {
  const exact = models.find((m) => m.value === value);
  if (exact) return exact;
  const family = FAMILIES.find((f) => value.includes(f));
  return family ? models.find((m) => m.value === family) : undefined;
}

/** "Opus 5.5" for `claude-opus-5-5`: Claude's name for it, else one read from the id. */
export function modelName(models: ReadonlyArray<ModelInfo>, value: string): string {
  const exact = models.find((m) => m.value === value);
  if (exact) return exact.displayName;
  const parts = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(value);
  if (parts) {
    const [, family, major, minor] = parts;
    return `${family![0]!.toUpperCase()}${family!.slice(1)} ${major}${minor ? `.${minor}` : ""}`;
  }
  return findModel(models, value)?.displayName ?? value;
}

const EFFORT_NAMES: Record<string, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

export const effortName = (effort: string) => EFFORT_NAMES[effort] ?? effort;

/** The effort's name where room is tight, as in a strip of all five. */
export const effortShort = (effort: string) => (effort === "xhigh" ? "XHigh" : effortName(effort));

/**
 * The models worth offering: Claude's aliases (`opus`, `sonnet`…), which follow the newest
 * version, plus `current` when it's a full id. Pinned versions stay out of the short list.
 */
export function pickableModels(models: ReadonlyArray<ModelInfo>, current: string): ModelInfo[] {
  const aliases = models.filter((m) => !m.value.startsWith("claude-"));
  const exact = models.find((m) => m.value === current);
  return exact && !aliases.includes(exact) ? [...aliases, exact] : aliases;
}

/** The effort to send for a model: the chosen one if the model takes it, else none. */
export function effortFor(
  models: ReadonlyArray<ModelInfo>,
  value: string,
  effort: Settings["effort"] | undefined,
): Settings["effort"] | undefined {
  const levels = findModel(models, value)?.supportedEffortLevels;
  if (!levels || effort === undefined) return levels ? undefined : effort;
  return levels.includes(effort) ? effort : levels.includes("medium") ? "medium" : levels[0];
}

/** A picked frame or element, as the canvas's selection store holds it. */
export interface Picked {
  readonly frameId: string;
  readonly loc?: Loc | undefined;
  readonly index?: number | undefined;
  readonly name?: string | undefined;
}

/**
 * What a message carries for the selection: picked elements as `selection`, and picked whole
 * frames (which have no element loc) named in a note after the text.
 */
export function selectionFor(items: ReadonlyArray<Picked>): {
  selection: Selection[] | undefined;
  note: string;
} {
  const elements: Selection[] = [];
  const frames: string[] = [];
  for (const item of items) {
    if (item.loc === undefined) frames.push(`“${item.name || item.frameId}”`);
    else elements.push({ frameId: item.frameId, loc: item.loc, index: item.index ?? 0 });
  }
  return {
    selection: elements.length ? elements : undefined,
    note: frames.length
      ? `\n\n(Selected ${frames.length === 1 ? "frame" : "frames"}: ${frames.join(", ")})`
      : "",
  };
}
