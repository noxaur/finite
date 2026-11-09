import { type ChildProcess, spawn } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  type MenuItemConstructorOptions,
  session,
  shell,
} from "electron";
import { afterStop } from "./restarts.js";
import { loginShellPath } from "./shellPath.js";
import { keepUpToDate, offerMoveToApplications } from "./updates.js";

// `electron . --dev` loads the Next.js dev server; the Node server runs separately via `vp run dev`.
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

/**
 * Locates the server's entry and the built frontend. Packaged, the server is the bundle
 * `vp run @finite/server#build` makes (copied to resources/server by electron-builder.yml);
 * from the repo it's the TypeScript source, which Electron's Node runs by stripping types.
 */
function resources() {
  if (app.isPackaged) {
    return {
      serverEntry: path.join(process.resourcesPath, "server/dist/main.mjs"),
      staticDir: path.join(process.resourcesPath, "web"),
    };
  }
  const root = path.resolve(__dirname, "../../..");
  return {
    serverEntry: path.join(root, "apps/server/src/main.ts"),
    staticDir: path.join(root, "apps/web/out"),
  };
}

/** The login shell's PATH, so the server finds `claude`, `pnpm` and `node` as a terminal would. */
let shellPath: Promise<string> | undefined;

/** A stable port keeps the page's origin, and so its local storage, the same between launches. */
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
 * Starts the Node server as a sidecar. It serves both `/api` and the frontend
 * on one origin, so a new window reuses the first one.
 */
function serverOrigin(): Promise<string> {
  origin ??= startServer();
  return origin;
}

async function startServer(): Promise<string> {
  const [port, PATH] = await Promise.all([freePort(), (shellPath ??= loginShellPath())]);
  // A quit that began during the awaits has already let the app exit, so a server started now would outlive it.
  if (quitting) throw new Error("Finite is quitting");
  spawnServer(port, PATH);
  const url = `http://127.0.0.1:${port}`;
  await waitFor(`${url}/api/health`);
  return url;
}

/**
 * Runs the server on `port`. If it stops on its own, say it crashed or the
 * system killed it, it starts again on the same port: open pages reconnect
 * there and resume; every change is already saved to disk.
 */
function spawnServer(port: number, PATH: string) {
  const { serverEntry, staticDir } = resources();
  // Electron's own binary, run as plain Node: no second runtime to ship.
  const child = spawn(process.execPath, [serverEntry], {
    env: {
      ...process.env,
      PATH,
      ELECTRON_RUN_AS_NODE: "1",
      FINITE_PORT: String(port),
      FINITE_STATIC_DIR: staticDir,
      FINITE_DATA_DIR: path.join(app.getPath("userData"), "data"),
    },
    stdio: "inherit",
  });
  server = child;
  /** The server stopped, or never started: `spawn` fails with ENOENT or EAGAIN and emits `error`, never `exit`. */
  const stopped = (code: number | null, signal: NodeJS.Signals | null) => {
    server = undefined;
    if (quitting) return;
    const next = afterStop(stops, Date.now());
    stops = next.stops;
    if (next.restart) {
      console.error(`Finite's server stopped (code ${code}, signal ${signal}); restarting it`);
      spawnServer(port, PATH);
      return;
    }
    dialog.showErrorBox(
      "Finite's server keeps stopping",
      `It stopped ${stops.length} times in a minute (last exit: code ${code}, signal ${signal}). Your designs are saved. Finite will quit; try opening it again.`,
    );
    app.quit();
  };
  child.once("exit", stopped);
  child.on("error", (error) => {
    console.error("Finite's server hit an error:", error);
    // Without a pid the process never started, so no `exit` will follow.
    if (child.pid === undefined) stopped(null, null);
  });
}

/** Asks for a folder to connect as a design: its path, or `null` when the person cancels. */
ipcMain.handle("finite:pickFolder", async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const options = { properties: ["openDirectory" as const] };
  const result = win
    ? await dialog.showOpenDialog(win, options)
    : await dialog.showOpenDialog(options);
  return result.canceled ? null : (result.filePaths[0] ?? null);
});

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
