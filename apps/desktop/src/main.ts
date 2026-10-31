import { type ChildProcess, spawn } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import { app, BrowserWindow, shell } from "electron";

// `electron . --dev` loads the Next.js dev server; the Rust server runs separately via `vp run dev`.
const isDev = process.argv.includes("--dev");
const DEV_URL = "http://localhost:5310";

let server: ChildProcess | undefined;

/** Locates the Rust binary and built frontend: app resources when packaged, the repo otherwise. */
function resources() {
  const exe = process.platform === "win32" ? "finite-server.exe" : "finite-server";
  if (app.isPackaged) {
    return {
      serverBin: path.join(process.resourcesPath, exe),
      staticDir: path.join(process.resourcesPath, "web"),
    };
  }
  const root = path.resolve(__dirname, "../../..");
  return {
    serverBin: path.join(root, "target/release", exe),
    staticDir: path.join(root, "apps/web/out"),
  };
}

/** Agents connect to `http://127.0.0.1:<port>/mcp`, so keep the port stable when it's free. */
const PREFERRED_PORT = 4100;

function freePort(port = PREFERRED_PORT): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", (error: NodeJS.ErrnoException) => {
      if (port !== 0 && error.code === "EADDRINUSE") resolve(freePort(0));
      else reject(error);
    });
    probe.listen(port, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

async function waitFor(url: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // Not up yet.
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

/** Starts the Rust server as a sidecar. It serves both `/api` and the frontend on one origin. */
async function startServer(): Promise<string> {
  const { serverBin, staticDir } = resources();
  const port = await freePort();
  server = spawn(serverBin, [], {
    env: {
      ...process.env,
      FINITE_PORT: String(port),
      FINITE_STATIC_DIR: staticDir,
      FINITE_DATA_DIR: path.join(app.getPath("userData"), "data"),
    },
    stdio: "inherit",
  });
  server.once("exit", (code) => {
    server = undefined;
    if (code !== 0 && code !== null) app.quit();
  });
  const origin = `http://127.0.0.1:${port}`;
  await waitFor(`${origin}/api/health`);
  return origin;
}

async function createWindow() {
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.once("ready-to-show", () => win.show());

  // Open external links in the user's browser instead of a new Electron window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  if (isDev) {
    await waitFor(DEV_URL);
    await win.loadURL(DEV_URL);
    win.webContents.openDevTools({ mode: "detach" });
  } else {
    await win.loadURL(await startServer());
  }
}

app
  .whenReady()
  .then(async () => {
    await createWindow();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) void createWindow();
    });
  })
  .catch((error: unknown) => {
    console.error(error);
    app.quit();
  });

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  server?.kill();
});
