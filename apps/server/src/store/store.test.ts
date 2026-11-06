import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Actor, Canvas, DesignChange, Frame } from "@finite/protocol";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { createStore, DEFAULT_SETTINGS, type FileStore } from "./index.ts";
import { REMOVED_KEEP_MS } from "./open.ts";

const by: Actor = { kind: "person", id: "u1", name: "Per" };
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "finite-store-"));
  cleanup.push(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

function newStore(dataDir: string): FileStore {
  const store = createStore({ dataDir });
  cleanup.push(() => store.close());
  return store;
}

/** A project folder with this package.json and these files. */
async function project(deps: Record<string, string>, files: Record<string, string> = {}) {
  const root = await tempDir();
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "shop", devDependencies: deps }),
  );
  for (const [file, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), text);
  }
  return root;
}

const rrTailwind = {
  vite: "^8",
  "react-router": "^8",
  tailwindcss: "^4",
};

function frame(id: string, x = 0): Frame {
  return { id, name: id, x, y: 0, width: 100, height: 100, source: { kind: "route", path: "/" } };
}

async function connected(files: Record<string, string> = {}) {
  const dataDir = await tempDir();
  const store = newStore(dataDir);
  const root = await project(rrTailwind, {
    "src/styles.css": '@import "tailwindcss";\n',
    ...files,
  });
  const entry = await store.connect(root);
  return { dataDir, store, root, entry, open: await store.open(entry.id) };
}

describe("settings", () => {
  it("starts with the defaults and keeps what's set", async () => {
    const dir = await tempDir();
    const store = newStore(dir);
    expect(await store.settings()).toEqual(DEFAULT_SETTINGS);
    const next = await store.setSettings({ sendMode: "queue", effort: "high" });
    expect(next).toEqual({ ...DEFAULT_SETTINGS, sendMode: "queue", effort: "high" });
    expect(await newStore(dir).settings()).toEqual(next);
  });

  it("reads an old pinned default model as Claude's alias for it", async () => {
    const dir = await tempDir();
    await fs.writeFile(
      path.join(dir, "settings.json"),
      JSON.stringify({ model: "claude-opus-5-5" }),
    );
    expect((await newStore(dir).settings()).model).toBe("opus");
  });
});

describe("connect", () => {
  it("refuses folders it can't run, saying what's supported", async () => {
    const store = newStore(await tempDir());
    const empty = await tempDir();
    await expect(store.connect(empty)).rejects.toMatchObject({
      code: "unsupported-project",
      message: expect.stringMatching(/no package\.json.*React Router.*TanStack Router/),
    });
    await expect(store.connect(await project({ react: "^19" }))).rejects.toMatchObject({
      code: "unsupported-project",
      message: expect.stringContaining("doesn't use Vite"),
    });
    await expect(store.connect(await project({ vite: "^8", wouter: "^3" }))).rejects.toMatchObject({
      code: "unsupported-project",
      message: expect.stringContaining("no supported router"),
    });
  });

  it("detects the router and styling, writes design.json and makes the pages", async () => {
    const { store, root, entry, open } = await connected();
    expect(entry).toMatchObject({ name: "shop", root, origin: "connected" });
    expect(open.design).toMatchObject({
      router: "react-router",
      styling: "tailwind",
      css: ["src/styles.css"],
      brandDir: "src/assets/brand",
    });
    const config = JSON.parse(await fs.readFile(path.join(root, ".finite/design.json"), "utf8"));
    expect(config).toMatchObject({ version: 1, id: entry.id });
    expect((await open.canvases()).map((c) => c.name).sort()).toEqual([
      "Brand",
      "Components",
      "Routes",
    ]);
    // Connecting the same folder again is the same design.
    const same = { ...entry, updatedAt: expect.any(Number) };
    expect(await store.connect(root)).toEqual(same);
    expect(await store.designs()).toEqual([same]);
  });

  it("tells TanStack, CSS modules and inline styles apart", async () => {
    const store = newStore(await tempDir());
    const tanstack = await project(
      { vite: "^8", "@tanstack/react-router": "^1" },
      {
        "src/main.tsx": 'import "./index.css";\nimport styles from "./a.module.css";',
        "src/A.tsx":
          'import s from "./a.module.css";\nexport const A = () => <div className={s.a} />;',
      },
    );
    const a = await store.open((await store.connect(tanstack)).id);
    expect(a.design).toMatchObject({
      router: "tanstack",
      styling: "css-modules",
      css: ["src/index.css"],
    });
    const inline = await project(
      { vite: "^8", "react-router-dom": "^6" },
      { "src/A.tsx": "export const A = () => <div style={{ color: 'red' }} />;" },
    );
    expect((await store.open((await store.connect(inline)).id)).design.styling).toBe("inline");
  });

  it("renames a design and bumps updatedAt on any change", async () => {
    const { dataDir, store, entry, open } = await connected();
    const renamed = await store.rename(entry.id, "Storefront");
    expect(renamed).toMatchObject({ name: "Storefront", updatedAt: expect.any(Number) });
    const before = renamed.updatedAt;
    await new Promise((r) => setTimeout(r, 5));
    await open.createCanvas({ kind: "page", name: "Checkout" }, by);
    const [touched] = await store.designs();
    expect(touched!.updatedAt).toBeGreaterThan(before);
    // The bump reaches designs.json when the store closes, at the latest.
    await store.close();
    expect(await newStore(dataDir).designs()).toEqual([touched]);
  });

  it("forgets a connected design on remove but leaves its folder", async () => {
    const { store, root, entry } = await connected();
    const lists: unknown[] = [];
    store.on((list) => lists.push(list));
    await store.remove(entry.id);
    expect(await store.designs()).toEqual([]);
    expect(lists).toEqual([[]]);
    await expect(fs.stat(path.join(root, "package.json"))).resolves.toBeTruthy();
    await expect(store.open(entry.id)).rejects.toMatchObject({ code: "not-found" });
  });
});

