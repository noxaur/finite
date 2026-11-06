import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ClaudeStatus, EffortLevel, ModelInfo } from "@finite/protocol";
import type { QueryFn } from "./index.ts";

const run = promisify(execFile);
const EFFORTS = new Set<string>(["low", "medium", "high", "xhigh", "max"]);

/** The `claude` executable on PATH, or undefined. */
export async function findClaude(): Promise<string | undefined> {
  try {
    const { stdout } = await run("which", ["claude"]);
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether Claude Code is installed and logged in, from `claude --version` and
 * `claude auth status --json`, and the models it offers, asked once of a short-lived query.
 */
export function createStatus(query: QueryFn, claudePath: () => Promise<string | undefined>) {
  let models: Promise<ModelInfo[]> | undefined;

  async function listModels(bin: string): Promise<ModelInfo[]> {
    const q = query({ prompt: never(), options: { pathToClaudeCodeExecutable: bin } });
    try {
      const list = await q.supportedModels();
      return list.map((m) => ({
        value: m.value,
        displayName: m.displayName,
        description: m.description,
        ...(m.supportedEffortLevels
          ? {
              supportedEffortLevels: m.supportedEffortLevels.filter((e): e is EffortLevel =>
                EFFORTS.has(e),
              ),
            }
          : {}),
        ...(m.supportsFastMode === undefined ? {} : { supportsFastMode: m.supportsFastMode }),
      }));
    } finally {
      q.close();
    }
  }

  return async function status(): Promise<ClaudeStatus> {
    const bin = await claudePath();
    if (!bin) return { installed: false, loggedIn: false, models: [] };
    let version: string;
    try {
      version = (await run(bin, ["--version"])).stdout.trim().split(" ")[0] ?? "";
    } catch {
      return { installed: false, loggedIn: false, models: [] };
    }
    let auth: { loggedIn?: unknown; email?: unknown } = {};
    try {
      auth = JSON.parse((await run(bin, ["auth", "status", "--json"])).stdout);
    } catch (error) {
      // Logged out, `claude auth status` exits 1 and still prints the JSON.
      const stdout = (error as { stdout?: string }).stdout;
      try {
        auth = stdout ? JSON.parse(stdout) : {};
      } catch {
        auth = {};
      }
    }
    const loggedIn = auth.loggedIn === true;
    const base = {
      installed: true,
      loggedIn,
      ...(version ? { version } : {}),
      ...(typeof auth.email === "string" ? { email: auth.email } : {}),
    };
    if (!loggedIn) return { ...base, models: [] };
    models ??= listModels(bin);
    models.catch(() => (models = undefined));
    return { ...base, models: await models.catch(() => []) };
  };
}

/** A prompt stream that never sends, for a query used only for its control calls. */
function never(): AsyncIterable<never> {
  return { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) };
}
