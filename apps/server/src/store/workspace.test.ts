import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Refused } from "@finite/protocol";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { appFor, envFor, findWorkspace, readWorkspace, servicesFor } from "./workspace.ts";

const cleanup: string[] = [];
afterEach(async () => {
  for (const dir of cleanup.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

/** A temp folder with `files`; objects are written as JSON. */
async function folder(files: Record<string, unknown>) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "finite-workspace-")));
  cleanup.push(root);
  for (const [file, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(
      path.join(root, file),
      typeof content === "string" ? content : JSON.stringify(content, null, 2),
    );
  }
  return root;
}

const PKG = { name: "x" };

/** The reason `readWorkspace` refuses with, after checking the code. */
async function problems(root: string): Promise<string> {
  const error: unknown = await readWorkspace(root).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(Refused);
  expect((error as Refused).code).toBe("invalid-config");
  return (error as Refused).message;
}

describe("readWorkspace", () => {
  it("parses a valid file and resolves app and service folders", async () => {
    const config = {
      $schema: "https://example.com/finite.json",
      setup: ["pnpm install"],
      env: { API_URL: "http://localhost:4000" },
      apps: { web: { path: "apps/web", needs: ["api"] }, docs: { path: "apps/docs" } },
      services: {
        db: { run: "docker compose up db", ready: 5432 },
        api: {
          run: "pnpm -F api dev",
          cwd: "services/api",
          ready: "http://localhost:4000/health",
          needs: ["db"],
        },
      },
    };
    const root = await folder({
      "finite.json": config,
      "apps/web/package.json": PKG,
      "apps/docs/package.json": PKG,
      "services/api/package.json": PKG,
    });
    const workspace = await readWorkspace(root);
    expect(workspace.root).toBe(root);
    expect(workspace.file).toBe(path.join(root, "finite.json"));
    expect(workspace.hash).toMatch(/^[0-9a-f]{40}$/);
    expect(workspace.setup).toEqual(["pnpm install"]);
    expect(workspace.apps.web).toMatchObject({
      name: "web",
      path: "apps/web",
      dir: path.join(root, "apps/web"),
    });
    expect(workspace.services.db).toMatchObject({ name: "db", ready: 5432, dir: root });
    expect(workspace.services.api?.dir).toBe(path.join(root, "services/api"));
  });

  it("accepts an app at the workspace root and no services", async () => {
    const root = await folder({
      "finite.json": { apps: { site: { path: "." } } },
      "package.json": PKG,
    });
    const workspace = await readWorkspace(root);
    expect(workspace.apps.site?.dir).toBe(root);
    expect(workspace.services).toEqual({});
  });

  it("changes its hash when the text changes", async () => {
    const root = await folder({
      "finite.json": { apps: { site: { path: "." } } },
      "package.json": PKG,
    });
    const before = (await readWorkspace(root)).hash;
    await fs.writeFile(
      path.join(root, "finite.json"),
      JSON.stringify({ apps: { site: { path: "./" } } }),
    );
    expect((await readWorkspace(root)).hash).not.toBe(before);
  });

  it("refuses a missing file with not-found", async () => {
    const root = await folder({});
    await expect(readWorkspace(root)).rejects.toMatchObject({ code: "not-found" });
  });

  it("reports a JSON syntax error with its line and column", async () => {
    const root = await folder({ "finite.json": '{\n  "apps": {},\n}\n' });
    expect(await problems(root)).toMatch(/isn't valid JSON: .*line 3 column 1/);
  });

  it("reports schema problems with their key paths", async () => {
    const root = await folder({
      "finite.json": {
        apps: { Web: { path: "a" }, w: { path: 1, need: [] }, e: { path: "" } },
        services: { s: { run: "x", ready: true }, p: { run: "y", ready: 70000 } },
        extra: 1,
      },
    });
    const reason = await problems(root);
    expect(reason).toContain(`apps: "Web" isn't a valid name.`);
    expect(reason).toContain("apps.w.path: expected a string, got 1.");
    expect(reason).toContain(
      `apps.w: unknown key "need". Remove it, or use one of path, setup, needs, env, routes.`,
    );
    expect(reason).toContain("apps.e.path is empty.");
    expect(reason).toContain(
      `services.s.ready: expected a URL like "http://localhost:4000/health" or a port number`,
    );
    expect(reason).toContain("services.p.ready: 70000 isn't a port.");
    expect(reason).toContain(`finite.json: unknown key "extra".`);
  });

  it("reports missing keys and an empty apps", async () => {
    expect(await problems(await folder({ "finite.json": {} }))).toContain(
      "apps is missing. Add it (an object).",
    );
    expect(await problems(await folder({ "finite.json": { apps: {} } }))).toContain(
      "apps: list at least one app.",
    );
    expect(await problems(await folder({ "finite.json": { apps: { w: {} } } }))).toContain(
      "apps.w.path is missing. Add it (a string).",
    );
    expect(await problems(await folder({ "finite.json": [] }))).toContain(
      "finite.json must be an object",
    );
  });

  it("reports needs that name no service", async () => {
    const root = await folder({
      "finite.json": {
        apps: { web: { path: ".", needs: ["api"] } },
        services: { db: { run: "x", needs: ["cache"] } },
      },
      "package.json": PKG,
    });
    const reason = await problems(root);
    expect(reason).toContain(
      `apps.web.needs: there's no service "api". Add it under services, or remove it from needs.`,
    );
    expect(reason).toContain(`services.db.needs: there's no service "cache".`);
  });

  it("reports needs cycles once each", async () => {
    const root = await folder({
      "finite.json": {
        apps: { web: { path: ".", needs: ["a"] } },
        services: {
          a: { run: "x", needs: ["b"] },
          b: { run: "y", needs: ["a"] },
          c: { run: "z", needs: ["c"] },
        },
      },
      "package.json": PKG,
    });
    const reason = await problems(root);
    expect(reason).toContain("services.a.needs: a needs b needs a, a cycle.");
    expect(reason).toContain("services.c.needs: c needs c, a cycle.");
    expect(reason.match(/a cycle/g)).toHaveLength(2);
  });

  it("reports missing, repeated, outside and package-less app paths, and every problem at once", async () => {
    const root = await folder({
      "finite.json": {
        apps: {
          gone: { path: "apps/gone" },
          bare: { path: "apps/bare" },
          one: { path: "apps/one" },
          two: { path: "apps/one/" },
          away: { path: "../elsewhere" },
        },
        services: { api: { run: "x", cwd: "services/nope" } },
      },
      "apps/bare/README.md": "",
      "apps/one/package.json": PKG,
    });
    const reason = await problems(root);
    expect(reason).toContain(`apps.gone.path: ${path.join(root, "apps/gone")} doesn't exist.`);
    expect(reason).toContain(
      `apps.bare.path: ${path.join(root, "apps/bare")} has no package.json.`,
    );
    expect(reason).toContain(`apps.two.path: "apps/one/" is also apps.one's folder.`);
    expect(reason).toContain(`apps.away.path: "../elsewhere" is outside ${root}.`);
    expect(reason).toContain(
      `services.api.cwd: ${path.join(root, "services/nope")} doesn't exist.`,
    );
    expect(reason).toContain("these 5 problems");
  });

  it("accepts routes with one params object, an array of them, or {}", async () => {
    const routes = {
      "/users/:userId": { userId: "42" },
      "/posts/$slug": [{ slug: "hello-world" }, { slug: "draft" }],
      "/docs/[[...rest]]": {},
      "/internal/preview": {},
    };
    const root = await folder({
      "finite.json": { apps: { web: { path: ".", routes } } },
      "package.json": PKG,
    });
    expect((await readWorkspace(root)).apps.web!.routes).toEqual(routes);
  });

  it("reports route params that don't fit their path, naming the key path", async () => {
    const root = await folder({
      "finite.json": {
        apps: {
          web: {
            path: ".",
            routes: {
              "/users/:userId": { id: "42" },
              "/posts/$slug": [{ slug: "a" }, { slug: 7 }],
              "/about": { id: "1" },
              "/blog/[slug]": [{ slug: "a" }, {}],
              about: {},
            },
          },
        },
      },
      "package.json": PKG,
    });
    const reason = await problems(root);
    expect(reason).toContain(
      `apps.web.routes./posts/$slug: expected a params object like {"id": "42"} or an array of them, with string values`,
    );
    // Schema problems come first; fix them and the param names are checked.
    const fixed = await folder({
      "finite.json": {
        apps: {
          web: {
            path: ".",
            routes: {
              "/users/:userId": { id: "42" },
              "/about": { id: "1" },
              "/blog/[slug]": [{ slug: "a" }, {}],
              about: {},
            },
          },
        },
      },
      "package.json": PKG,
    });
    const names = await problems(fixed);
    expect(names).toContain(
      `apps.web.routes./users/:userId: no param "id" in this path; its params are userId.`,
    );
    expect(names).toContain(
      `apps.web.routes./users/:userId: "userId" has no value. Give it one, like "userId": "42".`,
    );
    expect(names).toContain(
      `apps.web.routes./about: no param "id" in this path; it has no params, so use {}.`,
    );
    expect(names).toContain(`apps.web.routes./blog/[slug].1: "slug" has no value.`);
    expect(names).toContain(`apps.web.routes.about: a route path starts with "/", like "/about".`);
    expect(names).toContain("these 5 problems");
  });
});

describe("findWorkspace", () => {
  it("walks up from a nested folder to the nearest finite.json", async () => {
    const root = await folder({ "finite.json": "{}", "apps/web/src/index.ts": "" });
    expect(await findWorkspace(path.join(root, "apps/web/src"))).toEqual({
      root,
      file: path.join(root, "finite.json"),
    });
    expect(await findWorkspace(root)).toEqual({ root, file: path.join(root, "finite.json") });
  });

  it("finds the nearest one when two nest", async () => {
    const root = await folder({ "finite.json": "{}", "apps/web/finite.json": "{}" });
    expect((await findWorkspace(path.join(root, "apps/web")))?.root).toBe(
      path.join(root, "apps/web"),
    );
  });

  it("stops at the folder that holds .git", async () => {
    const root = await folder({
      "finite.json": "{}",
      "repo/.git/HEAD": "",
      "repo/app/package.json": PKG,
    });
    expect(await findWorkspace(path.join(root, "repo/app"))).toBeUndefined();
    await fs.writeFile(path.join(root, "repo/finite.json"), "{}");
    expect((await findWorkspace(path.join(root, "repo/app")))?.root).toBe(path.join(root, "repo"));
  });

  it("ignores a folder named finite.json", async () => {
    const root = await folder({ "repo/.git": "gitdir: elsewhere", "repo/finite.json/x": "" });
    expect(await findWorkspace(path.join(root, "repo"))).toBeUndefined();
  });
});

describe("workspace lookups", () => {
  async function workspace() {
    const root = await folder({
      "finite.json": {
        env: { SHARED: "top", API_URL: "top" },
        apps: {
          root: { path: "." },
          web: { path: "apps/web", needs: ["api", "cache"], env: { API_URL: "web" } },
          docs: { path: "apps/docs" },
        },
        services: {
          db: { run: "db" },
          cache: { run: "cache", needs: ["db"] },
          queue: { run: "queue", needs: ["db"] },
          api: { run: "api", needs: ["queue", "db"], env: { PORT: "4000", SHARED: "api" } },
        },
      },
      "package.json": PKG,
      "apps/web/package.json": PKG,
      "apps/docs/package.json": PKG,
    });
    return readWorkspace(root);
  }

  it("finds the deepest app whose folder holds a path", async () => {
    const ws = await workspace();
    expect(appFor(ws, path.join(ws.root, "apps/web"))?.name).toBe("web");
    expect(appFor(ws, path.join(ws.root, "apps/web/src/pages"))?.name).toBe("web");
    expect(appFor(ws, path.join(ws.root, "apps/webby"))?.name).toBe("root");
    expect(appFor(ws, ws.root)?.name).toBe("root");
    expect(appFor(ws, path.dirname(ws.root))).toBeUndefined();
  });

  it("lists an app's services transitively, each after what it needs", async () => {
    const ws = await workspace();
    expect(servicesFor(ws, "web")).toEqual(["db", "queue", "api", "cache"]);
    expect(servicesFor(ws, "docs")).toEqual([]);
    expect(() => servicesFor(ws, "nope")).toThrow(/has no app "nope"/);
  });

  it("puts an app's or service's env over the top-level env", async () => {
    const ws = await workspace();
    expect(envFor(ws, { app: "web" })).toEqual({ SHARED: "top", API_URL: "web" });
    expect(envFor(ws, { app: "docs" })).toEqual({ SHARED: "top", API_URL: "top" });
    expect(envFor(ws, { service: "api" })).toEqual({ SHARED: "api", API_URL: "top", PORT: "4000" });
    expect(() => envFor(ws, { service: "nope" })).toThrow(/has no service "nope"/);
  });
});
