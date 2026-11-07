import { type ChildProcess, fork } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Design,
  type FrameError,
  type FrameSource,
  frameHref,
  type PreviewEvent,
  type Previews,
  type PreviewState,
  Refused,
  type Route,
  type Unsubscribe,
} from "@finite/protocol";
import { allowedHosts } from "../guard.ts";
import { WORKSPACE_FILE } from "../store/workspace.ts";
import { createWorkspaces } from "./workspace.ts";

export type PreviewsOptions = {
  /** The host each design's Vite dev server binds, the same one Finite listens on. */
  host: string;
  /** How long a preview nobody is viewing keeps running before `idle` stops it. */
  graceMs?: number;
  /** How long a dev server may take to start. */
  startTimeoutMs?: number;
  /** The `@finite/vite-plugin` entry the dev server loads. */
  plugin?: string;
  /** Hosts the Finite shell is served from, as the server allows them (default: loopback names). */
  allowedHosts?: readonly string[];
  /**
   * Looks a design's `finite.json` up again after it changes, updating the design's `workspace`
   * and `app` in place, before the preview compares what it runs with.
   */
  relink?: (designId: string) => Promise<unknown>;
};

const VITE_HOST = fileURLToPath(new URL("./vite-host.mjs", import.meta.url));
const NEXT_HOST = fileURLToPath(new URL("./next-host.mjs", import.meta.url));
/** A plugin file bundled beside the server (`vp pack`, in the desktop app), else its source. */
const pluginFile = (bundled: string, source: string) => {
  const file = fileURLToPath(new URL(`./${bundled}`, import.meta.url));
  if (fs.existsSync(file)) return file;
  return fileURLToPath(new URL(`../../../../packages/vite-plugin/src/${source}`, import.meta.url));
};
const DEFAULT_PLUGIN = pluginFile("vite-plugin.mjs", "index.ts");
/** Next loads these two by path: the adapter that edits its config, and the stamping loader. */
const NEXT_ADAPTER = pluginFile("next-adapter.mjs", "next/adapter.ts");
const NEXT_LOADER = pluginFile("next-loader.mjs", "next/loader.ts");
const LOG_TAIL = 4_000;
const KILL_AFTER_MS = 5_000;
const MAX_ERRORS_PER_FRAME = 50;
const PROGRESS_MS = 300;

type Run = {
  /** Unset until a workspace design's setup and services are done, and for a setup design. */
  child: ChildProcess | undefined;
  state: PreviewState;
  ready: Promise<{ url: string }>;
  log: string;
  routes: Promise<Route[]> | undefined;
  /** Settles `ready` with a refusal, for a run that stops before it's ready. */
  cancel: (reason: string) => void;
  /** The last routes sent to listeners, to send only changes. */
  sentRoutes: string | undefined;
  /** Lets go of the finite.json services the run holds. */
  release: (() => void) | undefined;
  /** What finite.json gave the run, from `Workspaces.version`; a change restarts the run. */
  version: string | undefined;
  /** Watches a workspace design's finite.json, whose `routes` the Routes page shows. */
  watcher: fs.FSWatcher | undefined;
  /** finite.json reloads, one at a time. */
  reloads: Promise<void>;
  /** Pending throttled `starting` event while setup output streams in. */
  progress: NodeJS.Timeout | undefined;
};

/** Whether a design previews on `next dev` rather than Vite: its router, else its package.json. */
function usesNext(design: Design): boolean {
  if (design.router === "next-app" || design.router === "next-pages") return true;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(design.root, "package.json"), "utf8"));
    return Boolean(pkg.dependencies?.next ?? pkg.devDependencies?.next);
  } catch {
    return false;
  }
}

/**
 * One dev server per open design, each in a child process running `vite-host.mjs`, or
 * `next-host.mjs` for Next.js.
 */
