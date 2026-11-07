// One Next.js design's dev server, run as a child of the Finite server (see index.ts), with the
// same IPC as vite-host.mjs: { type: "ready", url } | { type: "error", message } |
// { type: "changed" }.
// It loads the project's own `next` and runs `next dev` (Turbopack) as a custom server. Next's
// config gets Finite's adapter (stamping loader, distDir under .finite/runtime), and a node:http
// server in front answers Finite's own URLs and adds the bridge to every page.
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const CHANGED_DEBOUNCE_MS = 300;
const SOURCE = /\.(tsx?|jsx?|mts|mjs|json|css)$/;

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
  const { finiteNext } = await import(pathToFileURL(plugin).href);
  finite = finiteNext({ root, allowedHosts });
  finite.prepare();

  // Next calls the adapter's `modifyConfig` on the config it loads.
  process.env.NEXT_ADAPTER_PATH = adapter;
  process.env.FINITE_NEXT = JSON.stringify({
    loader,
    root: finite.root,
    distDir: finite.distDir,
    sheets: finite.sheets,
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
    turbopack: true,
    dir: root,
    hostname: host,
    port,
    httpServer: server,
  });
  await app.prepare();
  // A project's own `adapterPath` wins over the variable, and then Finite's never ran.
  if (!globalThis.FINITE_NEXT_ADAPTED) {
    throw new Error(
      "The project's next.config sets adapterPath, and Finite needs that hook to preview it. Finite doesn't support projects with their own Next.js adapter yet.",
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
    if (!SOURCE.test(file) && !brand) return;
    if (file === path.join(finite.root, finite.mount)) return;
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

  send({ type: "ready", url: `http://${host.includes(":") ? `[${host}]` : host}:${port}` });
} catch (error) {
  finite?.close();
  console.error(error?.stack ?? String(error));
  send({ type: "error", message: String(error?.message ?? error) });
  process.exit(1);
}
