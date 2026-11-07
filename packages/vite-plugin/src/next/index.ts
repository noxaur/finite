import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { allowsOrigin } from "../client/bridge.ts";
import { frameFile, PAGE_FILL, readFrameConfig } from "../frame.ts";
import { bridgeScript, streamIntoHtml } from "../html.ts";
import {
  finiteConfigFile,
  hasTailwindDirectives,
  importsTailwind,
  writeFiniteConfig,
} from "../tailwind.ts";
import type { NextSettings } from "./adapter.ts";
import { nextRoutes, pageExtension } from "./routes.ts";

export type FiniteNextOptions = {
  root: string;
  /** Hosts the Finite shell may be served from, as for the Vite plugin. */
  allowedHosts: readonly string[];
};

/** Finite's files for a Next.js preview; only the frame mount lives outside, in `app/`. */
const RUNTIME = ".finite/runtime";
/** Where `next dev` builds, so the project's own `.next` (and its dev lock) is left alone. */
const DIST_DIR = `${RUNTIME}/next`;
const BRIDGE_URL = "/__finite/bridge.js";
const ASSET_URL = "/__finite/asset";
/** A request the host makes to its own frame route, which goes straight to Next. */
const PROBE = "x-finite-probe";
/** How long Next may take to see a registry change. */
const REGISTRY_TIMEOUT_MS = 10_000;
const MOUNT_MARKER =
  "// Written by Finite while it previews this project, and removed when it stops.";
/** The sha1 of the mount Finite last wrote, so a mount someone edited is never overwritten. */
const MOUNT_RECORD = `${RUNTIME}/mount.sha1`;
/** `next dev` in a package.json script, and the flags after it up to the next command. */
const NEXT_DEV = /\bnext\s+dev\b([^&|;]*)/;

/**
 * Everything Finite adds to a Next.js dev server, for `next-host.mjs`: the files that make file
 * frames, the brand board and Tailwind's `.finite/` source work, and the request handling that
 * goes in front of Next's own (routes, the bridge and its injection, CORS). `prepare` takes the
 * project's resolved config, from the adapter; Finite's URLs go under its `basePath`.
 */
