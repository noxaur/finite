import { type ChildProcess, execFile, execFileSync } from "node:child_process";
import diagnostics from "node:diagnostics_channel";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Previews } from "@finite/protocol";
import { getChromePath } from "chrome-launcher";
import puppeteer, { type Browser, TimeoutError } from "puppeteer-core";
import { describe, test } from "vite-plus/test";

/** Previews with a page open on every design a test starts, so none goes on the idle timer. */
export function viewed(previews: Previews): Previews {
  return {
    ...previews,
    ensure(design) {
      previews.watch(design.id);
      return previews.ensure(design);
    },
  };
}

/** The Chrome the browser tests drive, or undefined on a machine without one. */
export const chromePath = (() => {
  try {
    return getChromePath();
  } catch {
    return undefined;
  }
})();

/** CI's Ubuntu runners block the user namespaces Chrome's sandbox needs. */
export const chromeArgs: string[] = process.env.CI ? ["--no-sandbox"] : [];

/**
 * A `describe` for tests that drive Chrome. Without Chrome it skips on a machine of its own, and
 * fails on CI (`CI` set), where a skip would pass the browser tests without running them.
 */
export function describeChrome(name: string, body: () => void) {
  if (chromePath) return describe(name, body);
  if (!process.env.CI) return describe.skip(name, body);
  return describe(name, () => {
    test("needs Chrome", () => {
      throw new Error(
        `${name}: no Chrome found, and CI is set, so these tests can't be skipped. Install Chrome on the runner, or point CHROME_PATH at it.`,
      );
    });
  });
}

/** A launch that takes longer than this fails the test. */
const LAUNCH_LIMIT_MS = 30_000;
/** How long a launch may keep going past the limit, so a slow start can be told from a hang. */
const LAUNCH_WATCH_MS = 60_000;
/**
 * The `beforeAll` timeout for a hook that calls `launchChrome`. It has to outlast the launch and
 * the report's `ps` and `--version` calls, or the hook's bare "Hook timed out" replaces the report.
 */
export const LAUNCH_HOOK_TIMEOUT_MS = LAUNCH_WATCH_MS + 15_000;

/** One row per process in Chrome's group: a state that stays `S` with CPU time flat is a hang. */
function chromeProcesses(pid: number | undefined) {
  if (pid === undefined) return ["(Chrome never spawned)"];
  try {
    const rows = execFileSync("ps", ["-A", "-o", "pid=,pgid=,stat=,etime=,time=,wchan=,comm="], {
      encoding: "utf8",
      timeout: 5_000,
    });
    return rows.split("\n").filter((row) => row.trim().split(/\s+/)[1] === String(pid));
  } catch (error) {
    return [`(ps failed: ${String(error)})`];
  }
}

/** Load averages and, on Linux, how much of the last 10 seconds was lost waiting on each resource. */
function machineLoad() {
  const pressure = ["cpu", "io", "memory"].flatMap((resource) => {
    try {
      const some = fs.readFileSync(`/proc/pressure/${resource}`, "utf8").split("\n")[0];
      return [`${resource} ${some}`];
    } catch {
      return [];
    }
  });
  return [
    `load average ${os
      .loadavg()
      .map((n) => n.toFixed(2))
      .join(" ")} on ${os.availableParallelism()} CPUs`,
    `memory ${Math.round(os.freemem() / 2 ** 20)} of ${Math.round(os.totalmem() / 2 ** 20)} MB free`,
    ...pressure,
  ];
}

function chromeVersion() {
  try {
    return execFileSync(chromePath!, ["--version"], { encoding: "utf8", timeout: 5_000 }).trim();
  } catch {
    return "version unknown: --version didn't answer in 5s";
  }
}

/**
 * Launches the test Chrome, and fails with a report instead of a bare hook timeout: how long the
 * launch ran, Chrome's output with times, what its processes were doing past the limit, and the
 * machine's load. A launch over the limit still fails, but runs on to `LAUNCH_WATCH_MS`, so the
 * report says whether Chrome came up late or never did.
 */
