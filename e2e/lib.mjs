// What e2e/run.mjs and the finite-headless skill share: free ports, the Node
// server, the web app, a socket client for /api/ws, fixtures and Chrome.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The user's own Finite (desktop app or `vp run dev`) may hold these. */
const RESERVED = new Set([4100, 5310]);

/** The first free port from `from` up, skipping the ports the user's own Finite uses. */
export async function freePort(from = 4300) {
  for (let port = from; port < from + 500; port++) {
    if (RESERVED.has(port)) continue;
    const free = await new Promise((resolve) => {
      const probe = net.createServer();
      probe.once("error", () => resolve(false));
      probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
    });
    if (free) return port;
  }
  throw new Error(`no free port in ${from}–${from + 500}`);
}

/** Polls `fn` until it returns something truthy; throws `what` after `timeout` ms. */
export async function until(fn, what, timeout = 30_000, every = 200) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await sleep(every);
  }
  throw new Error(
    `timed out after ${timeout} ms waiting for ${what}${last ? ` (${last.message})` : ""}`,
  );
}

/**
 * Starts `node apps/server/src/main.ts` as a child. `staticDir` serves a built web app from the
 * same origin. The child's output goes to `log` (a path), or is dropped.
 */
export async function startServer({ port, dataDir, staticDir, log, detached = false }) {
  port ??= await freePort();
  fs.mkdirSync(dataDir, { recursive: true });
  const out = log ? fs.openSync(log, "a") : "ignore";
  const child = spawn(process.execPath, [path.join(root, "apps/server/src/main.ts")], {
    cwd: root,
    detached,
    stdio: ["ignore", out, out],
    env: {
      ...process.env,
      FINITE_PORT: String(port),
      FINITE_DATA_DIR: dataDir,
      ...(staticDir ? { FINITE_STATIC_DIR: staticDir } : {}),
    },
  });
  const url = `http://127.0.0.1:${port}`;
  let exited = null;
  child.once("exit", (code, signal) => (exited = signal ?? code));
  await until(async () => {
    if (exited !== null)
      throw new Error(`the server exited (${exited}); see ${log ?? "its output"}`);
    return (await fetch(`${url}/api/health`)).ok;
  }, `the server on ${url}`);
  return { url, port, pid: child.pid, child };
}

/** `next build` of apps/web into apps/web/out, the static export the server can serve. */
export function buildWeb() {
  const result = spawnSync("vp", ["run", "web#build"], { cwd: root, stdio: "inherit" });
  if (result.status !== 0) throw new Error("building the web app failed");
  return path.join(root, "apps/web/out");
}

/**
 * `next dev` for apps/web, proxying /api to `apiUrl`. Only one `next dev` can run per checkout
 * (it holds apps/web/.next/dev/lock), so prefer the static build when several runs share one.
 */
export async function startNextDev({ port, apiUrl, log, detached = false }) {
  port ??= await freePort(5400);
  const out = log ? fs.openSync(log, "a") : "ignore";
  const next = path.join(root, "apps/web/node_modules/.bin/next");
  const child = spawn(next, ["dev", "--port", String(port)], {
    cwd: path.join(root, "apps/web"),
    detached,
    stdio: ["ignore", out, out],
    env: { ...process.env, FINITE_API_URL: apiUrl },
  });
  const url = `http://127.0.0.1:${port}`;
  await until(async () => (await fetch(url)).status < 500, `next dev on ${url}`, 120_000, 500);
  return { url, port, pid: child.pid, child };
}

/** Kills a process and its group (children started with `detached`), if it's alive. */
export function kill(pid, signal = "SIGTERM") {
  if (!pid) return;
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, signal);
    } catch {}
  }
}

/**
 * A client for `/api/ws` (packages/protocol/src/wire.ts). `request` resolves with the reply's
 * value or rejects with its reason; every server event goes to the `on` listeners.
 */
