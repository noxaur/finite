import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { createStore, installOf } from "./index.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

describe("a blank design", () => {
  it("copies the scaffold, installs its dependencies and builds", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "finite-scaffold-"));
    cleanup.push(() => fs.rm(dataDir, { recursive: true, force: true }));
    const store = createStore({ dataDir });
    cleanup.push(() => store.close());

    const entry = await store.create({ name: "Acme Shop", kind: "blank" });
    expect(entry).toMatchObject({ name: "Acme Shop", origin: "blank" });
    expect(entry.root).toBe(path.join(dataDir, "projects", entry.id));

    const open = await store.open(entry.id);
    expect(open.design).toMatchObject({ router: "react-router", styling: "tailwind" });
    const canvases = await open.canvases();
    expect(canvases.map((c) => c.name).sort()).toEqual(["Brand", "Components", "Routes"]);
    expect(canvases.find((c) => c.name === "Routes")!.frames).toMatchObject([
      { name: "Home", source: { kind: "route", path: "/" } },
    ]);
    const pkg = JSON.parse(await fs.readFile(path.join(entry.root, "package.json"), "utf8"));
    expect(pkg.name).toBe("acme-shop");

    const install = installOf(open);
    expect(install?.state.status).toBe("starting");
    await install!.done;
    expect(installOf(open)).toBeUndefined();

    const { stdout } = await promisify(execFile)("npx", ["vite", "build"], { cwd: entry.root });
    expect(stdout).toContain("built in");
    await expect(fs.stat(path.join(entry.root, "dist/index.html"))).resolves.toBeTruthy();
  }, 180_000);
});
