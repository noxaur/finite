import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Canvas, OpenDesign, Route } from "@finite/protocol";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { syncRoutes, syncedRoutesPage, type ConfiguredRoutes } from "./routes.ts";

const PAGE: Canvas = {
  id: "routes",
  kind: "page",
  name: "Routes",
  frames: [],
  labels: [],
  comments: [],
} as unknown as Canvas;

const USERS: Route = { path: "/users/:userId", params: ["userId"] };
const HOME: Route = { path: "/", params: [] };

/** The page after a sync, or the page itself when nothing changed. */
function sync(page: Canvas, routes: Route[], configured?: ConfiguredRoutes): Canvas {
  return syncedRoutesPage(page, routes, configured) ?? page;
}

const shown = (page: Canvas) =>
  page.frames.map((f) => [f.name, f.source.kind === "route" ? f.source.params : {}, !!f.gone]);

describe("syncedRoutesPage", () => {
  it("fills a dynamic segment with the sample value without config", () => {
    expect(shown(sync(PAGE, [HOME, USERS]))).toEqual([
      ["Home", undefined, false],
      ["Users · userId=1", { userId: "1" }, false],
    ]);
  });

  it("uses configured params in place of the sample, one frame per params object", () => {
    const page = sync(PAGE, [HOME, USERS], {
      "/users/:userId": [{ userId: "42" }, { userId: "7" }],
    });
    expect(shown(page)).toEqual([
      ["Home", undefined, false],
      ["Users · userId=42", { userId: "42" }, false],
      ["Users · userId=7", { userId: "7" }, false],
    ]);
    expect(page.frames.map((f) => [f.x, f.y])).toEqual([
      [0, 0],
      [1600, 0],
      [3200, 0],
    ]);
  });

  it("adds a configured path the router doesn't report, and never marks it gone", () => {
    const configured = { "/internal/preview": {}, "/posts/$slug": { slug: "hello-world" } };
    const page = sync(PAGE, [HOME], configured);
    expect(shown(page)).toEqual([
      ["Home", undefined, false],
      ["Internal / preview", undefined, false],
      ["Posts · slug=hello-world", { slug: "hello-world" }, false],
    ]);
    expect(page.frames[2]!.source).toEqual({
      kind: "route",
      path: "/posts/$slug",
      params: { slug: "hello-world" },
    });
    expect(syncedRoutesPage(page, [HOME], configured)).toBeUndefined();
  });

  it("is idempotent and keeps frames where people moved them", () => {
    const configured = { "/users/:userId": { userId: "42" } };
    const first = sync(PAGE, [HOME, USERS], configured);
    expect(syncedRoutesPage(first, [HOME, USERS], configured)).toBeUndefined();
    const moved = {
      ...first,
      frames: first.frames.map((f, i) => (i === 1 ? { ...f, x: -5000, y: 777 } : f)),
    };
    expect(syncedRoutesPage(moved, [HOME, USERS], configured)).toBeUndefined();
    // Params match whatever order their keys are written in.
    const repo: Route = { path: "/:org/:repo", params: ["org", "repo"] };
    const two = sync(PAGE, [repo], { "/:org/:repo": { org: "a", repo: "b" } });
    expect(
      syncedRoutesPage(two, [repo], { "/:org/:repo": { repo: "b", org: "a" } }),
    ).toBeUndefined();
  });

  it("marks frames whose path and params neither source gives any more as gone, and back", () => {
    const sample = sync(PAGE, [USERS]);
    const configured = sync(sample, [USERS], { "/users/:userId": { userId: "42" } });
    expect(shown(configured)).toEqual([
      ["Users · userId=1", { userId: "1" }, true],
      ["Users · userId=42", { userId: "42" }, false],
    ]);
    const removed = sync(configured, [USERS], {});
    expect(shown(removed)).toEqual([
      ["Users · userId=1", { userId: "1" }, false],
      ["Users · userId=42", { userId: "42" }, true],
    ]);
    const custom = sync(PAGE, [], { "/internal/preview": {} });
    expect(shown(sync(custom, [], {}))).toEqual([["Internal / preview", undefined, true]]);
  });
});

describe("syncRoutes", () => {
  const cleanup: string[] = [];
  afterEach(async () => {
    for (const dir of cleanup.splice(0)) await fs.rm(dir, { recursive: true, force: true });
  });

  /** A design of app `web` in a workspace whose finite.json lists `routes`. */
  async function design(routes: unknown) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "finite-routes-"));
    cleanup.push(root);
    await fs.writeFile(path.join(root, "package.json"), "{}");
    const write = (r: unknown) =>
      fs.writeFile(
        path.join(root, "finite.json"),
        JSON.stringify({ apps: { web: { path: ".", routes: r } } }),
      );
    await write(routes);
    let page = PAGE;
    const open = {
      design: { workspace: root, app: "web" },
      canvases: async () => [page],
      updateCanvas: async (_id: string, fn: (c: Canvas) => Canvas) => (page = fn(page)),
    } as unknown as OpenDesign;
    return { open, write, page: () => page };
  }

  it("reads the design's finite.json routes on each sync", async () => {
    const d = await design({ "/users/:userId": { userId: "42" } });
    await syncRoutes(d.open, [USERS]);
    expect(shown(d.page())).toEqual([["Users · userId=42", { userId: "42" }, false]]);
    await d.write({ "/users/:userId": [{ userId: "42" }, { userId: "8" }] });
    await syncRoutes(d.open, [USERS]);
    expect(shown(d.page())).toEqual([
      ["Users · userId=42", { userId: "42" }, false],
      ["Users · userId=8", { userId: "8" }, false],
    ]);
  });

  it("leaves the page alone while finite.json is invalid", async () => {
    const d = await design({ "/users/:userId": { userId: "42" } });
    await syncRoutes(d.open, [USERS]);
    await d.write({ "/users/:userId": { id: "42" } });
    await syncRoutes(d.open, [USERS]);
    expect(shown(d.page())).toEqual([["Users · userId=42", { userId: "42" }, false]]);
  });
});
