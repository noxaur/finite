import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Design,
  DesignConfig,
  DesignEntry,
  type OpenDesign,
  Refused,
  Settings,
  type Store,
} from "@finite/protocol";
import { ensureBrandBoard } from "./brand.ts";
import { detectProject } from "./detect.ts";
import { readJson, serial, toJson, writeAtomic } from "./files.ts";
import { type Install, install } from "./install.ts";
import { type OpenedDesign, openDesign } from "./open.ts";
import { ROUTES_PAGE, routeFrames } from "./routes.ts";
import {
  appFor,
  configRoot,
  findWorkspace,
  readWorkspace,
  type Workspace,
  type WorkspaceApp,
} from "./workspace.ts";

export type StoreOptions = {
  /** `$FINITE_DATA_DIR`: designs.json, settings.json, projects/. */
  dataDir: string;
  /** The blank design template. Defaults to `apps/server/scaffold`. */
  scaffoldDir?: string;
};

export type FileStore = Store & {
  /** Stops watching every open design's `.finite/` folder. */
  close(): Promise<void>;
};

export const DEFAULT_SETTINGS: Settings = {
  /** Claude's alias for its newest Opus, one of the models `claude.status` lists. */
  model: "opus",
  effort: "medium",
  fast: false,
  sendMode: "steer",
  showWorkingSeparately: true,
};

/** What a new connected design starts with: its name and `.finite/design.json` fields. */
type Found = Omit<DesignConfig, "version" | "id"> & { name: string };

/** A setup design's config: nothing to run yet, until its `finite.json` names the apps. */
const SETUP_CONFIG: Found = {
  name: "",
  router: "none",
  styling: "inline",
  css: [],
  brandDir: "assets/brand",
};

/** How long a design's `updatedAt` bumps collect before designs.json is written. */
const TOUCH_MS = 2_000;

const installers = new WeakMap<OpenDesign, () => Install | undefined>();

/**
 * The dependency install a blank or imported design is waiting on, or `undefined` when it's ready.
 * Starts one when `node_modules` is missing and none is running, so a failed install is retried
 * the next time someone opens the design.
 */
export function installOf(open: OpenDesign): Install | undefined {
  return installers.get(open)?.();
}

/**
 * The designs registry (`designs.json`), settings, and each design's `.finite/` folder. Nothing is
 * read until it's asked for.
 */
