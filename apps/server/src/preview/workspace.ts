import { type ChildProcess, spawn } from "node:child_process";
import net from "node:net";
import { type Design, Refused } from "@finite/protocol";
import {
  envFor,
  readWorkspace,
  servicesFor,
  type Workspace,
  type WorkspaceService,
} from "../store/workspace.ts";

const LOG_TAIL = 4_000;
const KILL_AFTER_MS = 5_000;
const POLL_MS = 200;

/** A run of setup commands, shared by every design waiting on it. */
type Job = { log: string; listeners: Set<(chunk: string) => void>; done: Promise<void> };

/** A running service, shared by the previews that need it. */
type Service = {
  name: string;
  /** Unset for a service that was already answering, which Finite didn't start. */
  child: ChildProcess | undefined;
  refs: number;
  ready: Promise<void>;
  log: string;
};

export type Workspaces = {
  /**
   * Runs the workspace's and the app's `setup` (once per finite.json version), then starts the
   * services the app needs. Streams setup output to `onOutput`. Resolves with the env finite.json
   * gives the dev server and a `release` for the services, to call when the preview stops. Once
   * `wanted` returns false (the preview stopped), it starts no more services and refuses.
   */
  prepare(
    design: Design,
    onOutput: (chunk: string) => void,
    wanted?: () => boolean,
  ): Promise<{ env: Record<string, string>; release: () => void }>;
  /** Stops every service and setup command. */
  close(): Promise<void>;
};

/** Every process group Finite started, killed when the server process exits. */
const groups = new Set<ChildProcess>();
process.on("exit", () => {
  for (const child of groups) killGroup(child, "SIGKILL");
});

/** Setup commands and services from `finite.json`, for previews of a workspace's apps. */
export function createWorkspaces(options: { startTimeoutMs: number }): Workspaces {
  const jobs = new Map<string, Job>();
  const services = new Map<string, Service>();

  function setup(key: string, commands: string[], cwd: string, env: Record<string, string>) {
    const existing = jobs.get(key);
    if (existing) return existing;
    const job: Job = { log: "", listeners: new Set(), done: Promise.resolve() };
    const write = (chunk: string) => {
      job.log = (job.log + chunk).slice(-LOG_TAIL);
      for (const fn of job.listeners) fn(chunk);
    };
    job.done = (async () => {
      for (const command of commands) {
        write(`$ ${command}\n`);
        const child = run(command, cwd, env);
        child.stdout?.on("data", (chunk: Buffer) => write(chunk.toString("utf8")));
        child.stderr?.on("data", (chunk: Buffer) => write(chunk.toString("utf8")));
        const exit = await exited(child);
        if (exit !== "code 0") {
          throw new Refused(
            `The setup command \`${command}\` failed (${exit}) in ${cwd}. Fix what its output says, or change setup in finite.json, then open the design again.`,
          );
        }
      }
    })();
    // A failed setup runs again on the next try.
    job.done.catch(() => jobs.delete(key));
    jobs.set(key, job);
    return job;
  }

  async function follow(job: Job, onOutput: (chunk: string) => void) {
    if (job.log) onOutput(job.log);
    job.listeners.add(onOutput);
    try {
      await job.done;
    } finally {
      job.listeners.delete(onOutput);
    }
  }

  function startService(workspace: Workspace, spec: WorkspaceService): Service {
    const key = `${workspace.root}\0${spec.name}`;
    const service: Service = {
      name: spec.name,
      child: undefined,
      refs: 0,
      ready: Promise.resolve(),
      log: "",
    };
    const where = `Service "${spec.name}" (\`${spec.run}\` in ${spec.dir})`;
    const failed = (reason: string) =>
      new Refused(
        `${where} ${reason}. Fix it, or change services.${spec.name} in finite.json, then open the design again.${service.log ? `\n\nIts output:\n${service.log}` : ""}`,
      );
    service.ready = (async () => {
      if (spec.ready !== undefined && (await answers(spec.ready))) return;
      const child = run(spec.run, spec.dir, envFor(workspace, { service: spec.name }));
      service.child = child;
      const append = (chunk: Buffer) => {
        service.log = (service.log + chunk.toString("utf8")).slice(-LOG_TAIL);
      };
      child.stdout?.on("data", append);
      child.stderr?.on("data", append);
      let exit: string | undefined;
      void exited(child).then((value) => {
        exit = value;
        if (services.get(key) === service) services.delete(key);
      });
      if (spec.ready === undefined) return;
      const deadline = Date.now() + options.startTimeoutMs;
      while (Date.now() < deadline) {
        if (exit) throw failed(`exited (${exit}) before it was ready`);
        if (await answers(spec.ready)) return;
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      }
      throw failed(
        `didn't answer on ${spec.ready} within ${Math.round(options.startTimeoutMs / 1000)}s`,
      );
    })();
    services.set(key, service);
    return service;
  }

  function release(service: Service) {
    service.refs -= 1;
    if (service.refs > 0) return;
    for (const [key, value] of services) if (value === service) services.delete(key);
    if (service.child) void stop(service.child);
  }

  return {
    async prepare(design, onOutput, wanted = () => true) {
      // A preview stopped while a setup command or a service ran starts nothing after it.
      const check = () => {
        if (!wanted()) throw new Refused("The design's preview was stopped before it was ready.");
      };
      if (!design.workspace || !design.app) return { env: {}, release: () => {} };
      const workspace = await readWorkspace(design.workspace);
      const app = workspace.apps[design.app];
      if (!app) {
        throw new Refused(
          `${workspace.file} has no app "${design.app}" any more. Add it back under apps, or connect the app again.`,
          "not-found",
        );
      }
      const env = envFor(workspace, { app: app.name });
      if (workspace.setup?.length) {
        check();
        const key = `${workspace.root}\0${workspace.hash}`;
        await follow(setup(key, workspace.setup, workspace.root, workspace.env ?? {}), onOutput);
      }
      if (app.setup?.length) {
        check();
        const key = `${workspace.root}\0${app.name}\0${workspace.hash}`;
        await follow(setup(key, app.setup, app.dir, env), onOutput);
      }

      const held: Service[] = [];
      const releaseAll = () => held.splice(0).forEach(release);
      try {
        for (const name of servicesFor(workspace, app.name)) {
          check();
          const service =
            services.get(`${workspace.root}\0${name}`) ??
            startService(workspace, workspace.services[name]!);
          service.refs += 1;
          held.push(service);
          await service.ready;
        }
      } catch (error) {
        releaseAll();
        throw error;
      }
      return { env, release: releaseAll };
    },

    async close() {
      jobs.clear();
      services.clear();
      await Promise.all([...groups].map(stop));
    },
  };
}

