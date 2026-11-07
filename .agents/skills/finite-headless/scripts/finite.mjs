#!/usr/bin/env node
// Drives a headless Finite from the shell, one command per call. `start` leaves the Node server,
// the web app and Chrome running in the background; later commands reconnect to them. Run with
// no arguments for the commands.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const lib = await import(path.resolve(here, "../../../../e2e/lib.mjs"));
const { root, freePort, until, kill } = lib;

const HELP = `node .agents/skills/finite-headless/scripts/finite.mjs <command> [--session <name>]

Session
  start [--web static|dev] [--no-build] [--port <n>]   server + web app + Chrome (static: one origin)
  status                                                 URLs, pids, data dir, log paths
  stop [--keep]                                          stops everything; --keep keeps the data dir
  logs [server|web] [-n <lines>]

Server (/api/ws, packages/protocol/src/wire.ts)
  call <type> [json|@file]                 one request; prints the reply value
  watch <designId> [--for <s>] [--until <event type>]   subscribe and print events as JSON lines
  send <designId> <text> [--thread <id>] [--canvas <id>] [--for <s>]   thread.send, then print
                                           the thread's events until its result or error
  fixture <rr-spa|rr-framework|tanstack|stylex> [dest]   temp copy, installed; prints the path

Page (puppeteer selectors: css, ::-p-text(Create), ::-p-aria(Send))
  open [path]                              navigate (default /); /design/?id=<designId>
  eval <js> [--frame <frameId>]            prints the JSON result; --frame runs inside a frame
  click <selector> [--frame <frameId>] | click <x> <y>
  type <text>  |  key <key, e.g. Enter, Meta+z>
  wait <selector> [--frame <frameId>] [--for <s>]
  shot [file] [--selector <css>]           PNG (default in the session dir); prints the path
  console                                  page errors and console output since the last call`;

// `--name value` flags anywhere; the rest are positional. `--keep` and `--no-build` take no value.
const BOOLEAN = new Set(["keep", "no-build"]);
const args = [];
const flags = {};
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg.startsWith("--") && arg.length > 2) {
    const name = arg.slice(2);
    flags[name] = BOOLEAN.has(name) ? true : process.argv[++i];
  } else if (arg === "-n") {
    flags.n = process.argv[++i];
  } else {
    args.push(arg);
  }
}
const flag = (name, fallback) => flags[name] ?? fallback;

const sessionName = flag("session", "default");
const dir = path.join(os.tmpdir(), "finite-headless", sessionName);
const sessionFile = path.join(dir, "session.json");
const readSession = () => {
  try {
    return JSON.parse(fs.readFileSync(sessionFile, "utf8"));
  } catch {
    throw new Error(`no session ${sessionName}; run start first`);
  }
};
const print = (value) =>
  console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));