export function createStore(options: StoreOptions): FileStore {
  const { dataDir } = options;
  const registryFile = path.join(dataDir, "designs.json");
  const settingsFile = path.join(dataDir, "settings.json");
  const run = serial();
  const listeners = new Set<(list: DesignEntry[]) => void>();
  const opened = new Map<string, Promise<OpenedDesign>>();
  const installs = new Map<string, Install>();
  let registry: DesignEntry[] | undefined;
  let touchTimer: NodeJS.Timeout | undefined;

  async function list(): Promise<DesignEntry[]> {
    if (!registry) {
      const raw = await readJson(registryFile);
      registry = Array.isArray(raw)
        ? raw.filter((row): row is DesignEntry => {
            const ok = DesignEntry.safeParse(row).success;
            if (!ok) console.warn(`skipping a bad row in ${registryFile}:`, row);
            return ok;
          })
        : [];
    }
    return registry;
  }

  /** The list as clients see it: stored rows plus which ones are installing. */
  function shown(rows: DesignEntry[]): DesignEntry[] {
    return rows.map((row) =>
      installs.get(row.id)?.state.status === "running" ? { ...row, installing: true } : row,
    );
  }

  function announce() {
    const list = shown(registry ?? []);
    for (const fn of listeners) fn(list);
  }

  async function saveList(next: DesignEntry[]) {
    const rows = next.map(({ installing: _installing, ...row }) => row);
    clearTimeout(touchTimer);
    touchTimer = undefined;
    await writeAtomic(registryFile, toJson(rows));
    registry = rows;
    announce();
  }

  /** Bumps a design's `updatedAt`; designs.json is written a little later, once per burst. */
  function touch(id: string) {
    const rows = registry;
    const row = rows?.find((d) => d.id === id);
    if (!rows || !row) return;
    registry = rows.map((d) => (d === row ? { ...d, updatedAt: Date.now() } : d));
    touchTimer ??= setTimeout(() => {
      touchTimer = undefined;
      void run(async () => saveList(await list())).catch((error: unknown) =>
        console.error(`saving ${registryFile} failed:`, error),
      );
    }, TOUCH_MS);
    touchTimer.unref();
  }

  async function entry(id: string): Promise<DesignEntry> {
    const found = (await list()).find((d) => d.id === id);
    if (!found) throw new Refused(`no design ${id}; it may have been removed`, "not-found");
    return found;
  }

  function startInstall(design: DesignEntry): Install | undefined {
    if (design.origin === "connected") return undefined;
    const running = installs.get(design.id);
    if (running && running.state.status === "running") return running;
    if (fs.existsSync(path.join(design.root, "node_modules"))) return undefined;
    const job = install(design.root, (state) => {
      void opened.get(design.id)?.then((open) => open.emit({ type: "install", install: state }));
    });
    installs.set(design.id, job);
    const finished = () => {
      announce();
    };
    job.done.then(() => {
      installs.delete(design.id);
      finished();
    }, finished);
    announce();
    return job;
  }

  async function open(id: string): Promise<OpenedDesign> {
    let pending = opened.get(id);
    if (!pending) {
      pending = (async () => {
        const row = await entry(id);
        const configFile = path.join(row.root, ".finite", "design.json");
        const config = DesignConfig.safeParse(await readJson(configFile).catch(() => undefined));
        if (!config.success) {
          throw new Refused(
            `${configFile} is missing or invalid. Remove this design and connect ${row.root} again.`,
            "not-found",
          );
        }
        const { version: _version, id: _id, ...rest } = config.data;
        const { updatedAt: _at, installing: _installing, ...base } = row;
        const design: Design = { ...base, ...rest };
        const opened = await openDesign(design);
        // Designs made before the Brand page had its assets board get it now.
        if ((await opened.canvases()).length) {
          await ensureBrandBoard(opened, FINITE).catch((error: unknown) => {
            console.error(`adding the brand board to ${design.root} failed:`, error);
          });
        }
        installers.set(opened, () => startInstall(row));
        opened.on((change) => {
          if (change.type === "canvas" || change.type === "thread") touch(id);
        });
        return opened;
      })();
      pending.catch(() => opened.delete(id));
      opened.set(id, pending);
    }
    return pending;
  }

  /**
   * The Routes, Brand and Components pages a new design starts with. The Routes page follows the
   * routes the dev server reports (see `syncRoutes`); `routes` is what it shows before that.
   */
  async function addPages(design: OpenDesign, routes: string[]) {
    if ((await design.canvases()).length) return;
    const by = FINITE;
    const routesPage = await design.createCanvas({ kind: "page", name: ROUTES_PAGE }, by);
    const frames = routeFrames(
      routes.map((route) => ({ path: route, params: {} })),
      [],
    );
    if (frames.length) {
      await design.updateCanvas(routesPage.id, (c) => ({ ...c, frames }), by);
    }
    await ensureBrandBoard(design, by);
    await design.createCanvas({ kind: "page", name: "Components" }, by);
  }

  /**
   * Connects `root` as a new design with this config (a `.finite/design.json` already there keeps
   * its id and fields) and makes its pages.
   */
  async function connectFolder(
    root: string,
    detected: Found,
    extra: Pick<DesignEntry, "workspace" | "app" | "setup"> = {},
  ): Promise<DesignEntry> {
    const rows = await list();
    const configFile = path.join(root, ".finite", "design.json");
    const existing = DesignConfig.safeParse(await readJson(configFile).catch(() => undefined));
    const id = existing.success ? existing.data.id : randomUUID();
    const clash = rows.find((d) => d.id === id);
    if (clash) {
      throw new Refused(
        `${clash.root} is already connected as this design (it's another copy of the same project). Remove "${clash.name}" first, then connect ${root}.`,
        "invalid",
      );
    }
    const { name, ...rest } = detected;
    if (!existing.success || extra.setup) {
      await writeAtomic(configFile, toJson({ version: 1, id, ...rest } satisfies DesignConfig));
    }
    const row: DesignEntry = {
      id,
      name: name || path.basename(root),
      root,
      origin: "connected",
      updatedAt: Date.now(),
      ...extra,
    };
    await saveList([...rows, row]);
    // Routes come from the dev server once it runs; until then the Routes page is empty.
    await addPages(await open(id), []);
    return row;
  }

  /**
   * One `finite.json` app as a design: connected now, or the design already in its folder, linked
   * to the workspace. A setup design in that folder is detected again and stops being one.
   */
  async function connectApp(workspace: Workspace, app: WorkspaceApp): Promise<DesignEntry> {
    const extra = { workspace: workspace.root, app: app.name };
    const rows = await list();
    const same = rows.find((d) => d.root === app.dir);
    if (!same) return connectFolder(app.dir, await detectProject(app.dir), extra);
    if (same.workspace === workspace.root && same.app === app.name && !same.setup) return same;

    const configFile = path.join(app.dir, ".finite", "design.json");
    let config = DesignConfig.parse(await readJson(configFile));
    let name = same.name;
    if (same.setup) {
      const { name: detectedName, ...detected } = await detectProject(app.dir);
      config = { version: 1, id: same.id, ...detected };
      await writeAtomic(configFile, toJson(config));
      name = detectedName;
    }
    const { setup: _setup, ...base } = same;
    const next: DesignEntry = { ...base, ...extra, name };
    await saveList(rows.map((d) => (d.id === same.id ? next : d)));
    const pending = opened.get(same.id);
    if (pending) {
      const { version: _version, id: _id, ...rest } = config;
      const { updatedAt: _at, installing: _installing, ...fields } = next;
      (await pending).setDesign({ ...fields, ...rest });
    }
    return next;
  }

  const store: FileStore = {
    designs: () => run(async () => shown(await list())),

    create({ name, kind }) {
      return run(async () => {
        const id = randomUUID();
        const root = path.join(dataDir, "projects", id);
        await fsp.cp(scaffoldDir(options.scaffoldDir), root, {
          recursive: true,
          filter: (src) => !/[\\/](node_modules|dist)([\\/]|$)/.test(src),
        });
        await personalize(root, name);
        const config: DesignConfig = {
          version: 1,
          id,
          router: "react-router",
          styling: "tailwind",
          css: ["src/styles.css"],
          brandDir: "src/assets/brand",
        };
        await writeAtomic(path.join(root, ".finite", "design.json"), toJson(config));
        const row: DesignEntry = { id, name, root, origin: kind, updatedAt: Date.now() };
        await saveList([...(await list()), row]);
        await addPages(await open(id), ["/"]);
        startInstall(row);
        return row;
      });
    },

    connect(input) {
      return run(async () => {
        const root = path.resolve(input);
        const same = (await list()).find((d) => d.root === root);
        if (same) return same;

        const found = await findWorkspace(root);
        if (found) {
          const workspace = await readWorkspace(found.root);
          if (root === workspace.root) {
            const rows: DesignEntry[] = [];
            for (const app of Object.values(workspace.apps)) {
              rows.push(await connectApp(workspace, app));
            }
            return rows[0]!;
          }
          const app = appFor(workspace, root);
          if (app) return connectApp(workspace, app);
        }
        try {
          return await connectFolder(root, await detectProject(root));
        } catch (error) {
          // A monorepo root, or an app that needs more than its dev server: an agent sets it up.
          // A folder without a package.json isn't a JavaScript project, so there's nothing to set up.
          const pkg = await fsp.stat(path.join(root, "package.json")).catch(() => undefined);
          if (
            !(error instanceof Refused) ||
            error.code !== "unsupported-project" ||
            !pkg?.isFile()
          ) {
            throw error;
          }
          return connectFolder(root, SETUP_CONFIG, { workspace: root, setup: true });
        }
      });
    },

    finishSetup(id) {
      return run(async () => {
        const row = await entry(id);
        const found = row.workspace ? { root: row.workspace } : await findWorkspace(row.root);
        if (!found) {
          throw new Refused(
            `There's no finite.json at ${await configRoot(row.root)} or above ${row.root}. Write it, then call finish_setup again.`,
            "not-found",
          );
        }
        const workspace = await readWorkspace(found.root);
        const apps = Object.values(workspace.apps);
        const self = apps.find((app) => app.dir === row.root);
        if (!row.setup && !self) {
          const at = path.relative(workspace.root, row.root) || ".";
          throw new Refused(
            `${workspace.file} lists no app in ${row.root}, this design's folder. Add one under apps with "path": "${at}".`,
            "invalid-config",
          );
        }
        const rows: DesignEntry[] = [];
        for (const app of apps) rows.push(await connectApp(workspace, app));
        const next = self ? rows[apps.indexOf(self)]! : rows[0]!;
        void opened.get(id)?.then((open) => open.emit({ type: "setup.done", next: next.id }));
        return { apps: rows, next, replaced: !!row.setup && !self };
      });
    },

    rename(id, name) {
      return run(async () => {
        const row = await entry(id);
        const next = { ...row, name, updatedAt: Date.now() };
        await saveList((await list()).map((d) => (d.id === id ? next : d)));
        return shown([next])[0]!;
      });
    },

    remove(id) {
      return run(async () => {
        const row = await entry(id);
        await saveList((await list()).filter((d) => d.id !== id));
        const was = opened.get(id);
        opened.delete(id);
        (await was?.catch(() => undefined))?.close();
        // A setup design's .finite/ is Finite's own, made when it was connected.
        if (row.setup)
          await fsp.rm(path.join(row.root, ".finite"), { recursive: true, force: true });
        // A blank or imported design's folder goes to the trash, never straight to deletion.
        const projects = path.join(dataDir, "projects") + path.sep;
        if (row.origin !== "connected" && row.root.startsWith(projects)) {
          const trash = path.join(dataDir, "trash", `${id}-${Date.now()}`);
          await fsp.mkdir(path.dirname(trash), { recursive: true });
          await fsp.rename(row.root, trash).catch((error: unknown) => {
            console.error(`moving ${row.root} to the trash failed:`, error);
          });
        }
      });
    },

    open,

    async settings() {
      const raw = await readJson(settingsFile).catch(() => undefined);
      const saved = Settings.partial().safeParse(raw);
      const next = Settings.parse({
        ...DEFAULT_SETTINGS,
        ...(saved.success ? clean(saved.data) : {}),
      });
      return { ...next, model: modelAlias(next.model) };
    },

    setSettings(patch) {
      return run(async () => {
        const next = Settings.parse({ ...(await store.settings()), ...clean(patch) });
        await writeAtomic(settingsFile, toJson(next));
        return next;
      });
    },

    on(fn) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },

    async close() {
      if (touchTimer) {
        clearTimeout(touchTimer);
        touchTimer = undefined;
        await run(async () => saveList(await list()));
      }
      const all = [...opened.values()];
      opened.clear();
      for (const pending of all) (await pending.catch(() => undefined))?.close();
    },
  };
  return store;
}