export function finiteNext(options: FiniteNextOptions) {
  const root = fs.realpathSync(options.root);
  const { allowedHosts } = options;
  const config = readFrameConfig(root);
  const pages = config.router === "next-pages";
  const at = (file: string) => path.join(root, file);
  const isDir = (dir: string) => fs.statSync(at(dir), { throwIfNoEntry: false })?.isDirectory();
  // As in Next, `app/` or `pages/` at the root win over `src/app/` and `src/pages/`.
  const base = isDir("app") || isDir("pages") ? "" : "src/";
  /** The project's resolved config, set by `prepare`. */
  let settings: NextSettings = { basePath: "", pageExtensions: [] };
  let extension = pageExtension([]);
  let mount: string | undefined;
  let mountCode = "";

  /** Each stylesheet that imports Tailwind v4, and Finite's copy that adds `.finite/` as a source. */
  const sheets: Record<string, string> = {};
  /** Each Tailwind v3 stylesheet, and Finite's config that adds `.finite/` to `content`. */
  const configs: Record<string, string> = {};
  for (const css of config.css) {
    const code = fs.existsSync(at(css)) ? fs.readFileSync(at(css), "utf8") : "";
    if (importsTailwind(code)) sheets[at(css)] = at(`${RUNTIME}/css/${css}`);
    else if (hasTailwindDirectives(code)) configs[at(css)] = finiteConfigFile(root, at(css));
  }

  /** The files the frame registry imports, starting with those of the last run. */
  const registered = new Set<string>();
  if (fs.existsSync(at(`${RUNTIME}/frames.ts`))) {
    const code = fs.readFileSync(at(`${RUNTIME}/frames.ts`), "utf8");
    for (const [, file] of code.matchAll(/^ {2}("[^"\n]+"): \(\) => import/gm)) {
      registered.add(JSON.parse(file!));
    }
  }

  const writeIfChanged = (file: string, code: string) => {
    if (fs.existsSync(file) && fs.readFileSync(file, "utf8") === code) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, code);
    fs.renameSync(temp, file);
  };

  /**
   * `.finite/runtime/frames.ts`: a literal `import()` per file a frame has shown, so Next compiles
   * each one. Files that are gone are dropped, or the whole mount would fail to compile.
   */
  const writeRegistry = () => {
    for (const file of registered) if (!fs.existsSync(at(file))) registered.delete(file);
    const fromRuntime = (file: string) => {
      const relative = path.posix.relative(RUNTIME, file);
      return relative.startsWith(".") ? relative : `./${relative}`;
    };
    // The Pages Router takes global CSS only from `_app`, which file frames render inside anyway.
    const css = pages ? [] : config.css.map((file) => sheets[at(file)] ?? at(file));
    const lines = [
      "// Written by Finite: the files file frames render. Don't edit.",
      ...css.map((file) => `import ${JSON.stringify(fromRuntime(path.relative(root, file)))};`),
      config.wrapper
        ? `export { default as Wrapper } from ${JSON.stringify(fromRuntime(config.wrapper))};`
        : `export const Wrapper = ({ children }: { children: React.ReactNode }) => children;`,
      "export const frames: Record<string, () => Promise<Record<string, any>>> = {",
      ...[...registered]
        .sort()
        .map(
          (file) =>
            `  ${JSON.stringify(file)}: () => import(${JSON.stringify(fromRuntime(file))}),`,
        ),
      "};",
      "",
    ];
    writeIfChanged(at(`${RUNTIME}/frames.ts`), lines.join("\n"));
  };

  /** `.finite/runtime/brand.ts`: what the brand board finds with `import.meta.glob` under Vite. */
  const writeBrand = () => {
    const brandDir = readBrandDir(root);
    const files: Record<string, string> = {};
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(at(dir), { withFileTypes: true })) {
        const file = `${dir}/${entry.name}`;
        if (entry.isDirectory()) walk(file);
        else if (entry.isFile()) {
          files[file] = `${settings.basePath}${ASSET_URL}?${new URLSearchParams({ file })}`;
        }
      }
    };
    if (brandDir && isDir(brandDir)) walk(brandDir);
    const css: Record<string, string> = {};
    for (const file of config.css) {
      if (fs.existsSync(at(file))) css[file] = fs.readFileSync(at(file), "utf8");
    }
    writeIfChanged(
      at(`${RUNTIME}/brand.ts`),
      [
        "// Written by Finite: the brand folder's files and the design's CSS, for the brand board.",
        `export const files: Record<string, string> = ${JSON.stringify(files, null, 2)};`,
        `export const sheets: Record<string, string> = ${JSON.stringify(css, null, 2)};`,
        "",
      ].join("\n"),
    );
  };

  /** Serves a file from the brand folder, which the board shows by URL. */
  const serveAsset = (res: ServerResponse, url: URL) => {
    const brandDir = readBrandDir(root);
    const checked = frameFile(root, url.searchParams.get("file"));
    const inBrand =
      brandDir !== undefined && "file" in checked && checked.file.startsWith(`${brandDir}/`);
    if (!inBrand) {
      res.statusCode = 404;
      res.end("Finite serves only files in the brand folder here.");
      return;
    }
    res.setHeader("content-type", contentType(checked.file));
    res.setHeader("cache-control", "no-cache");
    fs.createReadStream(at(checked.file)).pipe(res);
  };

  return {
    root,
    distDir: DIST_DIR,
    sheets,
    configs,
    /**
     * The file frame route, relative to the root, once prepared. Never `import()`ed from a query:
     * frames come only from the registry's literal imports.
     */
    get mount() {
      return mount;
    },
    get basePath() {
      return settings.basePath;
    },

    /**
     * Writes Finite's files: `.finite/runtime/` (ignored by git and Tailwind), the generated
     * stylesheets, the registry and brand maps, and the mount, added to `.git/info/exclude`.
     * Throws a reason when the project's own config or files are in the way.
     */
    prepare(resolved: NextSettings) {
      settings = resolved;
      // The mount is TSX, so it takes the first page extension that holds TSX.
      const ext = settings.pageExtensions.find((e) => e.endsWith("tsx"));
      if (!ext) {
        throw new Error(
          `next.config's pageExtensions (${settings.pageExtensions.join(", ")}) has no TSX extension, and Finite renders file frames through a TSX page. Add one, such as "tsx" or "page.tsx", then open the design again.`,
        );
      }
      /*
       * The route that renders file frames. An App Router folder starting with `_` is private, so
       * the mount spells `__finite` as `%5F%5Ffinite`, which Next serves at `/__finite/frame`. It
       * goes next to the root layout, which may sit in a route group (`app/(site)/layout.tsx`);
       * groups add no URL segment.
       */
      extension = pageExtension(settings.pageExtensions);
      mount = pages
        ? `${base}pages/__finite/frame.${ext}`
        : `${rootLayoutDir(root, `${base}app`, extension)}/%5F%5Ffinite/frame/page.${ext}`;
      const registry = path.posix.relative(path.posix.dirname(mount), `${RUNTIME}/frames`);
      mountCode = pages ? pagesMount(registry) : appMount(registry);

      writeIfChanged(at(`${RUNTIME}/.gitignore`), "*\n");
      for (const [sheet, copy] of Object.entries(sheets)) {
        const relative = path.relative(path.dirname(copy), sheet).split(path.sep).join("/");
        writeIfChanged(
          copy,
          [
            "/* Written by Finite: the project's stylesheet, with .finite/ as a Tailwind source. */",
            `@import ${JSON.stringify(relative)};`,
            `@source ${JSON.stringify(at(".finite"))};`,
            `@source not ${JSON.stringify(at(RUNTIME))};`,
            "",
          ].join("\n"),
        );
      }
      for (const sheet of Object.keys(configs)) {
        writeFiniteConfig(root, sheet, fs.readFileSync(sheet, "utf8"));
      }
      writeRegistry();
      writeBrand();
      const existing = fs.existsSync(at(mount)) ? fs.readFileSync(at(mount), "utf8") : undefined;
      if (existing !== undefined && !existing.startsWith(MOUNT_MARKER)) {
        throw new Error(
          `${mount} is the project's own file, but Finite renders file frames there. Move or rename it, then open the design again.`,
        );
      }
      const recorded = fs.existsSync(at(MOUNT_RECORD))
        ? fs.readFileSync(at(MOUNT_RECORD), "utf8")
        : undefined;
      if (existing !== undefined && existing !== mountCode && sha1(existing) !== recorded) {
        throw new Error(
          `${mount} changed since Finite wrote it, and Finite renders file frames there. Keep your changes somewhere else and delete it, then open the design again.`,
        );
      }
      excludeFromGit(root, mount);
      writeIfChanged(at(MOUNT_RECORD), sha1(mountCode));
      writeIfChanged(at(mount), mountCode);
    },

    /** Whether a file has one of the config's `pageExtensions`, so it may be a route. */
    isPage: (file: string) => settings.pageExtensions.length > 0 && extension.test(file),

    /** The brand folder, relative to the root, whose files the brand board lists. */
    brandDir: () => readBrandDir(root),

    /** Brings the registry and brand maps up to date after files changed. */
    sync() {
      writeRegistry();
      writeBrand();
    },

    /** Removes the mount, unless someone changed it, and the folders it leaves empty. */
    close() {
      if (!mount) return;
      const file = at(mount);
      if (!fs.existsSync(file) || fs.readFileSync(file, "utf8") !== mountCode) return;
      fs.rmSync(file);
      for (let dir = path.dirname(file); dir !== at(`${base}app`) && dir !== at(`${base}pages`);) {
        if (fs.readdirSync(dir).length > 0) break;
        fs.rmdirSync(dir);
        dir = path.dirname(dir);
      }
    },

    /**
     * Handles what Finite serves itself and returns `true`, or prepares the response for Next
     * (CORS, the bridge in HTML, a frame's file in the registry) and returns `false`.
     */
    async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
      const url = new URL(req.url ?? "/", "http://localhost");
      const { basePath } = settings;
      // Finite's own URLs, like the project's, are under the basePath.
      const finitePath =
        url.pathname === basePath
          ? "/"
          : url.pathname.startsWith(`${basePath}/`)
            ? url.pathname.slice(basePath.length)
            : undefined;
      if (!allowsHost(allowedHosts, req.headers.host)) {
        res.statusCode = 403;
        res.end("This host isn't allowed; open the design from Finite.");
        return true;
      }
      const origin = req.headers.origin;
      if (origin && allowsOrigin(allowedHosts, origin)) {
        res.setHeader("access-control-allow-origin", origin);
        res.setHeader("vary", "origin");
        if (req.method === "OPTIONS" && req.headers["access-control-request-method"]) {
          res.setHeader("access-control-allow-methods", "GET,HEAD,PUT,PATCH,POST,DELETE");
          const headers = req.headers["access-control-request-headers"];
          if (headers) res.setHeader("access-control-allow-headers", headers);
          res.statusCode = 204;
          res.end();
          return true;
        }
      }
      if (finitePath === "/__finite/routes") {
        let body: string;
        try {
          const routes = await nextRoutes(root, settings.pageExtensions);
          // The mount is a route to Next, not to the person.
          body = JSON.stringify(routes.filter((r) => !r.path.startsWith("/__finite")));
          res.statusCode = 200;
        } catch (error) {
          res.statusCode = 500;
          body = JSON.stringify({
            reason: `Couldn't read the routes: ${(error as Error).message}`,
          });
        }
        res.setHeader("content-type", "application/json");
        res.setHeader("cache-control", "no-store");
        res.end(body);
        return true;
      }
      if (finitePath === BRIDGE_URL) {
        res.setHeader("content-type", "text/javascript");
        res.setHeader("cache-control", "no-cache");
        res.end(bridgeScript(allowedHosts));
        return true;
      }
      if (finitePath === ASSET_URL) {
        serveAsset(res, url);
        return true;
      }
      const frame = finitePath === "/__finite/frame";
      if (frame && req.headers[PROBE]) return false;
      if (frame) {
        const checked = frameFile(root, url.searchParams.get("file"));
        if ("reason" in checked) {
          res.statusCode = 400;
          res.setHeader("content-type", "text/plain; charset=utf-8");
          res.end(checked.reason);
          return true;
        }
        if (!registered.has(checked.file)) {
          registered.add(checked.file);
          writeRegistry();
          await untilRegistered(`http://${req.headers.host}${req.url}`);
        }
      }
      if (req.method === "GET" && !req.headers.rsc) {
        const bridge = `<script type="module" src="${basePath}${BRIDGE_URL}"></script>`;
        streamIntoHtml(res, frame ? bridge + PAGE_FILL : bridge);
      }
      return false;
    },
  };
}

