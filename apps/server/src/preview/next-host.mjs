// One Next.js design's dev server, run as a child of the Finite server (see index.ts), with the
// same IPC as vite-host.mjs: { type: "ready", url } | { type: "error", message } |
// { type: "changed" }.
// It loads the project's own `next` and runs `next dev` as a custom server, with Turbopack or, for
// a project that needs it, webpack (`nextBundler`). Next's config gets Finite's adapter (stamping
// loader, distDir under .finite/runtime), and a node:http server in front answers Finite's own
// URLs and adds the bridge to every page.
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import { createRequire, registerHooks } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const CHANGED_DEBOUNCE_MS = 300;
const SOURCE = /\.(tsx?|jsx?|mts|mjs|json|css)$/;
/** Next's config loader, which imports the project's next.config and the adapter. */
const CONFIG_LOADER = /\/next\/dist\/server\/config\.js$/;
const CONFIG_FILE = /\/next\.config\.[cm]?[jt]s$/;

const { root, host, plugin, adapter, loader, allowedHosts } = JSON.parse(
  process.env.FINITE_PREVIEW ?? "{}",
);
const send = (message) => process.send?.(message);

// The Finite server went away: don't outlive it.
process.on("disconnect", () => process.exit(0));

let finite;
try {
  const projectRequire = createRequire(path.join(root, "package.json"));
  let nextPath;
  try {
    nextPath = projectRequire.resolve("next");
  } catch {
    throw new Error(
      `Next.js isn't installed in ${root}. Run your package manager's install there, then try again.`,
    );
  }
  const { finiteNext, nextBundler } = await import(pathToFileURL(plugin).href);
  finite = finiteNext({ root, allowedHosts });

  const { scripts } = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const bundler = nextBundler(scripts, await rawConfig(root));

  // Next calls the adapter's `modifyConfig` on the config it loads, which hands Finite the
  // resolved config before Next scans the routes, so the mount is there when it does.
  let configured = false;
  globalThis.FINITE_NEXT_CONFIGURE = (settings) => {
    finite.prepare(settings);
    configured = true;
  };
  process.env.NEXT_ADAPTER_PATH = adapter;
  // A project's own `adapterPath` wins over the variable. Send Next's import of that adapter to
  // Finite's, which wraps it (adapter.ts).
  const ownAdapter = pathToFileURL(adapter).href;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      // Next names the adapter and the next.config by file URL, and its own modules by path.
      const loader = CONFIG_LOADER.test(context.parentURL ?? "");
      if (!loader || !specifier.startsWith("file:") || CONFIG_FILE.test(specifier)) {
        return nextResolve(specifier, context);
      }
      const { url } = nextResolve(specifier, context);
      if (url === ownAdapter) return { url, shortCircuit: true };
      return { url: `${ownAdapter}?adapter=${encodeURIComponent(url)}`, shortCircuit: true };
    },
  });
  process.env.FINITE_NEXT = JSON.stringify({
    loader,
    root: finite.root,
    distDir: finite.distDir,
    sheets: finite.sheets,
    configs: finite.configs,
  });

  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, resolve);
  });
  const { port } = server.address();

  // `next dev` rewrites next-env.d.ts and tsconfig.json for its distDir; the project's own
  // `next dev` would write them back, so keep them as they are.
  const kept = ["next-env.d.ts", "tsconfig.json"].map((name) => {
    const file = path.join(root, name);
    return { file, code: fs.existsSync(file) ? fs.readFileSync(file, "utf8") : undefined };
  });
  const { default: next } = await import(pathToFileURL(nextPath).href);
  const app = next({
    dev: true,
    [bundler]: true,
    dir: root,
    hostname: host,
    port,
    httpServer: server,
  });
  await app.prepare();
  // This version of Next loaded the adapter some other way than the hook above expects.
  if (!configured) {
    throw new Error(
      "Next.js didn't run Finite's adapter, which Finite needs to stamp the project's JSX. This version of Next may load adapterPath in a way Finite doesn't know yet.",
    );
  }
  for (const { file, code } of kept) {
    const now = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : undefined;
    if (now === code) continue;
    if (code === undefined) fs.rmSync(file);
    else fs.writeFileSync(file, code);
  }

  const handle = app.getRequestHandler();
  server.on("request", (req, res) => {
    finite
      .handle(req, res)
      .then((handled) => (handled ? undefined : handle(req, res)))
      .catch((error) => {
        console.error(error);
        if (!res.headersSent) res.statusCode = 500;
        res.end(String(error?.message ?? error));
      });
  });
  // Next adds its own `upgrade` listener for HMR to `httpServer` on the first request.

  const ignored = [
    `${path.sep}node_modules${path.sep}`,
    path.join(finite.root, ".finite", "runtime") + path.sep,
    path.join(finite.root, ".git") + path.sep,
  ];
  let timer;
  fs.watch(finite.root, { recursive: true }, (_event, name) => {
    if (!name) return;
    const file = path.join(finite.root, name);
    if (ignored.some((dir) => file.includes(dir))) return;
    // Any file in the brand folder, such as an image or a font, changes the brand board, and so
    // does renaming or deleting the folder itself, which the watcher reports as the folder alone.
    const brandDir = finite.brandDir();
    const brandPath = brandDir && path.join(finite.root, brandDir);
    const brand = brandPath && (file === brandPath || file.startsWith(brandPath + path.sep));
    if (!SOURCE.test(file) && !brand && !finite.isPage(file)) return;
    if (finite.mount && file === path.join(finite.root, finite.mount)) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      finite.sync();
      send({ type: "changed" });
    }, CHANGED_DEBOUNCE_MS);
  });

  const close = async () => {
    finite.close();
    await app.close().catch(() => {});
    process.exit(0);
  };
  process.on("SIGTERM", close);
  process.on("SIGINT", close);

  // Frames load under the basePath, as the project's own pages do.
  const origin = `http://${host.includes(":") ? `[${host}]` : host}:${port}`;
  send({ type: "ready", url: origin + finite.basePath });
} catch (error) {
  finite?.close();
  console.error(error?.stack ?? String(error));
  send({ type: "error", message: String(error?.message ?? error) });
  process.exit(1);
}

/**
 * The project's raw config for the dev phase, as `next dev` reads it to pick a bundler: whether
 * it has `webpack` and `turbopack`. It loads in a process of its own: Next caches a raw load as
 * the full config, which would then lack its defaults here, and a worker thread would share
 * Next's native bindings with this one.
 */
async function rawConfig(root) {
  const code = `
    const { createRequire } = require("node:module");
    const root = process.argv[1];
    const projectRequire = createRequire(root + "/package.json");
    const phase = "phase-development-server";
    (async () => {
      const { default: loadConfig } = projectRequire("next/dist/server/config");
      const { normalizeConfig } = projectRequire("next/dist/server/config-shared");
      const loaded = await loadConfig(phase, root, { rawConfig: true });
      // Calls a config function and awaits a promise, as Next does.
      const raw = await normalizeConfig(phase, loaded?.default ?? loaded);
      process.send({
        webpack: Boolean(raw?.webpack),
        turbopack: Boolean(raw?.turbopack ?? raw?.experimental?.turbo),
      }, () => process.exit(0));
    })();
  `;
  const child = spawn(process.execPath, ["-e", code, root], {
    cwd: root,
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
  return new Promise((resolve, reject) => {
    child.once("message", resolve);
    child.once("error", reject);
    child.once("exit", (code) =>
      reject(new Error(`Couldn't read the project's next.config (exit code ${code}).`)),
    );
  });
}
