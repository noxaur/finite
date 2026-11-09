import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

/** A child process that is only as real as the tests need: it can fail to spawn, crash and obey SIGTERM. */
class FakeChild extends EventEmitter {
  exited = false;
  readonly signals: string[] = [];
  constructor(
    readonly spawnFails: boolean,
    private readonly unhandled: Error[],
  ) {
    super();
  }
  /** Node emits `error` with no listener as an uncaught exception, which Electron shows as a dialog. */
  override emit(event: string | symbol, ...args: unknown[]): boolean {
    if (event === "error" && this.listenerCount("error") === 0) {
      this.unhandled.push(args[0] as Error);
      return false;
    }
    return super.emit(event, ...args);
  }
  get pid() {
    return this.spawnFails ? undefined : 4242;
  }
  kill(signal: string) {
    if (this.spawnFails || this.exited) return false;
    this.signals.push(signal);
    if (signal === "SIGTERM") queueMicrotask(() => this.stop(null, "SIGTERM"));
    return true;
  }
  stop(code: number | null, signal: string | null) {
    this.exited = true;
    this.emit("exit", code, signal);
  }
}

const fake = vi.hoisted(() => {
  return {
    /** The app's listeners by event name; a fresh import of `main.ts` registers its own. */
    listeners: new Map<string, Array<(...args: never[]) => void>>(),
    /** What each `spawn` call does, in order; "live" once the list runs out. */
    spawns: [] as Array<"live" | "fail">,
    children: [] as unknown[],
    unhandled: [] as Error[],
    exited: false,
    errorBoxes: 0,
    ready: undefined as undefined | Promise<void>,
    /** Held back until a test calls it, so a quit can land while `startServer` awaits. */
    shellPath: undefined as undefined | Promise<string>,
  };
});

vi.mock("electron", () => {
  const app = {
    isPackaged: false,
    whenReady: () => fake.ready,
    getPath: () => "/tmp/finite-test",
    on(event: string, listener: (...args: never[]) => void) {
      fake.listeners.set(event, [...(fake.listeners.get(event) ?? []), listener]);
    },
    /** Electron emits `before-quit` and exits unless a listener prevents it. */
    quit() {
      let prevented = false;
      for (const listener of fake.listeners.get("before-quit") ?? []) {
        (listener as (event: { preventDefault(): void }) => void)({
          preventDefault: () => {
            prevented = true;
          },
        });
      }
      if (!prevented) fake.exited = true;
    },
  };
  class BrowserWindow {
    webContents = { setWindowOpenHandler() {}, openDevTools() {} };
    once() {}
    loadURL = async () => {};
    static getAllWindows = () => [];
    static fromWebContents = () => null;
    static getFocusedWindow = () => null;
  }
  return {
    app,
    BrowserWindow,
    dialog: {
      showErrorBox: () => {
        fake.errorBoxes++;
      },
    },
    ipcMain: { handle() {} },
    Menu: { setApplicationMenu() {}, buildFromTemplate: () => ({}) },
    session: { defaultSession: { clearCache: async () => {} } },
    shell: { openExternal() {} },
  };
});

vi.mock("node:child_process", () => ({
  spawn: () => {
    const child = new FakeChild(fake.spawns.shift() === "fail", fake.unhandled);
    fake.children.push(child);
    // Node reports a failed spawn (ENOENT, EAGAIN) as `error` on the next tick, and never as `exit`.
    if (child.spawnFails) {
      setImmediate(() =>
        child.emit("error", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" })),
      );
    }
    return child;
  },
}));

vi.mock("node:net", () => ({
  createServer: () => {
    const probe = new EventEmitter() as EventEmitter & Record<string, unknown>;
    probe.listen = (_port: number, _host: string, done: () => void) => queueMicrotask(done);
    probe.address = () => ({ port: 4100 });
    probe.close = (done: () => void) => done();
    return probe;
  },
}));

vi.mock("./shellPath.js", () => ({
  loginShellPath: () => fake.shellPath ?? Promise.resolve("/usr/bin"),
}));
vi.mock("./updates.js", () => ({ keepUpToDate() {}, offerMoveToApplications: async () => {} }));

/** Lets queued microtasks, immediates and the `whenReady` chain run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

async function launch(...spawns: Array<"live" | "fail">) {
  fake.spawns = spawns;
  vi.resetModules();
  await import("./main.js");
  await settle();
  const { app } = await import("electron");
  return { app, children: fake.children as FakeChild[] };
}

beforeEach(() => {
  fake.listeners.clear();
  fake.spawns = [];
  fake.children = [];
  fake.unhandled = [];
  fake.exited = false;
  fake.errorBoxes = 0;
  fake.shellPath = undefined;
  fake.ready = Promise.resolve();
  vi.stubGlobal("fetch", async () => ({ ok: true }));
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("a server that fails to spawn", () => {
  it("is treated as a stop, so it is retried (FailedSpawnHandled, OpenAppHasServer)", async () => {
    const { children } = await launch("fail", "live");
    expect(fake.unhandled).toEqual([]);
    expect(children).toHaveLength(2);
    expect(children[1]?.pid).toBeDefined();
  });

  it("is retried when a respawn fails after a crash (OpenAppHasServer)", async () => {
    const { children } = await launch("live", "fail", "live");
    children[0]?.stop(1, null);
    await settle();
    expect(fake.unhandled).toEqual([]);
    expect(children).toHaveLength(3);
    expect(children[2]?.pid).toBeDefined();
  });

  it("gives up with the error dialog and quits after three stops (QuitFinishes)", async () => {
    await launch("fail", "fail", "fail");
    expect(fake.children).toHaveLength(3);
    expect(fake.errorBoxes).toBe(1);
    expect(fake.exited).toBe(true);
  });

  it("does not stop the app from quitting (QuitFinishes)", async () => {
    const { app } = await launch("fail", "fail", "fail", "live");
    app.quit();
    await settle();
    expect(fake.exited).toBe(true);
  });
});

describe("quitting", () => {
  it("stops a live server and then exits", async () => {
    const { app, children } = await launch("live");
    app.quit();
    expect(fake.exited).toBe(false);
    await settle();
    expect(children[0]?.signals).toEqual(["SIGTERM"]);
    expect(fake.exited).toBe(true);
  });

  it("while the server is starting never starts one (QuitLeavesNoServer)", async () => {
    let resolvePath!: (path: string) => void;
    fake.shellPath = new Promise((resolve) => {
      resolvePath = resolve;
    });
    const { app } = await launch();
    app.quit();
    expect(fake.exited).toBe(true);
    resolvePath("/usr/bin");
    await settle();
    expect(fake.children).toHaveLength(0);
  });
});
