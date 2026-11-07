import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { FiniteJson, Refused, type FiniteApp, type FiniteService } from "@finite/protocol";
import type { z } from "zod";
import { exists, readText } from "./files.ts";

export const WORKSPACE_FILE = "finite.json";

export type WorkspaceApp = FiniteApp & { name: string; /** Absolute. */ dir: string };
export type WorkspaceService = FiniteService & { name: string; /** Absolute `cwd`. */ dir: string };

/** A parsed and validated `finite.json`. */
export type Workspace = Omit<FiniteJson, "apps" | "services"> & {
  root: string;
  file: string;
  /** The sha1 of the file's text, so callers can tell when it changed. */
  hash: string;
  apps: Record<string, WorkspaceApp>;
  services: Record<string, WorkspaceService>;
};

/**
 * The nearest folder at or above `dir` with a `finite.json`. The walk stops at the filesystem root
 * and after the folder that holds `.git`, so it never leaves the repository.
 */
export async function findWorkspace(
  dir: string,
): Promise<{ root: string; file: string } | undefined> {
  let current = path.resolve(dir);
  for (;;) {
    const file = path.join(current, WORKSPACE_FILE);
    if (await isFile(file)) return { root: current, file };
    if (await exists(path.join(current, ".git"))) return undefined;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/**
 * Where `dir`'s `finite.json` is, or belongs when there's none yet: the nearest one at or above
 * `dir`, else the repository root (the folder holding `.git`), else `dir` itself.
 */
export async function configRoot(dir: string): Promise<string> {
  const found = await findWorkspace(dir);
  if (found) return found.root;
  let current = path.resolve(dir);
  for (;;) {
    if (await exists(path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(dir);
    current = parent;
  }
}

/** Reads and validates `<root>/finite.json`, or refuses (`invalid-config`) listing every problem. */
export async function readWorkspace(root: string): Promise<Workspace> {
  root = path.resolve(root);
  const file = path.join(root, WORKSPACE_FILE);
  const text = await readText(file);
  if (text === undefined) {
    throw new Refused(
      `${file} doesn't exist. Write it, or connect the app folder itself.`,
      "not-found",
    );
  }
  const fail = (problems: string[]) =>
    new Refused(
      `${file} isn't valid. Fix ${problems.length === 1 ? "this" : `these ${problems.length} problems`}:\n${problems.map((p) => `- ${p}`).join("\n")}`,
      "invalid-config",
    );

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw fail([`it isn't valid JSON: ${(error as Error).message}.`]);
  }
  const parsed = FiniteJson.safeParse(raw);
  if (!parsed.success) throw fail(parsed.error.issues.map((issue) => describeIssue(issue, raw)));
  const config = parsed.data;

  const problems: string[] = [];
  const serviceNames = Object.keys(config.services ?? {});
  const missing = (where: string, name: string) =>
    `${where}: there's no service "${name}". Add it under services, or remove it from needs.`;

  const apps: Record<string, WorkspaceApp> = {};
  const byDir = new Map<string, string>();
  for (const [name, app] of Object.entries(config.apps)) {
    const dir = path.resolve(root, app.path);
    apps[name] = { ...app, name, dir };
    for (const need of app.needs ?? []) {
      if (!serviceNames.includes(need)) problems.push(missing(`apps.${name}.needs`, need));
    }
    const where = `apps.${name}.path`;
    if (outside(root, dir)) {
      problems.push(
        `${where}: "${app.path}" is outside ${root}. Use a folder inside the workspace.`,
      );
      continue;
    }
    const other = byDir.get(dir);
    if (other !== undefined) {
      problems.push(
        `${where}: "${app.path}" is also apps.${other}'s folder. Each app needs its own folder.`,
      );
      continue;
    }
    byDir.set(dir, name);
    if (!(await isDir(dir))) {
      problems.push(
        `${where}: ${dir} doesn't exist. Point it at the app's folder, relative to ${root}.`,
      );
    } else if (!(await isFile(path.join(dir, "package.json")))) {
      problems.push(
        `${where}: ${dir} has no package.json. Point it at the app's folder, the one with its package.json.`,
      );
    }
  }

  const services: Record<string, WorkspaceService> = {};
  for (const [name, service] of Object.entries(config.services ?? {})) {
    const dir = path.resolve(root, service.cwd ?? ".");
    services[name] = { ...service, name, dir };
    for (const need of service.needs ?? []) {
      if (!serviceNames.includes(need)) problems.push(missing(`services.${name}.needs`, need));
    }
    if (service.cwd === undefined) continue;
    const where = `services.${name}.cwd`;
    if (outside(root, dir)) {
      problems.push(
        `${where}: "${service.cwd}" is outside ${root}. Use a folder inside the workspace.`,
      );
    } else if (!(await isDir(dir))) {
      problems.push(`${where}: ${dir} doesn't exist. Point it at a folder, relative to ${root}.`);
    }
  }
  problems.push(...cycles(services));

  if (problems.length) throw fail(problems);
  return {
    ...config,
    root,
    file,
    hash: createHash("sha1").update(text).digest("hex"),
    apps,
    services,
  };
}

/** The app whose folder is `dir` or holds it; the deepest one when app folders nest. */
export function appFor(workspace: Workspace, dir: string): WorkspaceApp | undefined {
  const target = path.resolve(dir);
  let best: WorkspaceApp | undefined;
  for (const app of Object.values(workspace.apps)) {
    if (outside(app.dir, target)) continue;
    if (!best || app.dir.length > best.dir.length) best = app;
  }
  return best;
}

/** The services an app needs, transitively, in start order: each one after the services it needs. */
export function servicesFor(workspace: Workspace, appName: string): string[] {
  const app = workspace.apps[appName];
  if (!app) throw new Refused(`${workspace.file} has no app "${appName}".`, "not-found");
  const order: string[] = [];
  const visit = (name: string) => {
    if (order.includes(name)) return;
    for (const need of workspace.services[name]?.needs ?? []) visit(need);
    order.push(name);
  };
  for (const need of app.needs ?? []) visit(need);
  return order;
}

/**
 * The env `finite.json` gives an app's setup and dev server or a service: its top-level `env`, then
 * the app's or service's own `env` over it. The caller puts both over `process.env`.
 */
export function envFor(
  workspace: Workspace,
  target: { app: string } | { service: string },
): Record<string, string> {
  const own = "app" in target ? workspace.apps[target.app] : workspace.services[target.service];
  if (!own) {
    const what = "app" in target ? `app "${target.app}"` : `service "${target.service}"`;
    throw new Refused(`${workspace.file} has no ${what}.`, "not-found");
  }
  return { ...workspace.env, ...own.env };
}

/** Every `needs` cycle among the services, each reported once. */
function cycles(services: Record<string, WorkspaceService>): string[] {
  const problems: string[] = [];
  const done = new Set<string>();
  const stack: string[] = [];
  const visit = (name: string) => {
    const at = stack.indexOf(name);
    if (at !== -1) {
      const loop = [...stack.slice(at), name];
      problems.push(
        `services.${name}.needs: ${loop.join(" needs ")}, a cycle. Remove one of these needs so the services can start in order.`,
      );
      return;
    }
    if (done.has(name) || !services[name]) return;
    stack.push(name);
    for (const need of services[name].needs ?? []) visit(need);
    stack.pop();
    done.add(name);
  };
  for (const name of Object.keys(services)) visit(name);
  return problems;
}

const KNOWN_KEYS = {
  top: ["$schema", "setup", "env", "apps", "services"],
  app: ["path", "setup", "needs", "env"],
  service: ["run", "cwd", "ready", "needs", "env"],
};

/** A zod issue as a sentence that names the key path and says what to write instead. */
function describeIssue(issue: z.core.$ZodIssue, raw: unknown): string {
  const keys = issue.path.map(String);
  const where = keys.length ? keys.join(".") : "finite.json";
  const value = keys.reduce<unknown>(
    (at, key) => (at && typeof at === "object" ? (at as Record<string, unknown>)[key] : undefined),
    raw,
  );
  switch (issue.code) {
    case "invalid_type": {
      const expected =
        issue.expected === "record" || issue.expected === "object"
          ? "an object"
          : `a ${issue.expected}`;
      if (keys.length === 0) return `finite.json must be an object with an "apps" key.`;
      if (value === undefined) return `${where} is missing. Add it (${expected}).`;
      return `${where}: expected ${expected}, got ${JSON.stringify(value)}.`;
    }
    case "unrecognized_keys": {
      const known =
        keys.length === 0
          ? KNOWN_KEYS.top
          : keys[0] === "apps"
            ? KNOWN_KEYS.app
            : KNOWN_KEYS.service;
      return `${where}: unknown ${issue.keys.length === 1 ? "key" : "keys"} ${issue.keys.map((k) => `"${k}"`).join(", ")}. Remove ${issue.keys.length === 1 ? "it" : "them"}, or use one of ${known.join(", ")}.`;
    }
    case "invalid_key":
      return `${keys.slice(0, -1).join(".")}: "${keys.at(-1)}" isn't a valid name. Use lowercase letters, digits and hyphens, starting with a letter or digit.`;
    case "invalid_union":
      if (keys.at(-1) === "ready") {
        return `${where}: expected a URL like "http://localhost:4000/health" or a port number like 5432, got ${JSON.stringify(value)}.`;
      }
      return `${where}: ${issue.message}.`;
    case "too_small":
    case "too_big":
      if (typeof value === "string") return `${where} is empty. Give it a value.`;
      if (typeof value !== "number") return `${where}: ${issue.message}.`;
      return `${where}: ${JSON.stringify(value)} isn't a port. Use a number from 1 to 65535.`;
    default:
      return `${where}: ${issue.message}.`;
  }
}

function outside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

async function isFile(file: string): Promise<boolean> {
  return fs.stat(file).then(
    (stat) => stat.isFile(),
    () => false,
  );
}

async function isDir(dir: string): Promise<boolean> {
  return fs.stat(dir).then(
    (stat) => stat.isDirectory(),
    () => false,
  );
}