/** A shell command in its own process group, so stopping it stops everything it started. */
function run(command: string, cwd: string, env: Record<string, string>): ChildProcess {
  const child = spawn(command, {
    cwd,
    env: { ...process.env, ...env },
    shell: true,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  groups.add(child);
  child.once("exit", () => groups.delete(child));
  return child;
}

/** `code 0`, `code 1` or the signal, once the child exits or fails to start. */
function exited(child: ChildProcess): Promise<string> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(child.signalCode ?? `code ${child.exitCode}`);
  }
  return new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve(signal ?? `code ${code}`));
    child.once("error", (error) => resolve(`couldn't start: ${error.message}`));
  });
}

function killGroup(child: ChildProcess, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-child.pid!, signal);
    return true;
  } catch {
    return false;
  }
}

/** SIGTERM to the group, then SIGKILL after 5s if anything in it is still running. */
async function stop(child: ChildProcess): Promise<void> {
  if (!child.pid) return;
  const kill = setTimeout(() => killGroup(child, "SIGKILL"), KILL_AFTER_MS);
  if (killGroup(child, "SIGTERM")) await exited(child);
  // The shell can exit before what it started; the timer finishes those off.
  if (!killGroup(child, 0)) clearTimeout(kill);
}

/** A URL answers with a status below 500; a port accepts a TCP connection on 127.0.0.1. */
async function answers(ready: string | number): Promise<boolean> {
  if (typeof ready === "number") {
    return new Promise((resolve) => {
      const socket = net.connect({ host: "127.0.0.1", port: ready, timeout: 1_000 });
      const done = (ok: boolean) => {
        socket.destroy();
        resolve(ok);
      };
      socket.once("connect", () => done(true));
      socket.once("error", () => done(false));
      socket.once("timeout", () => done(false));
    });
  }
  try {
    const response = await fetch(ready, { signal: AbortSignal.timeout(2_000) });
    await response.body?.cancel();
    return response.status < 500;
  } catch {
    return false;
  }
}
