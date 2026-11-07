import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import type { Plugin, ViteDevServer } from "vite";
import { frameEntry, frameFile, frameHtml, readFrameConfig } from "./frame.ts";
import { allowsOrigin, LOOPBACK_HOSTS } from "./client/bridge.ts";
import { bridgeScript, injectIntoHtml } from "./html.ts";
import { scanRoutes } from "./routes.ts";
import { stamp } from "./stamp.ts";
import {
  addFiniteConfig,
  addFiniteSource,
  hasTailwindDirectives,
  writeFiniteConfig,
} from "./tailwind.ts";

export { scanRoutes, routeParams } from "./routes.ts";
export { stamp, rev } from "./stamp.ts";
export { finiteNext } from "./next/index.ts";

export type FiniteOptions = {
  /** The design root, where `.finite/` lives. */
  root: string;
  /**
   * Hosts the Finite shell may be served from (default: loopback names). The bridge connects only
   * to a parent page on one of them, and the dev server answers cross-origin requests only from
   * them. A name allows any port; `host:port` allows one.
   */
  allowedHosts?: readonly string[];
};

/** Where the bridge and frame entries are served. Requests under `/@finite/` never reach the app. */
const BRIDGE_URL = "/@finite/bridge";
const FRAME_URL = "/@finite/frame";
const BRIDGE_ID = "\0finite:bridge";
const FRAME_ID = "\0finite:frame";