export async function launchChrome(): Promise<Browser> {
  const started = performance.now();
  const seconds = () => ((performance.now() - started) / 1000).toFixed(1);
  const output: string[] = [];
  const samples: string[] = [];
  let chrome: ChildProcess | undefined;
  let launching = true;

  // Puppeteer only hands Chrome's output to errors for a process that exited, not a timeout. The
  // channel publishes from the ChildProcess constructor, before it has spawned or has its streams.
  const onSpawn = (message: unknown) => {
    const child = (message as { process: ChildProcess }).process;
    process.nextTick(() => {
      if (child.spawnfile !== chromePath) return;
      chrome = child;
      for (const stream of [child.stderr, child.stdout])
        stream?.on("data", (chunk) => {
          if (!launching) return;
          for (const line of String(chunk).split("\n"))
            if (line.trim()) output.push(`+${seconds()}s ${line}`);
        });
    });
  };
  const sample = () =>
    samples.push(`at ${seconds()}s:`, ...chromeProcesses(chrome?.pid).map((row) => `  ${row}`));
  const report = (headline: string) => {
    sample();
    return [
      `Chrome launch failed: ${headline}`,
      `Chrome: ${chromePath} (${chromeVersion()})`,
      `Machine: ${machineLoad().join("; ")}`,
      "Chrome processes (pid pgid stat elapsed cpu wchan command):",
      ...samples,
      `Chrome output, last 40 of ${output.length} lines, timed from the launch:`,
      ...(output.length ? output.slice(-40) : ["(none)"]),
    ].join("\n");
  };

  diagnostics.subscribe("child_process", onSpawn);
  let sampler: NodeJS.Timeout | undefined;
  const limit = setTimeout(() => {
    sample();
    sampler = setInterval(sample, 15_000);
  }, LAUNCH_LIMIT_MS);
  // Puppeteer's `timeout` covers two of its waits, but not the WebSocket handshake between them.
  let deadline: NodeJS.Timeout | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    deadline = setTimeout(
      () => reject(new TimeoutError(`Timed out after ${LAUNCH_WATCH_MS} ms launching Chrome`)),
      LAUNCH_WATCH_MS,
    );
  });
  let browser: Browser;
  try {
    browser = await Promise.race([
      puppeteer.launch({
        executablePath: chromePath!,
        headless: true,
        timeout: LAUNCH_WATCH_MS,
        args: chromeArgs,
      }),
      timedOut,
    ]);
  } catch (error) {
    const reason = String((error as Error).message).split("\n")[0];
    const message = report(
      error instanceof TimeoutError
        ? `no browser after ${seconds()}s (the limit is ${LAUNCH_LIMIT_MS / 1000}s), so it hung or is far too slow. ${reason}`
        : `it stopped after ${seconds()}s. ${reason}`,
    );
    // Puppeteer only cleans up after its own timeouts, so a launch that hit the deadline is still up.
    try {
      // Puppeteer starts Chrome as its own process group, so this takes its helpers too.
      if (chrome?.pid !== undefined) process.kill(-chrome.pid, "SIGKILL");
    } catch {
      // It had already exited.
    }
    throw new Error(message, { cause: error });
  } finally {
    launching = false;
    diagnostics.unsubscribe("child_process", onSpawn);
    clearTimeout(limit);
    clearTimeout(deadline);
    clearInterval(sampler);
  }
  if (performance.now() - started <= LAUNCH_LIMIT_MS) return browser;
  const message = report(
    `slow start, not a hang. It came up after ${seconds()}s, over the ${LAUNCH_LIMIT_MS / 1000}s limit.`,
  );
  await browser.close();
  throw new Error(message);
}

let shared: Promise<Browser> | undefined;

/**
 * Starts the file's Chrome without waiting for it, so its first launch, the slowest one, runs
 * beside the fixture installs instead of after them. A failure surfaces in `sharedChrome`.
 */
export function warmChrome() {
  if (!chromePath || shared) return;
  shared = launchChrome();
  shared.catch(() => {});
}

/** The one Chrome a test file drives, launched on first use. Close it with `closeChrome`. */
export function sharedChrome(): Promise<Browser> {
  warmChrome();
  return shared ?? Promise.reject(new Error("no Chrome found"));
}

export async function closeChrome() {
  const browser = await shared?.catch(() => undefined);
  shared = undefined;
  await browser?.close();
}

const FIXTURES = fileURLToPath(new URL("../../fixtures/", import.meta.url));

/**
 * Copies `apps/server/fixtures/<name>` to a temp folder and installs its dependencies there, so
 * tests run it like a person's own project, outside this workspace and its lockfile. The
 * fixtures pin exact versions; `--prefer-offline` takes them from the pnpm store when it can.
 * `sass` has an optional file watcher with a build script, which pnpm 12 otherwise fails on.
 */
export async function prepareFixture(name: string, options: { install?: boolean } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `finite-${name}-`)));
  fs.cpSync(path.join(FIXTURES, name), root, {
    recursive: true,
    filter: (source) => !source.split(path.sep).includes("node_modules"),
  });
  if (options.install !== false) {
    await promisify(execFile)(
      "pnpm",
      [
        "install",
        "--prefer-offline",
        "--ignore-workspace",
        "--no-lockfile",
        "--reporter=silent",
        "--config.strict-dep-builds=false",
      ],
      { cwd: root, timeout: 180_000 },
    );
  }
  // Deleting a node_modules takes seconds, so callers delete their copies side by side.
  return { root, remove: () => fs.promises.rm(root, { recursive: true, force: true }) };
}