export async function connect(url, user = { id: "e2e", name: "E2E" }) {
  const ws = new WebSocket(`${url.replace(/^http/, "ws")}/api/ws`);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", () => reject(new Error(`can't open ${url}/api/ws`)), {
      once: true,
    });
  });
  let rid = 0;
  const pending = new Map();
  const listeners = new Set();
  const events = [];
  ws.addEventListener("message", (message) => {
    const data = JSON.parse(String(message.data));
    if (data.type === "reply") {
      const p = pending.get(data.rid);
      pending.delete(data.rid);
      if (data.ok) p?.resolve(data.value);
      else p?.reject(Object.assign(new Error(data.reason), { code: data.code }));
      return;
    }
    events.push(data);
    for (const fn of listeners) fn(data);
  });
  const client = {
    events,
    request(type, params = {}) {
      const id = String(++rid);
      ws.send(JSON.stringify({ type, rid: id, ...params }));
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    on(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    /** The first event, already received or still to come, that `test` accepts. */
    waitFor(test, what, timeout = 30_000) {
      const seen = events.find(test);
      if (seen) return Promise.resolve(seen);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          off();
          reject(new Error(`timed out after ${timeout} ms waiting for ${what}`));
        }, timeout);
        const off = client.on((event) => {
          if (!test(event)) return;
          clearTimeout(timer);
          off();
          resolve(event);
        });
      });
    },
    close: () => ws.close(),
  };
  await client.request("hello", { user });
  return client;
}

/**
 * Copies `apps/server/fixtures/<name>` (rr-spa, rr-framework, tanstack) to `dest` and installs
 * its dependencies there, outside this workspace, like a person's own project.
 */
export function copyFixture(name, dest) {
  const from = path.join(root, "apps/server/fixtures", name);
  if (!fs.existsSync(from)) {
    const names = fs.readdirSync(path.join(root, "apps/server/fixtures")).join(", ");
    throw new Error(`no fixture ${name}; there are ${names}`);
  }
  dest ??= fs.mkdtempSync(path.join(os.tmpdir(), `finite-${name}-`));
  fs.cpSync(from, dest, {
    recursive: true,
    filter: (source) => !source.split(path.sep).includes("node_modules"),
  });
  const result = spawnSync(
    "pnpm",
    [
      "install",
      "--prefer-offline",
      "--ignore-workspace",
      "--no-lockfile",
      "--reporter=silent",
      "--config.strict-dep-builds=false",
    ],
    { cwd: dest, stdio: "inherit", timeout: 300_000 },
  );
  if (result.status !== 0) throw new Error(`pnpm install failed in ${dest}`);
  return fs.realpathSync(dest);
}

const CHROME_PATHS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];

/** FINITE_CHROME, or the first Chrome or Chromium in a usual place. */
export function findChrome() {
  const found = process.env.FINITE_CHROME ?? CHROME_PATHS.find((p) => fs.existsSync(p));
  if (!found) throw new Error("no Chrome found; set FINITE_CHROME to its executable");
  return found;
}

/** puppeteer-core, a dependency of apps/server (the root has none of its own). */
export async function puppeteer() {
  const require = createRequire(path.join(root, "apps/server/package.json"));
  return (await import(pathToFileURL(require.resolve("puppeteer-core")).href)).default;
}

/** Headless system Chrome through puppeteer-core. */
export async function launchChrome({ port, userDataDir } = {}) {
  const pptr = await puppeteer();
  return pptr.launch({
    executablePath: findChrome(),
    headless: true,
    defaultViewport: { width: 1440, height: 900 },
    ...(userDataDir ? { userDataDir } : {}),
    args: [
      "--no-first-run",
      "--no-default-browser-check",
      "--hide-scrollbars",
      ...(port ? [`--remote-debugging-port=${port}`] : []),
      ...(process.env.CI ? ["--no-sandbox"] : []),
    ],
  });
}
