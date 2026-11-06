import { type ChildProcess, spawn } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  type MenuItemConstructorOptions,
  session,
  shell,
} from "electron";
import { afterStop } from "./restarts.js";
import { keepUpToDate, offerMoveToApplications } from "./updates.js";

// `electron . --dev` loads the Next.js dev server; the Rust server runs separately via `vp run dev`.
const isDev = process.argv.includes("--dev");
const DEV_URL = "http://localhost:5310";

let server: ChildProcess | undefined;
/** The running server's origin. Started once: on macOS the app outlives its windows. */
let origin: Promise<string> | undefined;
/** How long quitting waits for the server to save and exit. */
const SHUTDOWN_MS = 5_000;
/** Set once quitting starts, so the server's exit isn't taken for a crash. */
let quitting = false;
/** When the server last stopped on its own; see `afterStop`. */
let stops: number[] = [];

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

/**
 * Starts the Rust server as a sidecar. It serves both `/api` and the frontend
 * on one origin. A second server would find the data folder locked and exit,
 * so a new window reuses the first one.
 */
function serverOrigin(): Promise<string> {
  origin ??= startServer();
  return origin;
}

async function startServer(): Promise<string> {
  const port = await freePort();
  spawnServer(port);
  const url = `http://127.0.0.1:${port}`;
  await waitFor(`${url}/api/health`);
  return url;
}

/**
 * Runs the server on `port`. If it stops on its own, say it crashed or the
 * system killed it, it starts again on the same port: open pages reconnect
 * there and resume, and the journal brings back the latest edits.
 */
function spawnServer(port: number) {
  const { serverBin, staticDir } = resources();
  server = spawn(serverBin, [], {
    env: {
      ...process.env,
      FINITE_PORT: String(port),
      FINITE_STATIC_DIR: staticDir,
      FINITE_DATA_DIR: path.join(app.getPath("userData"), "data"),
    },
    stdio: "inherit",
  });
  server.once("exit", (code, signal) => {
    server = undefined;
    if (quitting) return;
    const next = afterStop(stops, Date.now());
    stops = next.stops;
    if (next.restart) {
      console.error(`finite-server stopped (code ${code}, signal ${signal}); restarting it`);
      spawnServer(port);
      return;
    }
    dialog.showErrorBox(
      "Finite's server keeps stopping",
      `It stopped ${stops.length} times in a minute (last exit: code ${code}, signal ${signal}). Your designs are saved. Finite will quit; try opening it again.`,
    );
    app.quit();
  });
}

/** What the menu asks the page to do; mirror changes in apps/web/src/global.d.ts and preload.ts. */
type FiniteCommand = "closeTab" | "nextTab" | "previousTab";

/** Sends a menu command to the focused window's page, which handles the tabs. */
function sendCommand(command: FiniteCommand) {
  BrowserWindow.getFocusedWindow()?.webContents.send("finite:command", command);
}

/** Whether `win` shows a design, which has a tab to close, rather than the designs list. */
function showsDesign(win: BrowserWindow): boolean {
  try {
    return new URL(win.webContents.getURL()).pathname.startsWith("/design");
  } catch {
    return false;
  }
}

/**
 * The app menu: the standard one, but ⌘W closes the design's tab (the
 * window, on the designs list), ⇧⌘W closes the window, and ⇧⌘[ and ⇧⌘]
 * step through the tabs, as in a browser.
 */
function setMenu() {
  const mac = process.platform === "darwin";
  const template: MenuItemConstructorOptions[] = [
    ...(mac ? [{ role: "appMenu" } as const] : []),
    {
      label: "File",
      submenu: [
        {
          label: "Close Tab",
          accelerator: "CmdOrCtrl+W",
          click: (_item, window) => {
            if (!(window instanceof BrowserWindow)) return;
            if (showsDesign(window)) sendCommand("closeTab");
            else window.close();
          },
        },
        { label: "Close Window", accelerator: "CmdOrCtrl+Shift+W", role: "close" },
        ...(mac ? [] : [{ type: "separator" } as const, { role: "quit" } as const]),
      ],
    },
    { role: "editMenu" },
    { role: "viewMenu" },
    {
      label: "Window",
      submenu: [
        {
          label: "Show Previous Tab",
          accelerator: "CmdOrCtrl+Shift+[",
          click: () => sendCommand("previousTab"),
        },
        {
          label: "Show Next Tab",
          accelerator: "CmdOrCtrl+Shift+]",
          click: () => sendCommand("nextTab"),
        },
        { type: "separator" },
        { role: "minimize" },
        { role: "zoom" },
        ...(mac ? [{ type: "separator" } as const, { role: "front" } as const] : []),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function createWindow() {
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    show: false,
    // On macOS the page's tab bar is the title bar: the window buttons sit
    // inside it, centered in its 42px (TabBar's MAC_BUTTONS keeps them clear).
    ...(process.platform === "darwin"
      ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 15, y: 14 } }
      : {}),
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
    await win.loadURL(await serverOrigin());
  }
}

app
  .whenReady()
  .then(async () => {
    await offerMoveToApplications();
    // Older builds served the page without Cache-Control, so
    // Chromium may hold a page that names the last build's chunks. The
    // server is local, so starting from an empty HTTP cache costs little.
    await session.defaultSession.clearCache();
    keepUpToDate();
    setMenu();
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

// The server saves pending edits when it gets SIGTERM, so let it finish
// before the app exits.
app.on("before-quit", (event) => {
  quitting = true;
  const running = server;
  if (!running) return;
  event.preventDefault();
  const force = setTimeout(() => running.kill("SIGKILL"), SHUTDOWN_MS);
  running.once("exit", () => {
    clearTimeout(force);
    app.quit();
  });
  running.kill("SIGTERM");
});
