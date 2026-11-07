import type { Loc, ModelInfo, Selection, SendMode, Settings, ThreadMeta } from "@finite/protocol";

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

/** What Claude says about a model. Settings and threads store values `claude.status` lists. */
export function findModel(models: ReadonlyArray<ModelInfo>, value: string): ModelInfo | undefined {
  return models.find((m) => m.value === value);
}

/** "Opus 5.5" for `opus`: Claude's name for the model, else its value. */
export function modelName(models: ReadonlyArray<ModelInfo>, value: string): string {
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

/** What a message runs with: Claude's model, its reasoning effort and fast mode. */
export interface RunWith {
  readonly model: string;
  readonly effort: Settings["effort"] | undefined;
  readonly fast: boolean;
}

/** A pick in the composer's model menu, for the thread open when it was made (null: a new one). */
export interface ModelChoice extends RunWith {
  readonly threadId: string | null;
}

/**
 * What the composer shows and sends: the person's pick for this thread, else the open thread's own
 * settings, else the defaults from Settings for a new thread. A pick made on another thread
 * doesn't carry over.
 */
export function runWith(
  models: ReadonlyArray<ModelInfo>,
  settings: Pick<Settings, "model" | "effort" | "fast"> | null,
  thread: Pick<ThreadMeta, "id" | "model" | "effort" | "fast"> | null,
  choice: ModelChoice | null,
): RunWith {
  const picked = choice && choice.threadId === (thread?.id ?? null) ? choice : null;
  const base: RunWith = picked ??
    (thread && { model: thread.model, effort: thread.effort, fast: thread.fast }) ?? {
      model: settings?.model ?? models[0]?.value ?? "",
      effort: settings?.effort,
      fast: settings?.fast ?? false,
    };
  const model = base.model || settings?.model || models[0]?.value || "";
  return {
    model,
    effort: effortFor(models, model, base.effort),
    fast: base.fast && !!findModel(models, model)?.supportsFastMode,
  };
}

/** A picked frame or element, as the canvas's selection store holds it. */
export interface Picked {
  readonly frameId: string;
  readonly loc?: Loc | undefined;
  readonly index?: number | undefined;
}

/** What a message carries for the selection: whole frames without a loc, elements with one. */
export function selectionFor(items: ReadonlyArray<Picked>): Selection[] | undefined {
  const out = items.map(({ frameId, loc, index }): Selection =>
    loc === undefined ? { frameId } : { frameId, loc, index: index ?? 0 },
  );
  return out.length ? out : undefined;
}
