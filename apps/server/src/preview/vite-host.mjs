// One design's dev server, run as a child of the Finite server (see index.ts). It loads the
// project's own Vite and config, adds @finite/vite-plugin, and reports over IPC:
// { type: "ready", url } | { type: "error", message } | { type: "changed" } (source files changed).
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const CHANGED_DEBOUNCE_MS = 300;
const SOURCE = /\.(tsx?|jsx?|mts|mjs|json)$/;

const { root, host, plugin, allowedHosts } = JSON.parse(process.env.FINITE_PREVIEW ?? "{}");
const send = (message) => process.send?.(message);

// The Finite server went away: don't outlive it.
process.on("disconnect", () => process.exit(0));

try {
  const projectRequire = createRequire(path.join(root, "package.json"));
  let vitePath;
  try {
    vitePath = projectRequire.resolve("vite");
  } catch {
    throw new Error(
      `Vite isn't installed in ${root}. Run your package manager's install there, then try again.`,
    );
  }
  const vite = await import(pathToFileURL(vitePath).href);
  const { finite } = await import(pathToFileURL(plugin).href);

  const server = await vite.createServer({
    root,
    // `undefined` lets Vite find the project's own vite.config.*; our options merge over it.
    configFile: undefined,
    clearScreen: false,
    // The plugin limits CORS and the bridge to the Finite shell's hosts.
    plugins: [finite({ root, allowedHosts })],
    server: { port: 0, host, strictPort: false, hmr: true },
  });
  await server.listen();

  let timer;
  server.watcher.on("all", (_event, file) => {
    if (!SOURCE.test(file) || file.includes(`${path.sep}node_modules${path.sep}`)) return;
    clearTimeout(timer);
    timer = setTimeout(() => send({ type: "changed" }), CHANGED_DEBOUNCE_MS);
  });

  const close = async () => {
    await server.close().catch(() => {});
    process.exit(0);
  };
  process.on("SIGTERM", close);
  process.on("SIGINT", close);

  const { port } = server.httpServer.address();
  send({ type: "ready", url: `http://${host.includes(":") ? `[${host}]` : host}:${port}` });
} catch (error) {
  console.error(error?.stack ?? String(error));
  send({ type: "error", message: String(error?.message ?? error) });
  process.exit(1);
}
