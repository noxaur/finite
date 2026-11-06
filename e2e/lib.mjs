// What the e2e, bench, headless and AX scripts share: finding Chrome, a free
// port, and starting a throwaway finite-server.
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CHROME_PATHS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];

/** FINITE_CHROME, or the first Chrome or Chromium in a usual place. */
export function findChrome() {
  return process.env.FINITE_CHROME ?? CHROME_PATHS.find((p) => fs.existsSync(p));
}

export const freePort = () =>
  new Promise((resolve) => {
    const probe = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

/** Resolves once `url`'s /api/health answers; throws if it doesn't within `timeout` ms. */
export async function waitHealthy(url, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${url}/api/health`)).ok) return;
    } catch {
      // Not listening yet.
    }
    await sleep(100);
  }
  throw new Error(`no Finite server answered at ${url}/api/health within ${timeout} ms`);
}

/**
 * Starts a finite-server on a free port (or `port`) and waits until it is
 * healthy, unless `wait` is false and the caller awaits `ready()` later.
 *
 *   bin        the server binary (default target/debug/finite-server)
 *   args       its arguments, like ["router"]
 *   env        extra environment, over RUST_LOG=warn and the process's own
 *   data       a throwaway FINITE_DATA_DIR, deleted by `stop` (default true)
 *   staticDir  FINITE_STATIC_DIR, the exported web app
 *   stdio      the child's stdio (default: inherit stdout and stderr)
 *   detached   keep running after this process exits, until killed by pid
 *
 * `stop()` kills it, waits for it to exit (SIGTERM makes a server save every
 * open design) and deletes the data folder.
 */
export async function startServer({
  bin = path.join(root, "target/debug/finite-server"),
  args = [],
  env = {},
  port,
  data = true,
  staticDir,
  stdio = ["ignore", "inherit", "inherit"],
  detached = false,
  wait = true,
} = {}) {
  port ??= await freePort();
  const dataDir = data ? fs.mkdtempSync(path.join(os.tmpdir(), "finite-data-")) : null;
  const child = spawn(bin, args, {
    env: {
      ...process.env,
      RUST_LOG: "warn",
      ...env,
      FINITE_PORT: String(port),
      ...(dataDir && { FINITE_DATA_DIR: dataDir }),
      ...(staticDir && { FINITE_STATIC_DIR: staticDir }),
    },
    stdio,
    detached,
  });
  if (detached) child.unref();
  const url = `http://127.0.0.1:${port}`;
  let health;
  const server = {
    url,
    port,
    child,
    dataDir,
    ready: () => (health ??= waitHealthy(url)),
    async stop() {
      const exited =
        child.exitCode === null ? new Promise((r) => child.once("exit", r)) : Promise.resolve();
      child.kill();
      await exited;
      if (dataDir)
        fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    },
  };
  if (wait) {
    try {
      await server.ready();
    } catch (error) {
      await server.stop();
      throw error;
    }
  }
  return server;
}