/**
 * Which bundler `next dev` runs the project with. The flag on the script that runs `next dev`
 * (`dev` first) decides, as it does for the person. Without one, Next 16 picks Turbopack and
 * exits when the config has a `webpack` function but no `turbopack` config, so that means
 * webpack: such a project can only run on it. `config` says what Next's raw config for the dev
 * phase has: a `webpack` function, and a `turbopack` (or `experimental.turbo`) config.
 */
export function nextBundler(
  scripts: Record<string, string> | undefined,
  config: { webpack: boolean; turbopack: boolean },
): "webpack" | "turbopack" {
  const runs = Object.entries(scripts ?? {}).flatMap(([key, value]) => {
    const flags = NEXT_DEV.exec(value)?.[1];
    return flags === undefined ? [] : [{ key, flags }];
  });
  const flags = (runs.find((run) => run.key === "dev") ?? runs[0])?.flags ?? "";
  if (/(^|\s)--webpack\b/.test(flags)) return "webpack";
  if (/(^|\s)--turbo(pack)?\b/.test(flags)) return "turbopack";
  return config.webpack && !config.turbopack ? "webpack" : "turbopack";
}

/**
 * Waits until Next renders a frame whose file was just added to the registry. Next notices the
 * change a moment after the write, and until then the mount answers 404.
 */