/** Names the new project after the design: package.json `name` and the page title. */
async function personalize(root: string, name: string) {
  const pkgFile = path.join(root, "package.json");
  const pkg = JSON.parse(await fsp.readFile(pkgFile, "utf8")) as Record<string, unknown>;
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "design";
  await writeAtomic(pkgFile, toJson({ ...pkg, name: slug }));
  const htmlFile = path.join(root, "index.html");
  const html = await fsp.readFile(htmlFile, "utf8");
  const title = name.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  await writeAtomic(htmlFile, html.replace(/<title>.*<\/title>/, `<title>${title}</title>`));
}

/** `scaffold/` next to the server's source or its bundle (`src/store/` or `dist/`). */
const FINITE = { kind: "person", id: "finite", name: "Finite" } as const;

function scaffoldDir(override: string | undefined): string {
  if (override) return override;
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 4; i++) {
    const candidate = path.join(dir, "scaffold");
    if (fs.existsSync(path.join(candidate, "package.json"))) return candidate;
    dir = path.dirname(dir);
  }
  throw new Error(
    `the blank design template (scaffold/) isn't next to ${fileURLToPath(import.meta.url)}`,
  );
}

/**
 * Claude's alias for a pinned model id an older Finite saved as the default (`claude-opus-5-5` →
 * `opus`), so the model is one `claude.status` lists. Anything else stays as it is.
 */
export function modelAlias(model: string): string {
  return /^claude-(opus|sonnet|haiku|fable)-\d+(-\d{1,2})?$/.exec(model)?.[1] ?? model;
}

/** Drops `undefined` fields, so a partial never overwrites a value with nothing. */
function clean<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}
