import { spawn, spawnSync } from "node:child_process";
import type { InstallState } from "@finite/protocol";

/** A dependency install running in a new design's folder. */
export type Install = {
  /** `running` with the output so far, then `done` or `error`. */
  readonly state: InstallState;
  /** Settles when the install ends; rejects when it fails. */
  readonly done: Promise<void>;
};

const LOG_TAIL = 4_000;
const PROGRESS_MS = 300;

let packageManager: "pnpm" | "npm" | undefined;

/** pnpm when it's on PATH, else npm. */
function pickPackageManager(): "pnpm" | "npm" {
  packageManager ??=
    spawnSync("pnpm", ["--version"], { stdio: "ignore", timeout: 10_000 }).status === 0
      ? "pnpm"
      : "npm";
  return packageManager;
}

/**
 * Runs `pnpm install` (or `npm install`) in `root` as a background child. `onProgress` gets the
 * state now and then while it runs, and once at the end.
 */
export function install(root: string, onProgress: (state: InstallState) => void): Install {
  const pm = pickPackageManager();
  // A design folder can sit inside another pnpm workspace (the dev data dir does); stay out of it.
  const args =
    pm === "pnpm" ? ["install", "--ignore-workspace"] : ["install", "--no-fund", "--no-audit"];
  let log = `Installing dependencies with ${pm}…\n`;
  const handle: { state: InstallState; done: Promise<void> } = {
    state: { status: "running", log },
    done: Promise.resolve(),
  };
  let timer: NodeJS.Timeout | undefined;
  const report = (state: InstallState) => {
    handle.state = state;
    if (timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      onProgress(handle.state);
    }, PROGRESS_MS);
  };

  handle.done = new Promise<void>((resolve, reject) => {
    const child = spawn(pm, args, {
      cwd: root,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let finished = false;
    const append = (chunk: Buffer) => {
      // Node can deliver output after `exit`; the install has already reported how it ended.
      if (finished) return;
      log = (log + chunk.toString("utf8")).slice(-LOG_TAIL);
      report({ status: "running", log });
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const finish = (error: string | undefined) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      timer = undefined;
      handle.state = error
        ? { status: "error", log: `${log}\n${error}`.slice(-LOG_TAIL) }
        : { status: "done", log: `${log}\nDependencies installed.`.slice(-LOG_TAIL) };
      onProgress(handle.state);
      if (error) reject(new Error(error));
      else resolve();
    };
    child.once("error", (error) => finish(`${pm} install couldn't start: ${error.message}`));
    child.once("exit", (code, signal) =>
      finish(
        code === 0
          ? undefined
          : `${pm} install failed (${signal ?? `exit ${code}`}). Fix the error above, then run \`${pm} install\` in ${root}.`,
      ),
    );
  });
  handle.done.catch(() => {});
  onProgress(handle.state);
  return handle;
}
