import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Actor, Canvas, DesignChange, Frame } from "@finite/protocol";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { BRAND_BOARD, brandBoard, ensureBrandBoard } from "./brand.ts";
import { detectProject } from "./detect.ts";
import { createStore, DEFAULT_SETTINGS, type FileStore } from "./index.ts";
import { INTERRUPTED_BY_RESTART, REMOVED_KEEP_MS } from "./open.ts";
import { routeFrameName } from "./routes.ts";
import { prepareFixture } from "../preview/fixtures.ts";

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

describe("routeFrameName", () => {
  it("keeps the dots of Next catch-all segments", () => {
    expect(routeFrameName("/docs/[...slug]")).toBe("Docs / [...slug]");
    expect(routeFrameName("/shop/[[...slug]]")).toBe("Shop / [[...slug]]");
    expect(routeFrameName("/blog/[slug]", { slug: "1" })).toBe("Blog / [slug] · slug=1");
  });

  it("still words out plain segments", () => {
    expect(routeFrameName("/")).toBe("Home");
    expect(routeFrameName("/sign-up")).toBe("Sign up");
    expect(routeFrameName("/users/:userId", { userId: "1" })).toBe("Users · userId=1");
  });
});

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
    // The Brand page shows the assets board, a file Finite keeps up to date.
    const brand = (await open.canvases()).find((c) => c.name === "Brand")!;
    expect(brand.frames).toMatchObject([
      { name: "Brand assets", hug: true, source: { kind: "file", file: BRAND_BOARD } },
    ]);
    const board = await fs.readFile(path.join(root, BRAND_BOARD), "utf8");
    expect(board).toContain(`import.meta.glob("../../../src/assets/brand/**/*"`);
    expect(board).toContain(`import.meta.glob(["../../../src/styles.css"]`);
    expect(board).toBe(brandBoard(open.design));
    // Connecting the same folder again is the same design.
    const same = { ...entry, updatedAt: expect.any(Number) };
    expect(await store.connect(root)).toEqual(same);
    expect(await store.designs()).toEqual([same]);
  });

  it("keeps the brand board up to date, but leaves a board someone took over and a removed frame", async () => {
    const { root, open } = await connected();
    const file = path.join(root, BRAND_BOARD);
    const brand = () => open.canvases().then((all) => all.find((c) => c.name === "Brand")!);
    await fs.writeFile(file, (await fs.readFile(file, "utf8")).replace("Brand", "Old"));
    const { id } = (await brand()).frames[0]!;
    await open.patchCanvas((await brand()).id, { op: "removeFrames", frameIds: [id] }, by);
    await ensureBrandBoard(open, by);
    expect(await fs.readFile(file, "utf8")).toBe(brandBoard(open.design));
    expect((await brand()).frames).toEqual([]);
    await fs.writeFile(file, "export default () => <p>Mine</p>;\n");
    await ensureBrandBoard(open, by);
    expect(await fs.readFile(file, "utf8")).toBe("export default () => <p>Mine</p>;\n");
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

  it("finds CSS modules and global sheets written in Sass or Less", async () => {
    const store = newStore(await tempDir());
    const sass = await project(
      { vite: "^8", "react-router": "^8", sass: "^1" },
      {
        "src/main.tsx":
          'import "./global.scss";\nimport "./theme.less";\nimport "./card.module.scss";',
        "src/A.tsx":
          'import s from "./a.module.scss";\nexport const A = () => <div className={s.a} />;',
        "src/B.tsx":
          'import s from "./b.module.sass";\nexport const B = () => <div className={s.b} />;',
        "src/global.scss": ":root { --ink: #111; }",
        "src/theme.less": ":root { --paper: #fff; }",
      },
    );
    expect((await store.open((await store.connect(sass)).id)).design).toMatchObject({
      styling: "css-modules",
      css: ["src/global.scss", "src/theme.less"],
    });
    const sassOnly = await project(
      { vite: "^8", "react-router": "^8" },
      {
        "src/A.tsx":
          'import s from "./a.module.sass";\nexport const A = () => <div className={s.a} />;',
      },
    );
    expect((await store.open((await store.connect(sassOnly)).id)).design.styling).toBe(
      "css-modules",
    );
  });

  it("finds Tailwind v3 stylesheets by their @tailwind directives", async () => {
    const fixtures = fileURLToPath(new URL("../../fixtures/", import.meta.url));
    expect(await detectProject(path.join(fixtures, "next-tailwind3"))).toEqual({
      name: "fixture-next-tailwind3",
      router: "next-app",
      styling: "tailwind",
      css: ["app/globals.css"],
      brandDir: "assets/brand",
    });
    const vite = await project(
      { vite: "^8", "react-router": "^8", tailwindcss: "^3" },
      {
        "src/main.tsx": 'import "./reset.css";\nimport "./index.css";',
        "src/reset.css": "body { margin: 0; }",
        "src/index.css": "@tailwind base;\n@tailwind components;\n@tailwind utilities;\n",
      },
    );
    expect(await detectProject(vite)).toMatchObject({
      styling: "tailwind",
      css: ["src/index.css"],
    });
  });

  it("detects Next.js's App Router and Pages Router, without Vite", async () => {
    const fixtures = fileURLToPath(new URL("../../fixtures/", import.meta.url));
    expect(await detectProject(path.join(fixtures, "next-app"))).toEqual({
      name: "fixture-next-app",
      router: "next-app",
      styling: "tailwind",
      css: ["app/globals.css"],
      brandDir: "assets/brand",
    });
    expect(await detectProject(path.join(fixtures, "next-pages"))).toEqual({
      name: "fixture-next-pages",
      router: "next-pages",
      styling: "css-modules",
      css: ["src/styles/globals.css"],
      brandDir: "src/assets/brand",
    });
    // Root folders win over src/, as in Next; a project with both routers is an App Router one.
    const both = await project(
      { next: "^16" },
      {
        "pages/_app.tsx": 'import "../styles/site.css";',
        "src/app/layout.tsx": 'import "./ignored.css";',
      },
    );
    expect(await detectProject(both)).toMatchObject({
      router: "next-pages",
      styling: "inline",
      css: ["styles/site.css"],
    });
    await fs.mkdir(path.join(both, "app"));
    expect(await detectProject(both)).toMatchObject({ router: "next-app" });
    await expect(detectProject(await project({ next: "^16" }))).rejects.toMatchObject({
      code: "unsupported-project",
      message: expect.stringContaining("no app/ or pages/ folder"),
    });
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

  it("lists pages in the order they were made on connect, reconnect and reopen", async () => {
    const { dataDir, store, root, entry, open } = await connected();
    const names = (canvases: Canvas[]) => canvases.map((c) => c.name);
    const added = ["One", "Two", "Three", "Four", "Five"];
    for (const name of added) await open.createCanvas({ kind: "page", name }, by);
    const pages = ["Routes", "Brand", "Components", ...added];
    expect(names(await open.canvases())).toEqual(pages);
    await store.remove(entry.id);
    const again = await store.connect(root);
    expect(names(await (await store.open(again.id)).canvases())).toEqual(pages);
    await store.close();
    const reopened = newStore(dataDir);
    expect(names(await (await reopened.open(again.id)).canvases())).toEqual(pages);
  });
});

describe("workspaces", () => {
  async function monorepo() {
    const fixture = await prepareFixture("monorepo", { install: false });
    cleanup.push(async () => fixture.remove());
    return fixture.root;
  }
  const web = (root: string) => path.join(root, "apps/web");

  it("connects every app finite.json lists from the workspace root, or one from inside it", async () => {
    const store = newStore(await tempDir());
    const root = await monorepo();
    const entry = await store.connect(root);
    expect(entry).toMatchObject({
      name: "@fixture/web",
      root: web(root),
      origin: "connected",
      workspace: root,
      app: "web",
    });
    expect((await store.open(entry.id)).design).toMatchObject({
      router: "react-router",
      styling: "tailwind",
      workspace: root,
    });
    const same = { ...entry, updatedAt: expect.any(Number) };
    expect(await store.connect(path.join(web(root), "src"))).toEqual(same);
    expect(await store.connect(root)).toEqual(same);
    expect(await store.designs()).toHaveLength(1);
  });

  it("refuses an invalid finite.json with every problem in it", async () => {
    const store = newStore(await tempDir());
    const root = await monorepo();
    await fs.writeFile(
      path.join(root, "finite.json"),
      JSON.stringify({ apps: { web: { path: "apps/web", needs: ["db"] } } }),
    );
    await expect(store.connect(root)).rejects.toMatchObject({
      code: "invalid-config",
      message: expect.stringContaining('apps.web.needs: there\'s no service "db"'),
    });
    await expect(store.connect(web(root))).rejects.toMatchObject({ code: "invalid-config" });
    expect(await store.designs()).toEqual([]);
  });

  it("connects a folder detection refuses as a setup design, which its apps replace", async () => {
    const store = newStore(await tempDir());
    const root = await monorepo();
    const config = await fs.readFile(path.join(root, "finite.json"), "utf8");
    await fs.rm(path.join(root, "finite.json"));

    const setup = await store.connect(root);
    expect(setup).toMatchObject({ root, workspace: root, setup: true, origin: "connected" });
    const open = await store.open(setup.id);
    expect(open.design).toMatchObject({ router: "none", styling: "inline", css: [], setup: true });
    expect((await open.canvases()).map((c) => c.name).sort()).toEqual([
      "Brand",
      "Components",
      "Routes",
    ]);

    await expect(store.finishSetup(setup.id)).rejects.toMatchObject({
      code: "not-found",
      message: expect.stringContaining("finite.json doesn't exist"),
    });
    await fs.writeFile(path.join(root, "finite.json"), '{ "apps": {} }');
    await expect(store.finishSetup(setup.id)).rejects.toMatchObject({
      code: "invalid-config",
      message: expect.stringContaining("list at least one app"),
    });

    await fs.writeFile(path.join(root, "finite.json"), config);
    const changes: DesignChange[] = [];
    open.on((change) => changes.push(change));
    const done = await store.finishSetup(setup.id);
    expect(done).toMatchObject({ replaced: true, next: { root: web(root), app: "web" } });
    expect(done.apps.map((a) => a.root)).toEqual([web(root)]);
    await expect.poll(() => changes).toContainEqual({ type: "setup.done", next: done.next.id });

    // Removing the setup design deletes the .finite/ Finite made for it, and nothing else.
    await store.remove(setup.id);
    await expect(fs.stat(path.join(root, ".finite"))).rejects.toThrow();
    await expect(fs.stat(path.join(root, "finite.json"))).resolves.toBeTruthy();
    expect((await store.designs()).map((d) => d.root)).toEqual([web(root)]);
  });

  it("keeps a .finite/ that was there before the setup design, when it's replaced and removed", async () => {
    const store = newStore(await tempDir());
    const root = await monorepo();
    const config = await fs.readFile(path.join(root, "finite.json"), "utf8");
    await fs.rm(path.join(root, "finite.json"));
    const board = path.join(root, ".finite/boards/x.tsx");
    await fs.mkdir(path.dirname(board), { recursive: true });
    await fs.writeFile(board, "export default () => null;\n");

    const setup = await store.connect(root);
    expect(setup).toMatchObject({ setup: true });
    expect(setup.madeFinite).toBeUndefined();
    await fs.writeFile(path.join(root, "finite.json"), config);
    expect(await store.finishSetup(setup.id)).toMatchObject({ replaced: true });
    await store.remove(setup.id);
    expect(await fs.readFile(board, "utf8")).toBe("export default () => null;\n");
  });

  it("links an app to a finite.json written after it was connected, and unlinks it", async () => {
    const { dataDir, store, root, entry, open } = await connected();
    expect(entry.workspace).toBeUndefined();
    const file = path.join(root, "finite.json");
    await fs.writeFile(file, JSON.stringify({ apps: { shop: { path: "." } } }));
    // Connecting it again, while it's open.
    expect(await store.connect(root)).toMatchObject({ workspace: root, app: "shop" });
    expect(open.design).toMatchObject({ workspace: root, app: "shop" });

    // Opening it, in a later server run: an invalid finite.json keeps the link.
    await store.close();
    await fs.writeFile(file, "{");
    const later = newStore(dataDir);
    expect((await later.open(entry.id)).design).toMatchObject({ workspace: root, app: "shop" });
    await later.close();

    // A finite.json that no longer lists it unlinks it.
    await fs.writeFile(file, JSON.stringify({ apps: { other: { path: "src" } } }));
    await fs.writeFile(path.join(root, "src/package.json"), "{}");
    const last = newStore(dataDir);
    const design = (await last.open(entry.id)).design;
    expect(design.workspace).toBeUndefined();
    expect(design.app).toBeUndefined();
    expect((await last.designs())[0]).not.toHaveProperty("workspace");
  });

  it("relinks an open design when its finite.json renames its app", async () => {
    const { store, root, entry, open } = await connected();
    const file = path.join(root, "finite.json");
    await fs.writeFile(file, JSON.stringify({ apps: { shop: { path: "." } } }));
    await store.connect(root);
    await fs.writeFile(file, JSON.stringify({ apps: { store: { path: "." } } }));
    expect(await store.relink(entry.id)).toMatchObject({ workspace: root, app: "store" });
    expect(open.design).toMatchObject({ workspace: root, app: "store" });
    await fs.writeFile(file, "{");
    expect(await store.relink(entry.id)).toMatchObject({ app: "store" });
  });

  it("turns a setup design into the app at its own path", async () => {
    const store = newStore(await tempDir());
    const root = await project({ react: "^19" });
    const setup = await store.connect(root);
    expect(setup.setup).toBe(true);
    const open = await store.open(setup.id);

    // The agent made it runnable and wrote finite.json with the folder as its one app.
    await fs.writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ name: "shop", devDependencies: rrTailwind }),
    );
    await fs.writeFile(
      path.join(root, "finite.json"),
      JSON.stringify({ apps: { shop: { path: "." } } }),
    );
    const done = await store.finishSetup(setup.id);
    expect(done).toMatchObject({ replaced: false, next: { id: setup.id, app: "shop" } });
    expect(done.next.setup).toBeUndefined();
    expect(open.design).toMatchObject({ router: "react-router", workspace: root, app: "shop" });
    expect(open.design.setup).toBeUndefined();
    const config = JSON.parse(await fs.readFile(path.join(root, ".finite/design.json"), "utf8"));
    expect(config).toMatchObject({ id: setup.id, router: "react-router" });
  });

  it("sets up a connected design again from finite.json, which must list its folder", async () => {
    const { store, root, entry, open } = await connected();
    await fs.writeFile(
      path.join(root, "finite.json"),
      JSON.stringify({ apps: { x: { path: "src" } } }),
    );
    await fs.writeFile(path.join(root, "src/package.json"), "{}");
    await expect(store.finishSetup(entry.id)).rejects.toMatchObject({
      code: "invalid-config",
      message: expect.stringContaining("lists no app in"),
    });
    await fs.writeFile(
      path.join(root, "finite.json"),
      JSON.stringify({
        apps: { shop: { path: ".", needs: ["api"] } },
        services: { api: { run: "x" } },
      }),
    );
    const done = await store.finishSetup(entry.id);
    expect(done).toMatchObject({
      replaced: false,
      next: { id: entry.id, workspace: root, app: "shop" },
    });
    expect(open.design).toMatchObject({ router: "react-router", workspace: root, app: "shop" });
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

  it("adds, moves, resizes and removes sections and slices, and undo and redo take each back", async () => {
    const { open } = await connected();
    const other = { kind: "person", id: "u2", name: "Ana" } as const;
    const page = await open.createCanvas({ kind: "page", name: "Flows" }, by);
    const id = page.id;
    const at = (box: Partial<{ x: number; y: number }> = {}) => ({
      id: "s",
      name: "Onboarding",
      x: 0,
      y: 0,
      width: 600,
      height: 400,
      author: by,
      ...box,
    });
    const text = { id: "t", x: 10, y: 20, width: 100, title: "T", body: "B", author: by };
    await open.patchCanvas(id, { op: "addFrames", frames: [frame("a", 50), frame("b", 700)] }, by);
    await open.patchCanvas(id, { op: "setText", text }, by);

    let canvas = await open.patchCanvas(id, { op: "setSection", section: at() }, by);
    expect(canvas.sections).toEqual([at()]);
    canvas = await open.patchCanvas(id, { op: "setSection", section: at({ x: 5 }) }, by);
    expect(canvas.sections).toEqual([at({ x: 5 })]);

    // Moving a section moves what's inside it as one step.
    canvas = await open.patchCanvas(
      id,
      {
        op: "moveSection",
        sectionId: "s",
        x: 105,
        y: 200,
        frames: [{ id: "a", x: 150, y: 200 }],
        texts: [{ id: "t", x: 110, y: 220 }],
      },
      by,
    );
    expect(canvas.sections[0]).toMatchObject({ x: 105, y: 200 });
    expect(canvas.frames.find((f) => f.id === "a")).toMatchObject({ x: 150, y: 200 });
    expect(canvas.frames.find((f) => f.id === "b")).toMatchObject({ x: 700, y: 0 });
    expect(canvas.texts[0]).toMatchObject({ x: 110, y: 220 });
    canvas = await open.undoCanvas(id, by);
    expect(canvas.sections[0]).toMatchObject({ x: 5, y: 0 });
    expect(canvas.frames.find((f) => f.id === "a")).toMatchObject({ x: 50, y: 0 });
    expect(canvas.texts[0]).toMatchObject({ x: 10, y: 20 });
    canvas = await open.undoCanvas(id, by, true);
    expect(canvas.sections[0]).toMatchObject({ x: 105, y: 200 });
    canvas = await open.undoCanvas(id, by);

    // A slice sits in one frame, in the frame's own pixels.
    const slice = { id: "sl", frameId: "a", name: "Hero", x: 10, y: 10, width: 50, height: 40 };
    canvas = await open.patchCanvas(id, { op: "setSlice", slice }, by);
    expect(canvas.slices).toEqual([slice]);
    await expect(
      open.patchCanvas(id, { op: "setSlice", slice: { ...slice, id: "x", frameId: "gone" } }, by),
    ).rejects.toMatchObject({ code: "not-found" });
    await expect(
      open.patchCanvas(id, { op: "setSlice", slice: { ...slice, name: " " } }, by),
    ).rejects.toMatchObject({ code: "invalid" });

    // Slices travel with their frame to another canvas.
    const ideas = await open.createCanvas({ kind: "prototype", name: "Ideas" }, by);
    await open.patchCanvas(id, { op: "moveFramesTo", frameIds: ["a"], toCanvasId: ideas.id }, by);
    expect((await open.canvases()).find((c) => c.id === id)!.slices).toEqual([]);
    expect((await open.canvases()).find((c) => c.id === ideas.id)!.slices).toEqual([slice]);
    await open.undoCanvas(id, by);
    expect((await open.canvases()).find((c) => c.id === id)!.slices).toEqual([slice]);

    // A prototype can take its own copy of a route: the frame points at it, and undo points it back.
    canvas = await open.patchCanvas(
      id,
      {
        op: "setFrameSources",
        frames: [{ id: "b", source: { kind: "file", file: ".finite/boards/c/Home.tsx" } }],
      },
      by,
    );
    expect(canvas.frames.find((f) => f.id === "b")?.source).toEqual({
      kind: "file",
      file: ".finite/boards/c/Home.tsx",
    });
    canvas = await open.undoCanvas(id, by);
    expect(canvas.frames.find((f) => f.id === "b")?.source).toEqual(frame("b").source);

    // Removing is a patch too, so undo brings the section back, whoever made it.
    canvas = await open.patchCanvas(id, { op: "removeSlice", sliceId: "sl" }, by);
    expect(canvas.slices).toEqual([]);
    canvas = await open.undoCanvas(id, by);
    expect(canvas.slices).toEqual([slice]);
    canvas = await open.patchCanvas(id, { op: "removeSection", sectionId: "s" }, other);
    expect(canvas.sections).toEqual([]);
    canvas = await open.undoCanvas(id, other);
    expect(canvas.sections.map((x) => x.id)).toEqual(["s"]);
    await expect(
      open.patchCanvas(id, { op: "removeSection", sectionId: "nope" }, by),
    ).rejects.toMatchObject({ code: "not-found" });
    await expect(
      open.patchCanvas(
        id,
        {
          op: "moveSection",
          sectionId: "s",
          x: 0,
          y: 0,
          frames: [{ id: "gone", x: 0, y: 0 }],
          texts: [],
        },
        by,
      ),
    ).rejects.toMatchObject({ code: "not-found" });
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
    // On macOS fs.watch starts its FSEvents stream asynchronously and drops writes made before it
    // is live, which a busy machine stretches past the first write. Write until the watcher sees one.
    let pulling = fs.writeFile(file, JSON.stringify({ ...routes, name: "Pages" }));
    await pulling;
    const again = setInterval(() => {
      pulling = fs.writeFile(file, JSON.stringify({ ...routes, name: "Pages" }));
    }, 250);
    cleanup.push(async () => {
      clearInterval(again);
      await pulling;
    });
    expect(await seen).toMatchObject({ type: "canvas", canvas: { id: routes!.id, name: "Pages" } });
    expect((await open.canvases()).find((c) => c.id === routes!.id)?.name).toBe("Pages");
  });

  it("lists a page a git pull adds by when it was made, not when it arrived", async () => {
    const { root, open } = await connected();
    const [routes] = await open.canvases();
    const seen = new Promise<DesignChange>((resolve) => open.on(resolve));
    const pulled: Canvas = { ...routes!, id: "pulled", name: "Pulled", createdAt: 0, frames: [] };
    await fs.writeFile(path.join(root, ".finite/canvases/pulled.json"), JSON.stringify(pulled));
    await seen;
    expect((await open.canvases()).map((c) => c.name)).toEqual([
      "Pulled",
      "Routes",
      "Brand",
      "Components",
    ]);
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
    const reopened = await newStore(dataDir).open(entry.id);
    const [thread] = await reopened.threads();
    expect(thread).toMatchObject({
      id: meta.id,
      running: false,
      awaitingSince: expect.any(Number),
    });
    expect(await reopened.history(meta.id)).toEqual([
      { type: "error", message: INTERRUPTED_BY_RESTART, at: expect.any(Number) },
    ]);
  });

  it("saves attachments under .finite/attachments", async () => {
    const { root, open } = await connected();
    const { path: rel } = await open.saveAttachment("../../hero shot.png", new Uint8Array([1, 2]));
    expect(rel).toMatch(/^\.finite\/attachments\/[0-9a-f]{8}-hero_shot\.png$/);
    expect([...(await fs.readFile(path.join(root, rel)))]).toEqual([1, 2]);
  });
});
