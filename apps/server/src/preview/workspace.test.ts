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

  beforeAll(async () => {
    const fixture = await prepareFixture("monorepo", { install: false });
    cleanups.push(fixture.remove);
    root = fixture.root;
    port = await freePort();
    const file = path.join(root, "finite.json");
    const config = JSON.parse(fs.readFileSync(file, "utf8").replaceAll("4319", String(port)));
    // Counts the setup runs.
    config.setup.push("echo ran >> setup-runs.txt");
    fs.writeFileSync(file, JSON.stringify(config));
    previews = createPreviews({ host: "127.0.0.1" });
    cleanups.push(() => previews.close());
    previews.on("web-a", (event) => events.push(event));
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

  test("stops the api when the last preview that needs it stops", async () => {
    await previews.stop("web-a");
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

  test("a setup design doesn't start a preview", async () => {
    const root = tinyWorkspace({ apps: { app: { path: "app" } } });
    const design = { ...workspaceDesign("setup", root, "app", "app"), setup: true };
    await expect(previews.ensure(design)).rejects.toThrow(/setup hasn't finished/);
    expect(previews.state("setup")).toMatchObject({ status: "needs-setup" });
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