const commands = {
  async start() {
    if (fs.existsSync(sessionFile)) {
      throw new Error(`session ${sessionName} is running (${dir}); stop it or pass --session`);
    }
    const web = flag("web", "static");
    const build = !flag("no-build", false);
    const port = Number(flag("port", 0)) || undefined;
    fs.mkdirSync(dir, { recursive: true });
    const session = { dir, dataDir: path.join(dir, "data"), logs: {} };
    const save = () => fs.writeFileSync(sessionFile, JSON.stringify(session, null, 2));
    try {
      let staticDir;
      if (web === "static") {
        staticDir = path.join(root, "apps/web/out");
        if (build || !fs.existsSync(staticDir)) lib.buildWeb();
      }
      session.logs.server = path.join(dir, "server.log");
      const server = await lib.startServer({
        port,
        dataDir: session.dataDir,
        staticDir,
        log: session.logs.server,
        detached: true,
      });
      server.child.unref();
      Object.assign(session, { server: server.url, serverPid: server.pid, web: server.url });
      save();
      if (web === "dev") {
        session.logs.web = path.join(dir, "web.log");
        const next = await lib.startNextDev({
          apiUrl: server.url,
          log: session.logs.web,
          detached: true,
        });
        next.child.unref();
        Object.assign(session, { web: next.url, webPid: next.pid });
        save();
      }
      const chromePort = await freePort(9300);
      const chrome = spawn(
        lib.findChrome(),
        [
          "--headless=new",
          `--remote-debugging-port=${chromePort}`,
          `--user-data-dir=${path.join(dir, "chrome")}`,
          "--no-first-run",
          "--no-default-browser-check",
          "--hide-scrollbars",
          "--window-size=1440,900",
          ...(process.env.CI ? ["--no-sandbox"] : []),
          "about:blank",
        ],
        { detached: true, stdio: "ignore" },
      );
      chrome.unref();
      Object.assign(session, { chrome: `http://127.0.0.1:${chromePort}`, chromePid: chrome.pid });
      save();
      await until(
        async () => (await fetch(`${session.chrome}/json/version`)).ok,
        "Chrome's debugging port",
      );
      await withPage(async (page) => page.goto(session.web, { waitUntil: "networkidle2" }));
      print({ session: sessionName, web: session.web, server: session.server, dir });
    } catch (error) {
      await commands.stop();
      throw error;
    }
  },

  async status() {
    print(readSession());
  },

  async stop() {
    const keep = flag("keep", false);
    let session;
    try {
      session = readSession();
    } catch {
      return;
    }
    for (const pid of [session.chromePid, session.webPid, session.serverPid]) kill(pid);
    await new Promise((r) => setTimeout(r, 500));
    fs.rmSync(sessionFile, { force: true });
    if (!keep) fs.rmSync(dir, { recursive: true, force: true });
    print(keep ? `stopped; kept ${dir}` : "stopped");
  },

  async logs() {
    const which = args[0] ?? "server";
    const lines = Number(flag("n", 60));
    const file = readSession().logs[which];
    if (!file) throw new Error(`no ${which} log in this session`);
    print(fs.readFileSync(file, "utf8").split("\n").slice(-lines).join("\n"));
  },

  async call() {
    const [type, raw = "{}"] = args;
    if (!type) throw new Error("call needs a request type, e.g. designs.list");
    const params = JSON.parse(raw.startsWith("@") ? fs.readFileSync(raw.slice(1), "utf8") : raw);
    const client = await lib.connect(readSession().server);
    try {
      print(await client.request(type, params));
    } finally {
      client.close();
    }
  },

  async watch() {
    const [designId] = args;
    if (!designId) throw new Error("watch needs a design id");
    const seconds = Number(flag("for", 30));
    const stopAt = flag("until", undefined);
    const client = await lib.connect(readSession().server);
    const state = await client.request("subscribe", { designId });
    print({ type: "design.state", ...summarize(state) });
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, seconds * 1000);
      client.on((event) => {
        console.log(JSON.stringify(event));
        if (stopAt && event.type === stopAt) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    client.close();
  },

  async send() {
    const [designId, text] = args;
    if (!designId || !text) throw new Error('send needs a design id and a message: send <id> "…"');
    const threadId = flag("thread", undefined);
    const canvasId = flag("canvas", undefined);
    const seconds = Number(flag("for", 300));
    const client = await lib.connect(readSession().server);
    await client.request("subscribe", { designId });
    const settings = await client.request("settings.get");
    const reply = await client.request("thread.send", {
      designId,
      ...(threadId ? { threadId } : { new: canvasId ? { canvasId } : {} }),
      text,
      attachments: [],
      model: settings.model,
      effort: settings.effort,
      fast: settings.fast,
      mode: settings.sendMode,
    });
    print({ threadId: reply.threadId });
    let delta = false;
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, seconds * 1000);
      const show = (event) => {
        if (event.type !== "thread.event" || event.threadId !== reply.threadId) return;
        const e = event.event;
        if (e.type === "text.delta") {
          process.stdout.write(e.text);
          delta = true;
          return;
        }
        if (delta) process.stdout.write("\n");
        delta = false;
        if (e.type === "text") return;
        console.log(JSON.stringify(e));
        if (e.type === "result" || e.type === "error") {
          clearTimeout(timer);
          resolve();
        }
      };
      for (const event of client.events) show(event);
      client.on(show);
    });
    client.close();
  },

  async fixture() {
    const [name, dest] = args;
    if (!name) throw new Error("fixture needs a name: rr-spa, rr-framework, tanstack or stylex");
    if (dest) fs.mkdirSync(dest, { recursive: true });
    print(lib.copyFixture(name, dest));
  },

  async open() {
    const target = new URL(args[0] ?? "/", readSession().web).href;
    await withPage(async (page) => {
      await page.goto(target, { waitUntil: "networkidle2" });
      print(page.url());
    });
  },

  async eval() {
    const [js] = args;
    const frame = flag("frame", undefined);
    await withPage(async (page) => {
      const where = frame ? await frameOf(page, frame) : page;
      print(await where.evaluate(`(async () => (${js}))()`));
    });
  },

  async click() {
    const frame = flag("frame", undefined);
    await withPage(async (page) => {
      if (args.length === 2 && args.every((a) => /^-?\d+(\.\d+)?$/.test(a))) {
        await page.mouse.click(Number(args[0]), Number(args[1]));
      } else {
        const where = frame ? await frameOf(page, frame) : page;
        await (await where.waitForSelector(args[0], { timeout: 10_000 })).click();
      }
      print("clicked");
    });
  },

  async type() {
    await withPage((page) => page.keyboard.type(args[0] ?? ""));
  },

  async key() {
    const keys = (args[0] ?? "").split("+");
    await withPage(async (page) => {
      const last = keys.pop();
      for (const k of keys) await page.keyboard.down(k);
      await page.keyboard.press(last);
      for (const k of keys.reverse()) await page.keyboard.up(k);
    });
  },

  async wait() {
    const frame = flag("frame", undefined);
    const seconds = Number(flag("for", 30));
    await withPage(async (page) => {
      const where = frame ? await frameOf(page, frame) : page;
      await where.waitForSelector(args[0], { timeout: seconds * 1000 });
      print("found");
    });
  },

  async shot() {
    const selector = flag("selector", undefined);
    const file = path.resolve(args[0] ?? path.join(readSession().dir, `shot-${Date.now()}.png`));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    await withPage(async (page) => {
      const target = selector ? await page.waitForSelector(selector) : page;
      await target.screenshot({ path: file });
    });
    print(file);
  },

  async console() {
    const file = path.join(readSession().dir, "console.log");
    const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    fs.writeFileSync(file, "");
    print(text || "(nothing logged)");
  },
};