/** Stamps `data-finite-loc`/`data-finite-rev`, injects the bridge, serves frames and routes. */
export function finite(options: FiniteOptions): Plugin[] {
  const root = fs.realpathSync(options.root);
  const allowedHosts = options.allowedHosts ?? LOOPBACK_HOSTS;
  const projectRequire = createRequire(path.join(root, "package.json"));
  const resolvable = (name: string) => {
    try {
      projectRequire.resolve(`${name}/package.json`);
      return true;
    } catch {
      return false;
    }
  };
  let base = "/";
  let framework = false;

  const stamping: Plugin = {
    name: "finite:stamp",
    apply: "serve",
    enforce: "pre",
    transform: {
      // Before the project's own `pre` plugins (route code splitting and the like), so locs and
      // revs describe the file as it is on disk.
      order: "pre",
      handler(code, id) {
        if (id.startsWith("\0") || !/\.[jt]sx$/.test(cleanId(id))) return null;
        const file = cleanId(id);
        const relative = path.relative(root, file);
        if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
        if (relative.split(path.sep).includes("node_modules")) return null;
        return stamp(code, relative.split(path.sep).join("/"), file);
      },
    },
  };

  /** Stylesheets that import Tailwind, rebuilt when a prototype file is added. */
  const tailwindSheets = new Set<string>();
  const finiteDir = path.join(root, ".finite") + path.sep;
  const tailwind: Plugin = {
    name: "finite:tailwind-source",
    apply: "serve",
    enforce: "pre",
    // `load`, not `transform`: Tailwind's own `pre` transform comes first and compiles the import away.
    load(id) {
      if (id.startsWith("\0") || /[?&](raw|url)\b/.test(id)) return null;
      const file = cleanId(id);
      if (!file.endsWith(".css") || !fs.existsSync(file)) return null;
      const code = fs.readFileSync(file, "utf8");
      const relative = path.relative(root, file);
      const own = !relative.startsWith("..") && !relative.split(path.sep).includes("node_modules");
      const css =
        own && hasTailwindDirectives(code)
          ? addFiniteConfig(code, file, writeFiniteConfig(root, file, code))
          : addFiniteSource(code, file, root);
      if (css === null) return null;
      tailwindSheets.add(id);
      return { code: css, map: null };
    },
    configureServer(server) {
      // Tailwind rescans only when its stylesheet is transformed again, and a new file doesn't
      // cause that, so a prototype the agent just wrote would render without its classes.
      server.watcher.on("add", (file) => {
        if (!file.startsWith(finiteDir)) return;
        for (const id of tailwindSheets) {
          const module = server.moduleGraph.getModuleById(id);
          if (module) void server.reloadModule(module);
        }
      });
    },
  };

  const frames: Plugin = {
    name: "finite:frames",
    apply: "serve",
    config() {
      const config = readFrameConfig(root);
      // Frame entries import these; pre-bundle them up front so the first frame doesn't reload.
      const deps = ["react", "react-dom", ...routerPackages(config.router)].filter(resolvable);
      return {
        server: {
          // Over the project's own setting: other sites must not read its source and routes.
          cors: {
            origin: (origin, done) =>
              // Vite's types say the error is an `Error`; the cors package takes `null` for none.
              done(null as never, origin !== undefined && allowsOrigin(allowedHosts, origin)),
          },
        },
        optimizeDeps: {
          include: deps.map((dep) => (dep === "react-dom" ? "react-dom/client" : dep)),
        },
      };
    },
    configResolved(config) {
      base = config.base;
      framework = config.plugins.some((p) => p.name === "react-router:inject-hmr-runtime");
    },
    resolveId(id) {
      if (id === BRIDGE_URL) return BRIDGE_ID;
      if (id === FRAME_URL || id.startsWith(`${FRAME_URL}?`))
        return FRAME_ID + id.slice(FRAME_URL.length);
      return null;
    },
    load(id) {
      if (id === BRIDGE_ID) return bridgeScript(allowedHosts);
      if (!id.startsWith(FRAME_ID)) return null;
      const query = new URLSearchParams(id.slice(FRAME_ID.length));
      const checked = frameFile(root, query.get("file"));
      if ("reason" in checked) return `throw new Error(${JSON.stringify(checked.reason)});`;
      const config = readFrameConfig(root);
      const routerPackage = routerPackages(config.router).find(resolvable);
      return frameEntry(config, {
        file: checked.file,
        exportName: query.get("export") || "default",
        routerPackage,
        framework,
      });
    },
    transformIndexHtml: {
      order: "pre",
      handler: () => [
        { tag: "script", attrs: { type: "module", src: BRIDGE_URL }, injectTo: "head-prepend" },
      ],
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        if (url.pathname === "/__finite/frame") {
          void serveFrame(server, req, res, url).catch(next);
          return;
        }
        if (url.pathname === "/__finite/routes") {
          void serveRoutes(server, root, res).catch(next);
          return;
        }
        // Framework mode renders HTML itself, without `transformIndexHtml`.
        if (req.method === "GET" && req.headers.accept?.includes("text/html")) {
          const src = `${base}${BRIDGE_URL.slice(1)}`;
          injectIntoHtml(res, `<script type="module" src="${src}"></script>`, BRIDGE_URL);
        }
        next();
      });
    },
  };

  return [stamping, tailwind, frames];
}

/** `GET /__finite/frame?file=<path>&export=<name>`: one component on its own page. */
async function serveFrame(
  server: ViteDevServer,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const entry = `${FRAME_URL}?${new URLSearchParams({
    file: url.searchParams.get("file") ?? "",
    export: url.searchParams.get("export") ?? "default",
  })}`;
  const html = await server.transformIndexHtml(
    url.pathname + url.search,
    frameHtml(entry),
    req.url,
  );
  res.statusCode = 200;
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.setHeader("cache-control", "no-cache");
  res.end(html);
}

/** `GET /__finite/routes`: the app's routes as JSON. */
async function serveRoutes(server: ViteDevServer, root: string, res: ServerResponse) {
  const config = readFrameConfig(root);
  let body: string;
  try {
    const routes = await scanRoutes(root, config.router, (file) => server.ssrLoadModule(file));
    res.statusCode = 200;
    body = JSON.stringify(routes);
  } catch (error) {
    res.statusCode = 500;
    body = JSON.stringify({ reason: `Couldn't read the routes: ${(error as Error).message}` });
  }
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store");
  res.end(body);
}

function routerPackages(router: string): string[] {
  if (router === "tanstack") return ["@tanstack/react-router"];
  if (router === "react-router") return ["react-router", "react-router-dom"];
  return [];
}

function cleanId(id: string): string {
  return id.replace(/[?#].*$/, "");
}