async function untilRegistered(url: string): Promise<void> {
  const deadline = Date.now() + REGISTRY_TIMEOUT_MS;
  // node:http, not fetch: Next patches the global fetch in its own process.
  const status = () =>
    new Promise<number>((resolve, reject) => {
      http
        .get(url, { headers: { [PROBE]: "1" } }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        })
        .on("error", reject);
    });
  while (Date.now() < deadline && (await status()) === 404) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** The App Router mount: a server component that renders the export inside the wrapper. */
function appMount(registry: string): string {
  return `${MOUNT_MARKER}
// It renders one component for a Finite file frame. See .finite/runtime/frames.ts.
import { notFound } from "next/navigation";
import { frames, Wrapper } from ${JSON.stringify(registry)};

type Query = Promise<Record<string, string | string[] | undefined>>;

export default async function FiniteFrame({ searchParams }: { searchParams: Query }) {
  const query = await searchParams;
  const file = String(query.file);
  const name = String(query.export ?? "default");
  const load = frames[file];
  // Finite adds the file to the registry before Next renders this, and waits while this is 404.
  if (!load) notFound();
  const Component = (await load())[name];
  if (!Component) throw new Error(\`\${file} has no export named \${name}\`);
  return (
    <Wrapper>
      <Component />
    </Wrapper>
  );
}
`;
}