/** Runs `fn` on the session's one page, then disconnects and leaves Chrome running. */
async function withPage(fn) {
  const session = readSession();
  const pptr = await lib.puppeteer();
  const browser = await pptr.connect({
    browserURL: session.chrome,
    defaultViewport: { width: 1440, height: 900 },
  });
  try {
    const [page = await browser.newPage()] = await browser.pages();
    const log = path.join(session.dir, "console.log");
    const append = (line) => fs.appendFileSync(log, `${line}\n`);
    page.on("console", (m) => append(`[${m.type()}] ${m.text()}`));
    page.on("pageerror", (e) => append(`[pageerror] ${e.message}`));
    page.on("requestfailed", (r) => append(`[requestfailed] ${r.url()} ${r.failure()?.errorText}`));
    return await fn(page);
  } finally {
    await browser.disconnect();
  }
}

/** The frame inside `iframe[data-frame-id=<frameId>]`. */
async function frameOf(page, frameId) {
  const handle = await page.waitForSelector(`iframe[data-frame-id="${frameId}"]`, {
    timeout: 10_000,
  });
  const frame = await handle.contentFrame();
  if (!frame) throw new Error(`frame ${frameId} has no document yet`);
  return frame;
}

function summarize(state) {
  return {
    design: state.design,
    preview: state.preview,
    routes: state.routes,
    canvases: state.canvases.map((c) => ({
      id: c.id,
      kind: c.kind,
      name: c.name,
      frames: c.frames.map((f) => ({ id: f.id, name: f.name, source: f.source })),
    })),
    threads: state.threads.map((t) => ({ id: t.id, title: t.title, running: t.running })),
  };
}

const command = args.shift();
if (!command || !(command in commands)) {
  console.log(HELP);
  process.exit(command ? 1 : 0);
}
try {
  await commands[command]();
  process.exit(0);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
