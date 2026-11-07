import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { Design, PreviewEvent, Previews } from "@finite/protocol";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { prepareFixture } from "./fixtures.ts";
import { createPreviews } from "./index.ts";
import { createWorkspaces } from "./workspace.ts";

const cleanups: (() => unknown)[] = [];
afterAll(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
}, 60_000);

async function freePort(): Promise<number> {
  const server = net.createServer().listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

const answers = (url: string) =>
  fetch(url).then(
    (response) => response.text(),
    () => undefined,
  );

function workspaceDesign(id: string, workspace: string, app: string, dir: string): Design {
  return {
    id,
    name: id,
    root: path.join(workspace, dir),
    origin: "connected",
    router: "react-router",
    styling: "tailwind",
    css: ["src/index.css"],
    brandDir: "src/assets/brand",
    workspace,
    app,
  };
}

/** A workspace with one empty app, for the paths that fail before a dev server starts. */
function tinyWorkspace(config: object): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "finite-ws-")));
  fs.mkdirSync(path.join(root, "app"));
  fs.writeFileSync(path.join(root, "app/package.json"), "{}");
  fs.writeFileSync(path.join(root, "finite.json"), JSON.stringify(config));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

describe("a finite.json workspace", () => {
  let previews: Previews;
  let root: string;
  let port: number;
  const events: PreviewEvent[] = [];
  const file = () => path.join(root, "finite.json");
  const others: PreviewEvent[] = [];
  const apiStarts = () =>
    fs.readFileSync(path.join(root, "api-starts.txt"), "utf8").trim().split("\n");

  /** Writes finite.json and waits until both designs' previews stopped and are ready again. */
  async function restartWith(text: string) {
    const lists = [events, others].map((list) => ({ list, from: list.length }));
    fs.writeFileSync(file(), text);
    for (const { list, from } of lists) {
      const statuses = () =>
        list.slice(from).flatMap((e) => (e.type === "preview" ? [e.status] : []));
      await expect.poll(statuses, { timeout: 120_000 }).toContain("ready");
      expect(statuses()[0]).toBe("stopped");
    }
  }

  beforeAll(async () => {
    const fixture = await prepareFixture("monorepo", { install: false });
    cleanups.push(fixture.remove);
    root = fixture.root;
    port = await freePort();
    const config = JSON.parse(fs.readFileSync(file(), "utf8").replaceAll("4319", String(port)));
    // Counts the setup runs and the api's starts.
    config.setup.push("echo ran >> setup-runs.txt");
    config.services.api.run = `echo $$ >> api-starts.txt; ${config.services.api.run}`;
    fs.writeFileSync(file(), JSON.stringify(config));
    previews = createPreviews({ host: "127.0.0.1" });
    cleanups.push(() => previews.close());
    previews.on("web-a", (event) => events.push(event));
    previews.on("web-b", (event) => others.push(event));
  });

  test("runs setup once, starts the api, then the dev server with finite.json's env", async () => {
    const [a, b] = await Promise.all([
      previews.ensure(workspaceDesign("web-a", root, "web", "apps/web")),
      previews.ensure(workspaceDesign("web-b", root, "web", "apps/web")),
    ]);
    expect(fs.readFileSync(path.join(root, "setup-runs.txt"), "utf8")).toBe("ran\n");
    const starting = events.filter((e) => e.type === "preview" && e.status === "starting");
    expect(starting.some((e) => e.type === "preview" && e.log?.includes("$ pnpm install"))).toBe(
      true,
    );
    expect(await answers(`http://127.0.0.1:${port}/hello`)).toBe("Hello from the api");
    // The page reads the api's port from import.meta.env, which Vite fills from the env.
    const home = await answers(`${a.url}/src/pages/Home.tsx`);
    expect(home).toContain(`"${port}"`);
    expect(b.url).not.toBe(a.url);
  }, 240_000);

  test("sends the routes again when finite.json's routes change, restarting nothing", async () => {
    const sent = () => events.filter((e) => e.type === "routes").length;
    await expect.poll(sent).toBeGreaterThan(0);
    const before = sent();
    const states = events.filter((e) => e.type === "preview").length;
    const config = JSON.parse(fs.readFileSync(file(), "utf8"));
    config.apps.web.routes = { "/custom": {} };
    fs.writeFileSync(file(), JSON.stringify(config));
    await expect.poll(sent, { timeout: 10_000 }).toBeGreaterThan(before);
    expect(events.filter((e) => e.type === "preview").length).toBe(states);
    expect(fs.readFileSync(path.join(root, "setup-runs.txt"), "utf8")).toBe("ran\n");
  }, 30_000);

  test("an invalid finite.json keeps the preview running and says why", async () => {
    const valid = fs.readFileSync(file(), "utf8");
    const { url } = previews.state("web-a");
    fs.writeFileSync(file(), valid.replace(`"needs":["api"]`, `"needs":["apu"]`));
    await expect
      .poll(() => previews.state("web-a"), { timeout: 10_000 })
      .toMatchObject({ status: "ready", url, log: expect.stringContaining(`no service "apu"`) });
    expect(await answers(`http://127.0.0.1:${port}/health`)).toBe("ok");
    fs.writeFileSync(file(), valid);
    await expect
      .poll(() => previews.state("web-a"), { timeout: 10_000 })
      .toEqual({ status: "ready", url });
  }, 30_000);

  test("an app's env change restarts its dev servers and leaves the api running", async () => {
    const config = JSON.parse(fs.readFileSync(file(), "utf8"));
    config.apps.web.env = { VITE_GREETING: "hi" };
    await restartWith(JSON.stringify(config));
    expect(apiStarts()).toHaveLength(1);
    expect(fs.readFileSync(path.join(root, "setup-runs.txt"), "utf8")).toBe("ran\n");
  }, 120_000);

  test("an env change restarts the api, the setup and both dev servers with the new env", async () => {
    const oldPort = port;
    port = await freePort();
    await restartWith(fs.readFileSync(file(), "utf8").replaceAll(String(oldPort), String(port)));
    expect(await answers(`http://127.0.0.1:${port}/hello`)).toBe("Hello from the api");
    expect(await answers(`http://127.0.0.1:${oldPort}/health`)).toBeUndefined();
    for (const id of ["web-a", "web-b"]) {
      const home = await answers(`${previews.state(id).url}/src/pages/Home.tsx`);
      expect(home).toContain(`"${port}"`);
    }
    expect(apiStarts()).toHaveLength(2);
    // The workspace's setup env changed, so it ran again, once for both designs.
    expect(fs.readFileSync(path.join(root, "setup-runs.txt"), "utf8")).toBe("ran\nran\n");
  }, 240_000);

  test("a stop during a restart keeps the preview stopped", async () => {
    // Stops it as the restart's stop begins, while the old dev server is still exiting.
    let stopping: Promise<void> | undefined;
    const off = previews.on("web-a", (event) => {
      if (event.type !== "preview" || event.status !== "stopped" || stopping) return;
      stopping = Promise.resolve().then(() => previews.stop("web-a"));
    });
    const config = JSON.parse(fs.readFileSync(file(), "utf8"));
    config.apps.web.env = { VITE_GREETING: "again" };
    fs.writeFileSync(file(), JSON.stringify(config));
    await expect.poll(() => stopping !== undefined, { timeout: 10_000 }).toBe(true);
    off();
    await stopping;
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    expect(previews.state("web-a")).toEqual({ status: "stopped" });
  }, 30_000);

  test("stops the api when the last preview that needs it stops", async () => {
    expect(await answers(`http://127.0.0.1:${port}/health`)).toBe("ok");
    await previews.stop("web-b");
    await expect
      .poll(() => answers(`http://127.0.0.1:${port}/health`), { timeout: 10_000 })
      .toBeUndefined();
  }, 30_000);
});