/** The Pages Router mount: renders the export on the client. */
function pagesMount(registry: string): string {
  return `${MOUNT_MARKER}
// It renders one component for a Finite file frame. See .finite/runtime/frames.ts.
import type { GetServerSideProps } from "next";
import { useRouter } from "next/router";
import { type ComponentType, useEffect, useState } from "react";
import { frames, Wrapper } from ${JSON.stringify(registry)};

// Finite adds the file to the registry before Next renders this, and waits while this is 404.
export const getServerSideProps: GetServerSideProps = async ({ query }) =>
  frames[String(query.file)] ? { props: {} } : { notFound: true };

export default function FiniteFrame() {
  const { query } = useRouter();
  const [shown, setShown] = useState<{ Component: ComponentType } | Error | null>(null);
  const file = String(query.file);
  const name = String(query.export ?? "default");
  useEffect(() => {
    let live = true;
    frames[file]!().then((module) => {
      if (!live) return;
      const Component = module[name];
      setShown(Component ? { Component } : new Error(\`\${file} has no export named \${name}\`));
    }, (error: Error) => live && setShown(error));
    return () => {
      live = false;
    };
  }, [file, name]);
  if (shown instanceof Error) throw shown;
  if (!shown) return null;
  return (
    <Wrapper>
      <shown.Component />
    </Wrapper>
  );
}
`;
}

/**
 * The App Router folder that holds the root layout: `app/` itself, or the first route group
 * under it, depth first, that has a `layout` file. `app/` when there is none.
 */
function rootLayoutDir(root: string, app: string, layout: RegExp): string {
  const find = (dir: string): string | undefined => {
    const entries = fs.readdirSync(path.join(root, dir), { withFileTypes: true });
    const isLayout = (name: string) => layout.test(name) && name.replace(layout, "") === "layout";
    if (entries.some((e) => e.isFile() && isLayout(e.name))) return dir;
    const groups = entries.filter((e) => e.isDirectory() && /^\([^.].*\)$/.test(e.name));
    for (const group of groups.map((e) => e.name).sort()) {
      const found = find(`${dir}/${group}`);
      if (found) return found;
    }
    return undefined;
  };
  return (fs.existsSync(path.join(root, app)) && find(app)) || app;
}

function sha1(text: string): string {
  return createHash("sha1").update(text).digest("hex");
}

function readBrandDir(root: string): string | undefined {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(root, ".finite/design.json"), "utf8"));
    return typeof config.brandDir === "string" ? config.brandDir.replace(/\/+$/, "") : undefined;
  } catch {
    return undefined;
  }
}

/** Adds the mount to `.git/info/exclude`, so it never shows as a change. Not a repo: nothing. */
function excludeFromGit(root: string, file: string): void {
  let exclude: string;
  let top: string;
  try {
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: "pipe" }).trim();
    top = git("rev-parse", "--show-toplevel");
    exclude = path.resolve(root, git("rev-parse", "--git-path", "info/exclude"));
  } catch {
    return;
  }
  const line = `/${path.relative(fs.realpathSync(top), path.join(root, file)).split(path.sep).join("/")}`;
  const current = fs.existsSync(exclude) ? fs.readFileSync(exclude, "utf8") : "";
  if (current.split("\n").includes(line)) return;
  fs.mkdirSync(path.dirname(exclude), { recursive: true });
  const separator = current === "" || current.endsWith("\n") ? "" : "\n";
  fs.appendFileSync(exclude, `${separator}# Finite's file frame route\n${line}\n`);
}

/**
 * Vite's rule against DNS rebinding, which Next doesn't have: the Host must be an IP address,
 * `localhost` or a name under it, or one of the allowed hosts.
 */
function allowsHost(allowedHosts: readonly string[], host: string | undefined): boolean {
  if (!host) return false;
  const name = host
    .replace(/:\d+$/, "")
    .replace(/^\[|\]$/g, "")
    .toLowerCase();
  if (name === "localhost" || name.endsWith(".localhost")) return true;
  if (/^[\d.]+$/.test(name) || name.includes(":")) return true;
  return allowedHosts.some((h) => h.toLowerCase().replace(/:\d+$/, "") === name);
}

const TYPES: Record<string, string> = {
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
};

function contentType(file: string): string {
  return TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}
