import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { Design, Previews } from "@finite/protocol";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { handlers } from "../handlers.ts";
import { type Client, type Context, createHub, type Modules } from "../hub.ts";
import { createPreviews } from "./index.ts";

/** A dev server child that does nothing until the test says so. */
class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  signals: (NodeJS.Signals | number | undefined)[] = [];
  kill(signal?: NodeJS.Signals | number) {
    this.signals.push(signal);
    return true;
  }
  ready() {
    this.emit("message", { type: "ready", url: "http://127.0.0.1:1" });
  }
  fail() {
    this.emit("message", { type: "error", message: "boom" });
  }
  exit() {
    this.exitCode = 0;
    this.emit("exit", 0, null);
  }
}

const children = vi.hoisted(() => [] as unknown[]) as FakeChild[];

vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return {
    ...actual,
    fork: (() => {
      const child = new FakeChild();
      children.push(child);
      return child as unknown as ChildProcess;
    }) as typeof actual.fork,
  };
});

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const forked = async (count: number) => expect.poll(() => children.length).toBe(count);

const cleanups: (() => unknown)[] = [];
let previews: Previews;

function design(id = "d", fields: Partial<Design> = {}): Design {
  return {
    id,
    name: id,
    root: os.tmpdir(),
    origin: "connected",
    router: "react-router",
    styling: "inline",
    css: [],
    brandDir: "src/assets/brand",
    ...fields,
  };
}

/** A workspace whose app needs a service that exits once the file `die` exists. */
async function serviceWorkspace(): Promise<{ root: string; design: Design }> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "finite-lifecycle-")));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "app"));
  fs.writeFileSync(path.join(root, "app/package.json"), "{}");
  const server = net.createServer().listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  const script = `require('http').createServer((q,r)=>r.end()).listen(${port},'127.0.0.1');setInterval(()=>{if(require('fs').existsSync('die'))process.exit(1)},20)`;
  fs.writeFileSync(
    path.join(root, "finite.json"),
    JSON.stringify({
      apps: { app: { path: "app", needs: ["api"] } },
      services: { api: { run: `node -e "${script}"`, ready: port } },
    }),
  );
  return {
    root,
    design: design("d", { root: path.join(root, "app"), workspace: root, app: "app" }),
  };
}

beforeEach(() => {
  children.length = 0;
  previews = createPreviews({ host: "127.0.0.1", graceMs: 20 });
  cleanups.push(() => {
    for (const child of children) if (child.exitCode === null) child.exit();
    return previews.close();
  });
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("a preview nobody watches", () => {
  test("goes on the idle timer once ensure settles", async () => {
    const up = previews.ensure(design());
    children[0]!.ready();
    await up;
    expect(previews.state("d").status).toBe("ready");
    await expect.poll(() => previews.state("d").status).toBe("stopped");
  });

  test("started after the last viewer left stops after the grace period", async () => {
    previews.watch("d");
    previews.idle("d");
    const up = previews.ensure(design());
    children[0]!.ready();
    await up;
    await expect.poll(() => previews.state("d").status).toBe("stopped");
  });

  test("a watched preview stays up, and idles when the last viewer leaves", async () => {
    const open = {
      design: design(),
      canvases: async () => [],
      threads: async () => [],
      on: () => () => {},
    };
    const modules = {
      previews,
      store: { open: async () => open, on: () => () => {} },
    } as unknown as Modules;
    const hub = createHub(modules);
    const client: Client = {
      id: 1,
      user: undefined,
      subscriptions: new Set(),
      send: () => {},
    };
    const ctx = { client, hub, modules, by: { kind: "person", user: "u" } } as unknown as Context;
    const opened = handlers.subscribe({ designId: "d" }, ctx);
    await forked(1);
    children[0]!.ready();
    await opened;
    await tick(60);
    expect(previews.state("d").status).toBe("ready");
    await handlers.unsubscribe({ designId: "d" }, ctx);
    await expect.poll(() => previews.state("d").status).toBe("stopped");
  });

  test("a viewer leaving while finite.json restarts the preview only stops it", async () => {
    const { root, design: workspaceDesign } = await serviceWorkspace();
    previews.watch("d");
    const up = previews.ensure(workspaceDesign);
    await forked(1);
    children[0]!.ready();
    await up;
    await expect.poll(() => fs.existsSync(path.join(root, "finite.json"))).toBe(true);
    await tick(50);
    const config = JSON.parse(fs.readFileSync(path.join(root, "finite.json"), "utf8"));
    fs.writeFileSync(
      path.join(root, "finite.json"),
      JSON.stringify({ ...config, env: { CHANGED: "1" } }),
    );
    await expect.poll(() => children[0]!.signals.length, { timeout: 5_000 }).toBeGreaterThan(0);
    previews.idle("d");
    children[0]!.exit();
    await tick(100);
    expect(children).toHaveLength(1);
    expect(previews.state("d").status).toBe("stopped");
  }, 15_000);
});

describe("a preview that failed", () => {
  test("stops its dev server when a service it needs dies", async () => {
    const { root, design: workspaceDesign } = await serviceWorkspace();
    previews.watch("d");
    const up = previews.ensure(workspaceDesign);
    await forked(1);
    children[0]!.ready();
    await up;
    fs.writeFileSync(path.join(root, "die"), "");
    await expect.poll(() => previews.state("d").status, { timeout: 5_000 }).toBe("error");
    expect(children[0]!.signals).toContain("SIGTERM");
  }, 15_000);

  test("gives callers during its stop one new dev server", async () => {
    previews.watch("d");
    const failed = previews.ensure(design());
    children[0]!.fail();
    await expect(failed).rejects.toThrow(/boom/);
    const first = previews.ensure(design());
    const second = previews.ensure(design());
    await tick();
    children[0]!.exit();
    await forked(2);
    await tick();
    expect(children).toHaveLength(2);
    children[1]!.ready();
    await expect(first).resolves.toEqual({ url: "http://127.0.0.1:1" });
    await expect(second).resolves.toEqual({ url: "http://127.0.0.1:1" });
    const stopped = previews.stop("d");
    expect(children[1]!.signals).toContain("SIGTERM");
    children[1]!.exit();
    await stopped;
  });
});

describe("a removed design", () => {
  test("starts nothing for an ensure that was waiting on a stop", async () => {
    previews.watch("d");
    const failed = previews.ensure(design());
    children[0]!.fail();
    await expect(failed).rejects.toThrow(/boom/);
    const waiting = previews.ensure(design());
    await tick();
    const removed = previews.remove("d");
    children[0]!.exit();
    await removed;
    await expect(waiting).rejects.toThrow(/removed/);
    await tick();
    expect(children).toHaveLength(1);
    expect(previews.state("d")).toEqual({ status: "stopped" });
  });

  test("refuses an ensure that comes after design.remove", async () => {
    const stopDesign = vi.fn(async () => {});
    const remove = vi.fn(async () => {});
    const modules = {
      previews,
      agents: { stopDesign },
      store: { remove },
    } as unknown as Modules;
    await handlers["design.remove"]({ id: "d" }, { modules } as unknown as Context);
    expect(remove).toHaveBeenCalledWith("d");
    await expect(previews.ensure(design())).rejects.toThrow(/removed/);
    expect(children).toHaveLength(0);
  });
});