export function createPreviews(options: PreviewsOptions): Previews {
  const graceMs = options.graceMs ?? 60_000;
  const startTimeoutMs = options.startTimeoutMs ?? 60_000;
  const plugin = options.plugin ?? DEFAULT_PLUGIN;
  const runs = new Map<string, Run>();
  const listeners = new Map<string, Set<(event: PreviewEvent) => void>>();
  const errors = new Map<string, Map<string, FrameError[]>>();
  const idleTimers = new Map<string, NodeJS.Timeout>();
  /** Designs whose run is stopping to start again; a stop meanwhile cancels the start. */
  const restarting = new Set<string>();
  const workspaces = createWorkspaces({ startTimeoutMs });

  const emit = (designId: string, event: PreviewEvent) => {
    for (const fn of listeners.get(designId) ?? []) fn(event);
  };
  const setState = (designId: string, run: Run, state: PreviewState) => {
    clearTimeout(run.progress);
    run.progress = undefined;
    run.state = state;
    if (runs.get(designId) === run) emit(designId, { type: "preview", ...state });
  };
  const cancelIdle = (designId: string) => {
    clearTimeout(idleTimers.get(designId));
    idleTimers.delete(designId);
  };

  const releaseRun = (run: Run) => {
    run.release?.();
    run.release = undefined;
    run.watcher?.close();
    run.watcher = undefined;
  };

  /**
   * Starts a run. `previous` lets go of the services of the run it replaces, called once this one
   * holds its own, so a service both need keeps running.
   */
  function start(design: Design, previous?: () => void): Run {
    let resolveReady!: (value: { url: string }) => void;
    let rejectReady!: (error: Error) => void;
    const ready = new Promise<{ url: string }>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    ready.catch(() => {});
    const run: Run = {
      child: undefined,
      state: { status: "starting" },
      ready,
      log: "",
      routes: undefined,
      cancel: (reason) => rejectReady(new Refused(reason)),
      sentRoutes: undefined,
      release: undefined,
      version: undefined,
      watcher: undefined,
      reloads: Promise.resolve(),
      progress: undefined,
    };
    runs.set(design.id, run);

    if (design.setup) {
      const reason =
        "This folder isn't set up for Finite yet: its finite.json setup hasn't finished. Finish the setup thread, which writes finite.json and calls finish_setup, then open the design again.";
      run.state = { status: "needs-setup", log: reason };
      emit(design.id, { type: "preview", ...run.state });
      rejectReady(new Refused(reason));
      previous?.();
      return run;
    }
    emit(design.id, { type: "preview", ...run.state });
    if (!design.workspace) {
      previous?.();
      startHost(design, run, {}, resolveReady, rejectReady);
      return run;
    }

    // Setup output shows in `starting`, at most every PROGRESS_MS.
    const onOutput = (chunk: string) => {
      run.log = (run.log + chunk).slice(-LOG_TAIL);
      if (run.progress || run.state.status !== "starting") return;
      run.progress = setTimeout(() => {
        run.progress = undefined;
        if (run.state.status === "starting") {
          setState(design.id, run, { status: "starting", log: run.log });
        }
      }, PROGRESS_MS);
    };
    workspaces
      .prepare(design, onOutput, () => runs.get(design.id) === run)
      .finally(() => previous?.())
      .then(
        ({ env, release, version }) => {
          if (runs.get(design.id) !== run) return release();
          run.release = release;
          run.version = version;
          run.log = "";
          startHost(design, run, env, resolveReady, rejectReady);
        },
        (error: Error) => {
          rejectReady(error);
          if (runs.get(design.id) !== run) return;
          setState(design.id, run, {
            status: "error",
            log: `${error.message}\n\n${run.log}`.trim(),
          });
        },
      );
    return run;
  }

  /** Forks the dev server child for a started run. */
  function startHost(
    design: Design,
    run: Run,
    env: Record<string, string>,
    resolveReady: (value: { url: string }) => void,
    rejectReady: (error: Error) => void,
  ) {
    const child = fork(usesNext(design) ? NEXT_HOST : VITE_HOST, [], {
      cwd: design.root,
      execArgv: [],
      env: {
        ...process.env,
        ...env,
        FINITE_PREVIEW: JSON.stringify({
          root: design.root,
          host: options.host,
          plugin,
          adapter: NEXT_ADAPTER,
          loader: NEXT_LOADER,
          allowedHosts: options.allowedHosts ?? allowedHosts(undefined),
        }),
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    run.child = child;

    const append = (chunk: Buffer) => {
      run.log = (run.log + chunk.toString("utf8")).slice(-LOG_TAIL);
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);

    const fail = (reason: string) => {
      clearTimeout(timeout);
      rejectReady(new Refused(`The design's dev server didn't start: ${reason}`));
      releaseRun(run);
      if (run.state.status !== "error") {
        setState(design.id, run, { status: "error", log: `${reason}\n\n${run.log}`.trim() });
      }
    };
    const timeout = setTimeout(() => {
      fail(`it didn't report a URL within ${Math.round(startTimeoutMs / 1000)}s`);
      child.kill("SIGKILL");
    }, startTimeoutMs);

    child.on("message", (message: { type: string; url?: string; message?: string }) => {
      if (message.type === "ready" && message.url) {
        clearTimeout(timeout);
        setState(design.id, run, { status: "ready", url: message.url });
        resolveReady({ url: message.url });
        void refreshRoutes(design.id, run);
        if (design.workspace) watchWorkspace(design, design.workspace, run);
      } else if (message.type === "error") {
        fail(message.message ?? "it failed");
      } else if (message.type === "changed") {
        run.routes = undefined;
        void refreshRoutes(design.id, run);
      }
    });
    child.on("exit", (code, signal) => {
      if (run.state.status === "stopped") return;
      fail(`it exited (${signal ?? `code ${code}`})`);
    });
    child.on("error", (error) => fail(error.message));
  }

  /**
   * Reloads the workspace's finite.json whenever it changes. It watches the folder, since an
   * atomic write replaces the file. It also reloads once now, for an edit made while the run
   * started.
   */
  function watchWorkspace(design: Design, workspace: string, run: Run) {
    if (run.watcher || runs.get(design.id) !== run) return;
    try {
      run.watcher = fs.watch(workspace, (_, file) => {
        if (file === WORKSPACE_FILE) reload(design, run, true);
      });
      run.watcher.on("error", () => run.watcher?.close());
    } catch (error) {
      console.error(`watching ${workspace} for finite.json changes failed:`, error);
    }
    reload(design, run, false);
  }

  /**
   * Restarts the run when finite.json changed what it runs with (setup, needs, env, services, or
   * the design's app), else sends the routes again, so the Routes page picks up its `routes`. An
   * invalid finite.json keeps the run as it is, with the reason in its state's `log`.
   */
  function reload(design: Design, run: Run, edited: boolean) {
    const current = () => runs.get(design.id) === run;
    run.reloads = run.reloads.then(async () => {
      await options.relink?.(design.id).catch(() => {});
      if (!current()) return;
      const version = await workspaces.version(design).catch((error: Error) => error);
      if (!current()) return;
      if (version instanceof Error) {
        return setState(design.id, run, { ...run.state, log: version.message });
      }
      if (version !== run.version) return restart(design, run);
      if (run.state.log) setState(design.id, run, { status: run.state.status, url: run.state.url });
      if (!edited) return;
      run.sentRoutes = undefined;
      await refreshRoutes(design.id, run);
    });
  }

  /** Starts the design's preview again, unless it's idle (nobody views it), which only stops it. */
  async function restart(design: Design, run: Run) {
    const idle = idleTimers.has(design.id);
    const release = run.release ?? (() => {});
    run.release = undefined;
    const stopped = stopRun(design.id);
    restarting.add(design.id);
    await stopped;
    if (!restarting.delete(design.id) || idle || runs.has(design.id)) return release();
    start(design, release);
  }

  async function fetchRoutes(run: Run): Promise<Route[]> {
    const { url } = await run.ready;
    const response = await fetch(`${url}/__finite/routes`);
    const body = (await response.json()) as Route[] | { reason: string };
    if (!response.ok || !Array.isArray(body)) {
      throw new Refused("reason" in body ? body.reason : `routes failed (${response.status})`);
    }
    return body;
  }

  async function refreshRoutes(designId: string, run: Run): Promise<void> {
    run.routes ??= fetchRoutes(run);
    const routes = await run.routes.catch(() => undefined);
    if (!routes || runs.get(designId) !== run) return;
    const json = JSON.stringify(routes);
    if (json === run.sentRoutes) return;
    run.sentRoutes = json;
    emit(designId, { type: "routes", routes });
  }

  async function stopRun(designId: string): Promise<void> {
    cancelIdle(designId);
    restarting.delete(designId);
    const run = runs.get(designId);
    if (!run) return;
    setState(designId, run, { status: "stopped" });
    runs.delete(designId);
    run.cancel("The design's preview was stopped before it was ready.");
    releaseRun(run);
    const { child } = run;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      const kill = setTimeout(() => child.kill("SIGKILL"), KILL_AFTER_MS);
      child.once("exit", () => {
        clearTimeout(kill);
        resolve();
      });
      child.kill("SIGTERM");
    });
  }

  return {
    async ensure(design) {
      cancelIdle(design.id);
      const run = runs.get(design.id);
      if (run && run.state.status !== "error" && run.state.status !== "needs-setup") {
        return run.ready;
      }
      if (run) await stopRun(design.id);
      return start(design).ready;
    },

    state: (designId) => runs.get(designId)?.state ?? { status: "stopped" },

    async routes(designId) {
      const run = runs.get(designId);
      if (!run) throw new Refused("The design's preview isn't running; open the design first.");
      run.routes ??= fetchRoutes(run);
      return run.routes;
    },

    frameUrl(designId, source: FrameSource) {
      const url = runs.get(designId)?.state.url;
      if (!url) throw new Refused("The design's preview isn't ready yet; wait for it to start.");
      return frameHref(url, source);
    },

    stop: stopRun,

    idle(designId) {
      if (!runs.has(designId)) return;
      cancelIdle(designId);
      const timer = setTimeout(() => void stopRun(designId), graceMs);
      timer.unref();
      idleTimers.set(designId, timer);
    },

    on(designId, fn): Unsubscribe {
      let set = listeners.get(designId);
      if (!set) listeners.set(designId, (set = new Set()));
      set.add(fn);
      return () => set.delete(fn);
    },

    reportError(designId, error) {
      let frames = errors.get(designId);
      if (!frames) errors.set(designId, (frames = new Map()));
      const list = [...(frames.get(error.frameId) ?? []), error].slice(-MAX_ERRORS_PER_FRAME);
      frames.set(error.frameId, list);
    },

    errors: (designId, frameId) => errors.get(designId)?.get(frameId) ?? [],

    async close() {
      restarting.clear();
      await Promise.all([...runs.keys()].map(stopRun));
      await workspaces.close();
    },
  };
}