describe("canvases", () => {
  it("applies every patch op and emits the canvas each time", async () => {
    const { open } = await connected();
    const changes: DesignChange[] = [];
    open.on((c) => changes.push(c));
    const page = await open.createCanvas({ kind: "page", name: "Flows" }, by);
    const other = await open.createCanvas({ kind: "prototype", name: "Ideas" }, by);
    const id = page.id;

    await open.patchCanvas(id, { op: "addFrames", frames: [frame("a"), frame("b", 200)] }, by);
    await open.patchCanvas(id, { op: "moveFrames", frames: [{ id: "a", x: 10, y: 20 }] }, by);
    await open.patchCanvas(
      id,
      { op: "resizeFrames", frames: [{ id: "b", x: 1, y: 2, width: 300, height: 400, hug: true }] },
      by,
    );
    await open.patchCanvas(id, { op: "renameFrame", frameId: "a", name: "Home" }, by);
    const text = { id: "t", x: 0, y: -80, width: 300, title: "Bold", body: "Why", author: by };
    await open.patchCanvas(id, { op: "setText", text }, by);
    let canvas = await open.patchCanvas(
      id,
      { op: "setText", text: { ...text, title: "Bolder" } },
      by,
    );
    expect(canvas.frames).toEqual([
      { ...frame("a"), name: "Home", x: 10, y: 20 },
      { ...frame("b"), x: 1, y: 2, width: 300, height: 400, hug: true },
    ]);
    expect(canvas.texts).toEqual([{ ...text, title: "Bolder" }]);

    canvas = await open.updateCanvas(
      id,
      (c) => ({
        ...c,
        comments: [
          {
            id: "c1",
            anchor: { frameId: "b" },
            author: by,
            text: "hm",
            replies: [],
            createdAt: 1,
          },
        ],
      }),
      by,
    );
    canvas = await open.patchCanvas(
      id,
      { op: "moveFramesTo", frameIds: ["b"], toCanvasId: other.id },
      by,
    );
    expect(canvas.frames.map((f) => f.id)).toEqual(["a"]);
    expect(canvas.comments).toEqual([]);
    const moved = (await open.canvases()).find((c) => c.id === other.id)!;
    expect(moved.frames.map((f) => f.id)).toEqual(["b"]);
    expect(moved.comments.map((c) => c.id)).toEqual(["c1"]);

    await open.patchCanvas(id, { op: "removeText", textId: "t" }, by);
    canvas = await open.patchCanvas(id, { op: "removeFrames", frameIds: ["a"] }, by);
    expect(canvas).toMatchObject({ frames: [], texts: [] });

    await expect(
      open.patchCanvas(id, { op: "moveFrames", frames: [{ id: "gone", x: 0, y: 0 }] }, by),
    ).rejects.toMatchObject({ code: "not-found" });
    await expect(
      open.patchCanvas(other.id, { op: "addFrames", frames: [frame("b")] }, by),
    ).rejects.toMatchObject({ code: "invalid" });

    const canvasChanges = changes.filter((c) => c.type === "canvas");
    expect(canvasChanges).toHaveLength(13);
  });

  it("saves to disk, survives a reopen, and purges canvases removed over 30 days ago", async () => {
    const { dataDir, store, entry, open } = await connected();
    const fresh = await open.createCanvas({ kind: "page", name: "Fresh" }, by);
    const old = await open.createCanvas({ kind: "page", name: "Old" }, by);
    await open.updateCanvas(fresh.id, (c) => ({ ...c, removedAt: Date.now() }), by);
    await open.updateCanvas(
      old.id,
      (c) => ({ ...c, removedAt: Date.now() - REMOVED_KEEP_MS - 1 }),
      by,
    );
    await store.close();

    const reopened = await newStore(dataDir).open(entry.id);
    const names = (await reopened.canvases()).map((c: Canvas) => c.name);
    expect(names).toContain("Fresh");
    expect(names).toContain("Routes");
    expect(names).not.toContain("Old");
    await expect(
      fs.stat(path.join(entry.root, ".finite/canvases", `${old.id}.json`)),
    ).rejects.toThrow();
  });

  it("passes on edits made outside Finite, like a git pull", async () => {
    const { root, open } = await connected();
    const [routes] = (await open.canvases()).filter((c) => c.name === "Routes");
    const seen = new Promise<DesignChange>((resolve) => open.on(resolve));
    const file = path.join(root, ".finite/canvases", `${routes!.id}.json`);
    await fs.writeFile(file, JSON.stringify({ ...routes, name: "Pages" }));
    expect(await seen).toMatchObject({ type: "canvas", canvas: { id: routes!.id, name: "Pages" } });
    expect((await open.canvases()).find((c) => c.id === routes!.id)?.name).toBe("Pages");
  });
});

