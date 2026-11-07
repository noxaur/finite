import fs from "node:fs/promises";
import path from "node:path";
import type { Route } from "@finite/protocol";
import { routeParams } from "../routes.ts";

const PAGES_SPECIAL = new Set(["_app", "_document", "_error"]);

/**
 * The routes of a Next.js app, from its folders: the App Router's `page` files under `app/` and
 * every page under `pages/`, the App Router's first when a URL is in both. `app/` and `pages/` at
 * the root win over `src/app/` and `src/pages/`, as in Next. Paths keep Next's own segments
 * (`[id]`, `[...slug]`, `[[...slug]]`), which `routeHref` fills. Only files with one of the
 * config's `pageExtensions` are pages, as `pageExtension` matches them.
 */
export async function nextRoutes(root: string, pageExtensions: string[]): Promise<Route[]> {
  const page = pageExtension(pageExtensions);
  const atRoot = (await isDir(path.join(root, "app"))) || (await isDir(path.join(root, "pages")));
  const base = atRoot ? "" : "src";
  const routes = new Map<string, Route>();
  const add = (segments: string[], file: string) => {
    const routePath = `/${segments.join("/")}`;
    if (!routes.has(routePath)) {
      routes.set(routePath, { path: routePath, file, params: routeParams(routePath) });
    }
  };
  await appRoutes(root, path.posix.join(base, "app"), [], page, add);
  await pagesRoutes(root, path.posix.join(base, "pages"), [], page, add);
  return [...routes.values()];
}

type Add = (segments: string[], file: string) => void;

/**
 * Matches a file's page extension, as Next does: `.page.tsx` in `index.page.tsx` when
 * `pageExtensions` has `page.tsx`. Also matches the App Router's `layout` files.
 */
export function pageExtension(pageExtensions: string[]): RegExp {
  const escaped = pageExtensions.map((ext) => ext.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`\\.(?:${escaped.join("|")})$`);
}

/**
 * Walks an App Router folder. Route groups `(x)` and parallel slots `@x` add no segment, private
 * folders `_x` and intercepting routes `(.)x` aren't routes, and `%5Fx` is the URL segment `_x`.
 * Slots are walked last, so a URL keeps the page outside the slot.
 */
async function appRoutes(root: string, dir: string, segments: string[], page: RegExp, add: Add) {
  const entries = await readDir(root, dir);
  const file = entries.find((entry) => entry.isFile() && entry.name.replace(page, "") === "page");
  if (file) add(segments, path.posix.join(dir, file.name));
  const folders = entries.filter((entry) => entry.isDirectory());
  folders.sort((a, b) => Number(a.name.startsWith("@")) - Number(b.name.startsWith("@")));
  for (const folder of folders) {
    const name = folder.name;
    const child = path.posix.join(dir, name);
    if (name.startsWith("_") || name.startsWith(".") || name === "node_modules") continue;
    if (/^\(\.+\)/.test(name)) continue;
    if (/^\(.+\)$/.test(name) || name.startsWith("@")) {
      await appRoutes(root, child, segments, page, add);
      continue;
    }
    const segment = name.replace(/%5F/gi, "_");
    if (segment === "__finite") continue;
    await appRoutes(root, child, [...segments, segment], page, add);
  }
}

/** Walks a Pages Router folder: every page but `_app`, `_document`, `_error` and `api/`. */
async function pagesRoutes(root: string, dir: string, segments: string[], page: RegExp, add: Add) {
  for (const entry of await readDir(root, dir)) {
    const name = entry.name;
    const child = path.posix.join(dir, name);
    if (name.startsWith(".") || name === "node_modules") continue;
    if (entry.isDirectory()) {
      if (segments.length === 0 && name === "api") continue;
      if (name === "__finite" || /^%5F%5Ffinite$/i.test(name)) continue;
      await pagesRoutes(root, child, [...segments, name], page, add);
      continue;
    }
    if (!page.test(name) || name.endsWith(".d.ts")) continue;
    const stem = name.replace(page, "");
    if (segments.length === 0 && PAGES_SPECIAL.has(stem)) continue;
    add(stem === "index" ? segments : [...segments, stem], child);
  }
}

async function readDir(root: string, dir: string) {
  const entries = await fs.readdir(path.join(root, dir), { withFileTypes: true }).catch(() => []);
  return entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

async function isDir(dir: string): Promise<boolean> {
  return (await fs.stat(dir).catch(() => undefined))?.isDirectory() ?? false;
}