describe("finite.json failures", () => {
  const previews = createPreviews({ host: "127.0.0.1", startTimeoutMs: 1_500 });
  cleanups.push(() => previews.close());

  test("a failing setup command errors the preview with the command, exit code and output", async () => {
    const root = tinyWorkspace({
      setup: ["echo preparing", "echo broken >&2; exit 3"],
      apps: { app: { path: "app" } },
    });
    await expect(previews.ensure(workspaceDesign("bad-setup", root, "app", "app"))).rejects.toThrow(
      /`echo broken >&2; exit 3` failed \(code 3\)/,
    );
    const state = previews.state("bad-setup");
    expect(state.status).toBe("error");
    expect(state.log).toContain("preparing");
    expect(state.log).toContain("broken");
  });

  test("a service that never gets ready errors the preview with its output", async () => {
    const root = tinyWorkspace({
      apps: { app: { path: "app", needs: ["slow"] } },
      services: { slow: { run: "echo waiting; sleep 30", ready: await freePort() } },
    });
    await expect(previews.ensure(workspaceDesign("slow", root, "app", "app"))).rejects.toThrow(
      /Service "slow" .* didn't answer on \d+ within 2s/,
    );
    const state = previews.state("slow");
    expect(state.status).toBe("error");
    expect(state.log).toContain("waiting");
  });

  test("a preview stopped during setup starts no service and no dev server", async () => {
    const root = tinyWorkspace({
      setup: ["sleep 1; touch setup-done"],
      apps: { app: { path: "app", needs: ["api"] } },
      services: { api: { run: "touch started; sleep 30", ready: await freePort() } },
    });
    const events: PreviewEvent[] = [];
    previews.on("stopped-early", (event) => events.push(event));
    const ready = previews.ensure(workspaceDesign("stopped-early", root, "app", "app"));
    await expect
      .poll(() => events.some((e) => e.type === "preview" && e.log?.includes("$ sleep 1")))
      .toBe(true);
    await previews.stop("stopped-early");
    await expect(ready).rejects.toThrow(/stopped before it was ready/);
    const after = events.length;
    // The shared setup command still finishes; nothing starts after it.
    await expect
      .poll(() => fs.existsSync(path.join(root, "setup-done")), { timeout: 5_000 })
      .toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(fs.existsSync(path.join(root, "started"))).toBe(false);
    expect(previews.state("stopped-early")).toEqual({ status: "stopped" });
    expect(events.length).toBe(after);
  });

  test("a setup design doesn't start a preview", async () => {
    const root = tinyWorkspace({ apps: { app: { path: "app" } } });
    const design = { ...workspaceDesign("setup", root, "app", "app"), setup: true };
    await expect(previews.ensure(design)).rejects.toThrow(/setup hasn't finished/);
    expect(previews.state("setup")).toMatchObject({ status: "needs-setup" });
  });

  test("a setup design's preview says why detection refuses its folder, read again on open", async () => {
    const root = tinyWorkspace({ apps: { app: { path: "app" } } });
    const design = { ...workspaceDesign("setup-why", root, "app", "app"), setup: true };
    const first = previews.ensure(design);
    // Never "starting", even while detection runs.
    expect(previews.state("setup-why")).toEqual({ status: "needs-setup" });
    await expect(first).rejects.toThrow(/setup hasn't finished/);
    expect(previews.state("setup-why").log).toBe(
      `${path.join(root, "app")} doesn't use Vite or Next.js (no vite or next in package.json). ` +
        "Finite supports Next.js apps (App Router or Pages Router) and Vite apps that use React Router (react-router or react-router-dom) or TanStack Router (@tanstack/react-router).\n\n" +
        "Its finite.json setup hasn't finished. Finish the setup thread, which writes finite.json and calls finish_setup, then open the design again.",
    );
    fs.writeFileSync(
      path.join(root, "app/package.json"),
      JSON.stringify({ devDependencies: { vite: "8" } }),
    );
    await expect(previews.ensure(design)).rejects.toThrow(/no supported router/);
    expect(previews.state("setup-why").log).toMatch(/^\S+ has no supported router/);
  });
});

describe("finite.json services", () => {
  test("uses a service that's already answering instead of starting it", async () => {
    const server = http.createServer((_, response) => response.end("mine"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => server.close());
    const { port } = server.address() as net.AddressInfo;
    const root = tinyWorkspace({
      apps: { app: { path: "app", needs: ["api"] } },
      services: { api: { run: "touch started", ready: `http://127.0.0.1:${port}/` } },
    });
    const workspaces = createWorkspaces({ startTimeoutMs: 5_000 });
    const { release } = await workspaces.prepare(
      workspaceDesign("own", root, "app", "app"),
      () => {},
    );
    expect(fs.existsSync(path.join(root, "started"))).toBe(false);
    release();
    await workspaces.close();
    expect(await answers(`http://127.0.0.1:${port}/`)).toBe("mine");
  });
});

describe("finite.json changes", () => {
  const alive = (pid: string) => {
    try {
      process.kill(Number(pid), 0);
      return true;
    } catch {
      return false;
    }
  };
  const lines = (file: string) =>
    fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n") : [];

  test("restarts only the services whose definition changed, and stops unneeded ones", async () => {
    const service = (name: string) => ({ run: `echo $$ >> ${name}.pids; exec sleep 30` });
    const config = {
      apps: { app: { path: "app", needs: ["a", "b"] } },
      services: { a: service("a"), b: service("b") },
    };
    const root = tinyWorkspace(config);
    const write = () => fs.writeFileSync(path.join(root, "finite.json"), JSON.stringify(config));
    const design = workspaceDesign("changes", root, "app", "app");
    const workspaces = createWorkspaces({ startTimeoutMs: 5_000 });
    cleanups.push(() => workspaces.close());
    const pids = (name: string) => lines(path.join(root, `${name}.pids`));

    const first = await workspaces.prepare(design, () => {});
    await expect.poll(() => pids("a").length + pids("b").length).toBe(2);

    config.apps.app = { ...config.apps.app, routes: { "/x": {} } } as typeof config.apps.app;
    write();
    expect(await workspaces.version(design)).toBe(first.version);

    config.services.a = { ...service("a"), env: { MODE: "new" } } as typeof config.services.a;
    write();
    const second = await workspaces.prepare(design, () => {});
    first.release();
    expect(second.version).not.toBe(first.version);
    await expect.poll(() => pids("a").length).toBe(2);
    await expect.poll(() => alive(pids("a")[0]!)).toBe(false);
    expect(pids("b")).toHaveLength(1);
    expect(alive(pids("b")[0]!)).toBe(true);

    config.apps.app.needs = ["a"];
    write();
    const third = await workspaces.prepare(design, () => {});
    second.release();
    await expect.poll(() => alive(pids("b")[0]!)).toBe(false);
    expect(pids("a")).toHaveLength(2);
    expect(alive(pids("a")[1]!)).toBe(true);
    third.release();
  });

  test("starts a changed service only once the old one's process group is gone", async () => {
    const port = await freePort();
    // The shell exits on SIGTERM at once; the server it started holds the port a while longer.
    const server = `require('http').createServer((q, r) => r.end(process.env.MODE)).listen(${port}, '127.0.0.1'); process.on('SIGTERM', () => setTimeout(() => process.exit(), 700))`;
    const config = {
      apps: { app: { path: "app", needs: ["api"] } },
      services: { api: { run: `node -e "${server}"; true`, ready: port, env: { MODE: "old" } } },
    };
    const root = tinyWorkspace(config);
    const design = workspaceDesign("lingering", root, "app", "app");
    const workspaces = createWorkspaces({ startTimeoutMs: 5_000 });
    cleanups.push(() => workspaces.close());
    const first = await workspaces.prepare(design, () => {});
    expect(await answers(`http://127.0.0.1:${port}/`)).toBe("old");
    config.services.api.env.MODE = "new";
    fs.writeFileSync(path.join(root, "finite.json"), JSON.stringify(config));
    const second = await workspaces.prepare(design, () => {});
    first.release();
    expect(await answers(`http://127.0.0.1:${port}/`)).toBe("new");
    second.release();
  });

  test("runs a setup again when finite.json goes back to it", async () => {
    const mode = (name: string) => `echo ${name} > mode`;
    const config = { setup: [mode("a")], apps: { app: { path: "app" } } };
    const root = tinyWorkspace(config);
    const design = workspaceDesign("revert", root, "app", "app");
    const workspaces = createWorkspaces({ startTimeoutMs: 1_000 });
    cleanups.push(() => workspaces.close());
    for (const name of ["a", "b", "a", "", "a"]) {
      config.setup = name ? [mode(name)] : [];
      fs.writeFileSync(path.join(root, "finite.json"), JSON.stringify(config));
      fs.rmSync(path.join(root, "mode"), { force: true });
      await workspaces.prepare(design, () => {});
      expect(lines(path.join(root, "mode"))).toEqual(name ? [name] : []);
    }
  });

  test("a setup command after one that exits on SIGTERM doesn't start after close", async () => {
    const config = {
      setup: ["trap 'exit 0' TERM; sleep 2 & wait", "touch next"],
      apps: { app: { path: "app" } },
    };
    const root = tinyWorkspace(config);
    const workspaces = createWorkspaces({ startTimeoutMs: 1_000 });
    const done = workspaces.prepare(workspaceDesign("trap", root, "app", "app"), () => {});
    await new Promise((resolve) => setTimeout(resolve, 300));
    // It refuses while close runs, so the check is attached first.
    const refused = expect(done).rejects.toThrow(/shutting down/);
    await workspaces.close();
    await refused;
    expect(fs.existsSync(path.join(root, "next"))).toBe(false);
  });

  test("a setup waiting for the one before it doesn't start after close", async () => {
    const config = { setup: ["sleep 1"], apps: { app: { path: "app" } } };
    const root = tinyWorkspace(config);
    const workspaces = createWorkspaces({ startTimeoutMs: 1_000 });
    const first = workspaces.prepare(workspaceDesign("one", root, "app", "app"), () => {});
    await new Promise((resolve) => setTimeout(resolve, 200));
    config.setup = ["touch queued"];
    fs.writeFileSync(path.join(root, "finite.json"), JSON.stringify(config));
    const second = workspaces.prepare(workspaceDesign("two", root, "app", "app"), () => {});
    await new Promise((resolve) => setTimeout(resolve, 200));
    const refused = Promise.all([
      expect(first).rejects.toThrow(),
      expect(second).rejects.toThrow(/shutting down/),
    ]);
    await workspaces.close();
    await refused;
    expect(fs.existsSync(path.join(root, "queued"))).toBe(false);
  });

  test("refuses the version of an invalid finite.json", async () => {
    const root = tinyWorkspace({ apps: { app: { path: "app", needs: ["api"] } } });
    const workspaces = createWorkspaces({ startTimeoutMs: 1_000 });
    await expect(
      workspaces.version(workspaceDesign("invalid", root, "app", "app")),
    ).rejects.toMatchObject({ code: "invalid-config" });
  });

  test("a changed setup waits for the one before it in the same workspace", async () => {
    const step = (n: number) => `echo start${n} >> order; sleep 0.5; echo end${n} >> order`;
    const config = { setup: [step(1)], apps: { app: { path: "app" } } };
    const root = tinyWorkspace(config);
    const workspaces = createWorkspaces({ startTimeoutMs: 1_000 });
    cleanups.push(() => workspaces.close());
    const order = path.join(root, "order");
    const first = workspaces.prepare(workspaceDesign("one", root, "app", "app"), () => {});
    await expect.poll(() => lines(order)).toEqual(["start1"]);
    config.setup = [step(2)];
    fs.writeFileSync(path.join(root, "finite.json"), JSON.stringify(config));
    await workspaces.prepare(workspaceDesign("two", root, "app", "app"), () => {});
    await first;
    expect(lines(order)).toEqual(["start1", "end1", "start2", "end2"]);
  });
});