describe("threads", () => {
  it("creates, updates and logs a thread, keeping streamed deltas out of the log", async () => {
    const { root, open } = await connected();
    const changes: DesignChange[] = [];
    open.on((c) => changes.push(c));
    const meta = await open.createThread({ model: "claude-opus-5-5", fast: false });
    expect(meta).toMatchObject({ title: "New thread", running: false, queued: [], canvasIds: [] });

    const canvas = await open.createCanvas(
      { kind: "prototype", name: "Bolder hero", threadId: meta.id },
      by,
    );
    expect(canvas.threadIds).toEqual([meta.id]);
    expect((await open.threads())[0]!.canvasIds).toEqual([canvas.id]);

    const running = await open.updateThread(meta.id, (m) => ({ ...m, running: true }));
    expect(running.running).toBe(true);

    await open.appendEvent(meta.id, {
      type: "user",
      text: "Make it bolder",
      attachments: [],
      by,
      at: 1,
    });
    await open.appendEvent(meta.id, { type: "text.delta", text: "Sure" });
    await open.appendEvent(meta.id, { type: "text", text: "Sure, done.", at: 2 });
    expect((await open.history(meta.id)).map((e) => e.type)).toEqual(["user", "text"]);
    expect(changes.filter((c) => c.type === "thread.event")).toHaveLength(3);

    const lines = await fs.readFile(path.join(root, ".finite/threads", `${meta.id}.jsonl`), "utf8");
    expect(lines.trim().split("\n")).toHaveLength(2);
    await expect(open.updateThread("nope", (m) => m)).rejects.toMatchObject({ code: "not-found" });
  });

  it("stops threads a crash left running when the design opens again", async () => {
    const { dataDir, store, entry, open } = await connected();
    const meta = await open.createThread({ model: "opus", fast: false });
    await open.updateThread(meta.id, (m) => ({ ...m, running: true }));
    await store.close();
    const [thread] = await (await newStore(dataDir).open(entry.id)).threads();
    expect(thread).toMatchObject({
      id: meta.id,
      running: false,
      awaitingSince: expect.any(Number),
    });
  });

  it("saves attachments under .finite/attachments", async () => {
    const { root, open } = await connected();
    const { path: rel } = await open.saveAttachment("../../hero shot.png", new Uint8Array([1, 2]));
    expect(rel).toMatch(/^\.finite\/attachments\/[0-9a-f]{8}-hero_shot\.png$/);
    expect([...(await fs.readFile(path.join(root, rel)))]).toEqual([1, 2]);
  });
});
