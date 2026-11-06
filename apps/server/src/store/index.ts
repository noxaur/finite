import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Design,
  DesignConfig,
  type DesignChange,
  DesignEntry,
  type Frame,
  type OpenDesign,
  Refused,
  Settings,
  type Store,
} from "@finite/protocol";
import { detectProject } from "./detect.ts";
import { readJson, serial, toJson, writeAtomic } from "./files.ts";
import { type Install, install } from "./install.ts";
import { type OpenedDesign, openDesign } from "./open.ts";

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
  model: "claude-opus-5-5",
  effort: "medium",
  fast: false,
  sendMode: "steer",
  showWorkingSeparately: true,
};

/** The frame size a route opens at on the Routes page. */
const ROUTE_FRAME = { width: 1440, height: 900 };

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

  async function saveList(next: DesignEntry[]) {
    await writeAtomic(registryFile, toJson(next));
    registry = next;
    for (const fn of listeners) fn(next);
  }

  async function entry(id: string): Promise<DesignEntry> {
    const found = (await list()).find((d) => d.id === id);
    if (!found) throw new Refused(`no design ${id}; it may have been removed`, "not-found");
    return found;
  }

  function startInstall(design: DesignEntry): Install | undefined {
    if (design.origin === "connected") return undefined;
    const running = installs.get(design.id);
    if (running && running.state.status === "starting") return running;
    if (fs.existsSync(path.join(design.root, "node_modules"))) return undefined;
    const job = install(design.root, (state) => {
      // Shown as the design's preview state (a `preview` server event) until the dev server starts.
      const change = { type: "preview", ...state } as unknown as DesignChange;
      void opened.get(design.id)?.then((open) => open.emit(change));
    });
    installs.set(design.id, job);
    job.done.then(
      () => installs.delete(design.id),
      () => {},
    );
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
        const design: Design = { ...row, ...rest };
        const opened = await openDesign(design);
        installers.set(opened, () => startInstall(row));
        return opened;
      })();
      pending.catch(() => opened.delete(id));
      opened.set(id, pending);
    }
    return pending;
  }

  /** The Routes, Brand and Components pages a new design starts with. */
  async function addPages(design: OpenDesign, routes: string[]) {
    if ((await design.canvases()).length) return;
    const by = { kind: "person", id: "finite", name: "Finite" } as const;
    const routesPage = await design.createCanvas({ kind: "page", name: "Routes" }, by);
    const gap = 160;
    const frames: Frame[] = routes.map((route, i) => ({
      id: randomUUID(),
      name: routeName(route),
      x: i * (ROUTE_FRAME.width + gap),
      y: 0,
      ...ROUTE_FRAME,
      source: { kind: "route", path: route },
    }));
    if (frames.length) await design.patchCanvas(routesPage.id, { op: "addFrames", frames }, by);
    await design.createCanvas({ kind: "page", name: "Brand" }, by);
    await design.createCanvas({ kind: "page", name: "Components" }, by);
  }

  const store: FileStore = {
    designs: () => run(list),

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
        const row: DesignEntry = { id, name, root, origin: kind };
        await saveList([...(await list()), row]);
        await addPages(await open(id), ["/"]);
        startInstall(row);
        return row;
      });
    },

    connect(input) {
      return run(async () => {
        const root = path.resolve(input);
        const rows = await list();
        const same = rows.find((d) => d.root === root);
        if (same) return same;

        const detected = await detectProject(root);
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
        if (!existing.success) {
          const { name: _name, ...rest } = detected;
          await writeAtomic(configFile, toJson({ version: 1, id, ...rest } satisfies DesignConfig));
        }
        const row: DesignEntry = { id, name: detected.name, root, origin: "connected" };
        await saveList([...rows, row]);
        // Routes come from the dev server once it runs; until then the Routes page is empty.
        await addPages(await open(id), []);
        return row;
      });
    },

    remove(id) {
      return run(async () => {
        const row = await entry(id);
        await saveList((await list()).filter((d) => d.id !== id));
        const was = opened.get(id);
        opened.delete(id);
        (await was?.catch(() => undefined))?.close();
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
      return Settings.parse({ ...DEFAULT_SETTINGS, ...(saved.success ? clean(saved.data) : {}) });
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

function routeName(route: string): string {
  const last = route.split("/").filter(Boolean).pop();
  if (!last) return "Home";
  const word = last.replace(/^[:$]/, "").replace(/[-_]+/g, " ");
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** Drops `undefined` fields, so a partial never overwrites a value with nothing. */
function clean<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}
