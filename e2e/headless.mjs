// Drive a live Finite from the shell, one command at a time, for agents that
// test the app headless.
//
//   node e2e/headless.mjs start            build, then start a server and headless Chrome
//   node e2e/headless.mjs call designs '{"create":"Test"}'
//   node e2e/headless.mjs design <designId>
//   node e2e/headless.mjs screenshot
//   node e2e/headless.mjs stop
//
// `start` leaves a background process running that holds the server, the
// browser page and the MCP sessions, so each later command picks up where the
// last one left off. Run with no command, or `help`, for every command.
//
// Each checkout gets its own session, kept in the temp folder, so agents in
// different worktrees don't share one. `--session <name>` (or
// FINITE_HEADLESS_SESSION) starts another next to it.
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { launch } from "./cdp.mjs";
import { root, sleep, startServer, waitHealthy } from "./lib.mjs";
import { connect } from "./mcp.mjs";

const self = fileURLToPath(import.meta.url);
const bin = path.join(root, "target/debug/finite-server");
const staticDir = path.join(root, "apps/web/out");

const HELP = `Drive a live Finite headless: a server, headless Chrome and MCP agents.

Usage: node e2e/headless.mjs <command> [args] [--session <name>]

Session
  start [--no-build] [--width 1440] [--height 900] [--idle 30]
                              Build the server, finite.wasm and the web app,
                              then start them with an empty data folder.
                              --no-build reuses the last builds. The session
                              stops itself after --idle minutes without a command.
  start --url <web> [--server <api>]
                              Attach to a Finite that's already running, such
                              as \`vp run dev\` (--url http://localhost:5310
                              --server http://127.0.0.1:4100).
  status                      Where the session is and what it's doing.
  state                       Its control port and token as JSON, for other clients.
  stop                        Stop the server and Chrome, and delete the data.
  logs [-n 50]                The server's last log lines.

Agents (MCP)
  tools [name]                List the MCP tools, or show one's description and input.
  call <tool> [json|@file|-] [--agent <name>]
                              Call a tool and print its text. Images, like
                              render's, are saved as PNG files. Each
                              --agent name is its own MCP session with its own
                              undo history (default "Agent").
  api <METHOD> <path> [json]  Call the web API, like: api GET /api/designs

Browser
  open [path|url]             Load a page: / is the design list. No argument reloads.
  design <designId>           Open a design and wait for its artboards to render.
  screenshot [file] [--selector <css>]
                              Save a PNG of the page, or of one element, and print its path.
  snapshot [--selector <css>] The page's accessibility tree: roles, names and values.
  text [--selector <css>]     The page's visible text.
  query <css>                 Every matching element, with its text and position.
  eval <js>                   Evaluate JavaScript in the page and print the result.
  wait <js> [--timeout 5000]  Wait until the expression is truthy.
  click <css> | click <x> <y> [--shift] [--double]
                              Click an element's center, or a point. --shift
                              holds Shift, as for adding to a comment's elements.
  hover <css> | hover <x> <y> Move the mouse there.
  wheel <x> <y> <dx> <dy> [--ctrl]
                              Scroll the wheel at a point, in steps, like a
                              trackpad gesture. --ctrl holds Control, to zoom.
  drag <css|x y> --by=<dx>,<dy> [--to <css>] [--steps 10] [--shift]
                              Press on an element's center (or a point), move
                              by dx,dy pixels or onto another element's center,
                              and release, as a person drags.
  type <text>                 Type into the focused element.
  upload <css> <file>         Pick a file in a file input, as the OS file
                              picker would. Hidden inputs work too.
  key <key>                   Press a key: Enter, Escape, c, Shift+1, Meta+z.
  viewport <width> <height>   Resize the page.
  console [--all]             Console messages and errors since the last call.

CSS selectors reach inside shadow roots, where artboards render, so
\`query button\` lists a design's buttons along with the app's. To look
inside one artboard, use \`[data-artboard="<id>"] >>> button\`. When a
selector matches more than one element, click, hover, screenshot, text and
snapshot take the first, or the one --nth <i> picks, counting from 0 as query
lists them. In eval and wait, $deep(css) and $$deep(css) find elements the
same way. A sandboxed artboard (one with a <script>) runs in an iframe that
selectors can't reach: click <x> <y> there.

From Python, e2e/finite_headless.py runs the same commands and returns data:
eval's value, query's matches, screenshot's path.`;

// ---------------------------------------------------------------------------
// The command line.

const { values: flags, positionals } = parseFlags({
  allowPositionals: true,
  allowNegative: true,
  options: {
    session: { type: "string" },
    build: { type: "boolean", default: true },
    url: { type: "string" },
    server: { type: "string" },
    width: { type: "string" },
    height: { type: "string" },
    idle: { type: "string" },
    agent: { type: "string" },
    selector: { type: "string" },
    timeout: { type: "string" },
    all: { type: "boolean" },
    lines: { type: "string", short: "n" },
    nth: { type: "string" },
    shift: { type: "boolean" },
    double: { type: "boolean" },
    ctrl: { type: "boolean" },
    by: { type: "string" },
    to: { type: "string" },
    steps: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});
const [command, ...args] = positionals;

/** parseArgs, with a short message instead of a stack for a flag it doesn't know. */
function parseFlags(config) {
  try {
    return parseArgs(config);
  } catch (error) {
    console.error(`${error.message}\nRun: node e2e/headless.mjs help`);
    process.exit(1);
  }
}

async function cli() {
  if (!command || command === "help" || flags.help) {
    console.log(HELP);
    return 0;
  }
  const dir = sessionDir();
  const state = readState(dir);
  if (command === "start") return start(dir, state);
  if (command === "status" && !state) {
    console.log("Not running. Start with: node e2e/headless.mjs start");
    return 1;
  }
  if (command === "stop" && !state) {
    console.log("Not running.");
    return 0;
  }
  if (!state) {
    console.error("No session is running. Start one with: node e2e/headless.mjs start");
    return 1;
  }
  if (command === "state") {
    // Where the session listens, for clients in other languages (e2e/finite_headless.py).
    console.log(JSON.stringify(state));
    return 0;
  }
  if (command === "logs") return logs(dir, state);
  if (command === "stop") {
    const code = await send(state, { command });
    // A session that doesn't answer gets SIGTERM, which stops it the same way.
    if (code !== 0) process.kill(state.pid);
    return 0;
  }
  if (command === "api") return api(state);
  if (command === "call") {
    const [tool, input] = args;
    if (!tool) return usage("call <tool> [json|@file|-]");
    let toolArgs;
    try {
      toolArgs = parseInput(input);
    } catch (error) {
      console.error(`The tool's input isn't JSON: ${error.message}`);
      return 1;
    }
    return send(state, { command, tool, args: toolArgs, agent: flags.agent });
  }
  // The daemon runs in another folder, so a file to upload goes as an absolute path.
  if (command === "upload" && args[1]) args[1] = path.resolve(args[1]);
  return send(state, { command, args, flags });
}

function usage(text) {
  console.error(`Usage: node e2e/headless.mjs ${text}`);
  return 1;
}

/** JSON from the argument itself, a file (`@path`) or stdin (`-`). */
function parseInput(input) {
  if (input === undefined) return {};
  if (input === "-") return JSON.parse(fs.readFileSync(0, "utf8"));
  if (input.startsWith("@")) return JSON.parse(fs.readFileSync(input.slice(1), "utf8"));
  return JSON.parse(input);
}

function sessionDir() {
  const hash = crypto.createHash("sha256").update(root).digest("hex").slice(0, 10);
  const name = flags.session ?? process.env.FINITE_HEADLESS_SESSION ?? "default";
  if (!/^[\w.-]+$/.test(name)) throw new Error(`a session name is letters, digits, . - _`);
  return path.join(os.tmpdir(), "finite-headless", `${hash}-${name}`);
}

/** The running session's state, or null. Clears the state a dead session left behind. */
function readState(dir) {
  let state;
  try {
    state = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
  } catch {
    return null;
  }
  if (alive(state.pid)) return state;
  fs.rmSync(path.join(dir, "state.json"), { force: true });
  return null;
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function send(state, body) {
  let res;
  try {
    res = await fetch(`http://127.0.0.1:${state.port}/`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${state.token}` },
      body: JSON.stringify(body),
    });
  } catch (error) {
    console.error(`The session didn't answer (${error.cause?.code ?? error.message}).`);
    return 1;
  }
  const { ok, out } = await res.json();
  if (out) (ok ? process.stdout : process.stderr).write(out.endsWith("\n") ? out : `${out}\n`);
  return ok ? 0 : 1;
}

async function start(dir, state) {
  if (state) {
    console.error(
      `A session is already running at ${state.base}. Stop it first, or pass --session <name>.`,
    );
    return 1;
  }
  const attach = flags.url !== undefined;
  if (attach) {
    try {
      new URL(flags.url);
      if (flags.server) new URL(flags.server);
    } catch {
      return usage("start --url <http://host:port> [--server <http://host:port>]");
    }
  } else if (flags.build) {
    const run = (cmd, cmdArgs, cwd) => {
      console.log(`$ ${cmd} ${cmdArgs.join(" ")}`);
      return spawnSync(cmd, cmdArgs, { cwd, stdio: "inherit" }).status === 0;
    };
    const built =
      run("cargo", ["build", "-q", "-p", "finite-server"], root) &&
      run("node", ["crates/wasm/build.mjs"], root) &&
      run("npx", ["next", "build"], path.join(root, "apps/web"));
    if (!built) return 1;
  } else if (!fs.existsSync(bin) || !fs.existsSync(staticDir)) {
    console.error("No builds to reuse: run start without --no-build once.");
    return 1;
  }

  fs.mkdirSync(dir, { recursive: true });
  const log = fs.openSync(path.join(dir, "session.log"), "w");
  const options = {
    url: flags.url,
    server: flags.server,
    width: Number(flags.width ?? 1440),
    height: Number(flags.height ?? 900),
    idleMinutes: Number(flags.idle ?? 30),
  };
  const child = spawn(process.execPath, [self, "__daemon", dir, JSON.stringify(options)], {
    detached: true,
    stdio: ["ignore", log, log],
  });
  child.unref();
  const exited = new Promise((r) => child.once("exit", () => r(true)));
  for (let i = 0; i < 600; i++) {
    const ready = readState(dir);
    if (ready) {
      console.log(describe(ready));
      return 0;
    }
    if (await Promise.race([exited, sleep(100)])) break;
  }
  console.error(`The session didn't start. Its log, ${path.join(dir, "session.log")}:\n`);
  console.error(fs.readFileSync(path.join(dir, "session.log"), "utf8"));
  if (alive(child.pid)) process.kill(child.pid);
  return 1;
}

function describe(state) {
  const lines = [
    `Finite at ${state.base}`,
    state.server !== state.base ? `MCP and API at ${state.server}` : null,
    state.dataDir
      ? `Data in ${state.dataDir}, deleted on stop`
      : "Attached: stop leaves the server running",
    `Session files in ${state.dir}`,
    `Stops after ${state.idleMinutes} idle minutes`,
  ];
  return lines.filter(Boolean).join("\n");
}

function logs(dir, state) {
  const file = path.join(dir, "server.log");
  if (!state.dataDir || !fs.existsSync(file)) {
    console.error("This session attached to a running server, so it has no server log.");
    return 1;
  }
  const lines = fs.readFileSync(file, "utf8").trimEnd().split("\n");
  console.log(lines.slice(-Number(flags.lines ?? 50)).join("\n"));
  return 0;
}

async function api(state) {
  const [method, route, body] = args;
  if (!method || !route?.startsWith("/")) return usage("api <METHOD> </path> [json]");
  const res = await fetch(`${state.server}${route}`, {
    method: method.toUpperCase(),
    headers: body ? { "Content-Type": "application/json" } : {},
    body,
  });
  const text = await res.text();
  let out = text;
  try {
    out = JSON.stringify(JSON.parse(text), null, 2);
  } catch {}
  console.log(`${res.status} ${res.statusText}`);
  if (out) console.log(out);
  return res.ok ? 0 : 1;
}

// ---------------------------------------------------------------------------
// The background process: it owns the server, Chrome and the MCP sessions.

async function daemon(dir, options) {
  const log = (...parts) => console.log(new Date().toISOString(), ...parts);
  const shots = path.join(dir, "shots");
  fs.mkdirSync(shots, { recursive: true });

  let server = null;
  let base = options.url?.replace(/\/$/, "");
  let api = options.server?.replace(/\/$/, "") ?? base;
  /** Why the server stopped, if it stopped on its own. */
  let serverExit = null;
  if (!base) {
    const out = fs.openSync(path.join(dir, "server.log"), "w");
    server = await startServer({
      bin,
      staticDir,
      // verify.sh's doctor looks for this prefix to tell a private server.
      dataPrefix: "finite-headless-data-",
      wait: false,
      stdio: ["ignore", out, out],
      env: {
        // The server's default, without a line for every MCP session, in a
        // file, so without colors.
        RUST_LOG: process.env.RUST_LOG ?? "info,tower_http=debug,rmcp=warn",
        NO_COLOR: "1",
      },
    });
    server.child.once("exit", (code, signal) => {
      serverExit = signal ? `signal ${signal}` : `code ${code}`;
      log(`server exited with ${serverExit}`);
    });
    base = api = server.url;
  }
  let page;
  try {
    await (server ? server.ready() : waitHealthy(api));
    page = await launch({ width: options.width, height: options.height });
  } catch (error) {
    log(error.stack ?? String(error));
    await server?.stop();
    process.exit(1);
  }
  /** Everything the page logged, and how much of it `console` has shown. */
  const entries = [];
  let shown = 0;
  const record = (level, text) => entries.push({ at: new Date().toISOString(), level, text });
  page.on("Runtime.consoleAPICalled", ({ type, args: values }) =>
    record(type, values.map((v) => v.value ?? v.description ?? v.type).join(" ")),
  );
  page.on("Runtime.exceptionThrown", ({ exceptionDetails: d }) =>
    record("exception", d.exception?.description ?? d.text),
  );
  page.on("Log.entryAdded", ({ entry }) => {
    // The app has no favicon, and Chrome asks for one on every page.
    if (entry.url?.endsWith("/favicon.ico")) return;
    record(entry.level, `${entry.text}${entry.url ? ` (${entry.url})` : ""}`);
  });
  await page.send("Log.enable");
  await page.send("DOM.enable");
  await page.send("Accessibility.enable");
  // $deep and $$deep: querySelector and querySelectorAll that reach into open shadow roots.
  await page.send("Page.addScriptToEvaluateOnNewDocument", { source: DEEP });
  await navigate(page, `${base}/`);

  const agents = new Map();
  const agent = async (name = "Agent") => {
    if (!agents.has(name)) agents.set(name, await connect(api, name));
    return agents.get(name);
  };

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    log("stopping");
    fs.rmSync(path.join(dir, "state.json"), { force: true });
    await server?.stop();
    await page.close().catch(() => {});
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  void page.exited.then(() => {
    if (!stopping) {
      log("Chrome exited");
      return stop();
    }
  });

  let idle;
  const touch = () => {
    clearTimeout(idle);
    idle = setTimeout(() => {
      log(`no command for ${options.idleMinutes} minutes`);
      void stop();
    }, options.idleMinutes * 60_000);
  };
  touch();

  const started = Date.now();
  const commands = {
    async status() {
      const lines = [
        describe(state),
        `Page: ${await page.eval("location.href")}`,
        `Agents: ${agents.size ? [...agents.keys()].join(", ") : "none yet"}`,
        `Up ${Math.round((Date.now() - started) / 1000)} s`,
      ];
      if (serverExit) lines.push(`The server stopped on its own (${serverExit}): see logs`);
      return lines.join("\n");
    },
    async stop() {
      setTimeout(stop, 10);
      return "Stopped.";
    },
    async tools({ args: [name] }) {
      const tools = await (await agent()).tools();
      if (!name) {
        const width = Math.max(...tools.map((t) => t.name.length));
        const out = tools
          .map((t) => `${t.name.padEnd(width)}  ${(t.description ?? "").split("\n")[0]}`)
          .join("\n");
        return { out, value: tools };
      }
      const tool = tools.find((t) => t.name === name);
      if (!tool) throw new Error(`no tool named ${name}`);
      return {
        out: `${tool.name}\n\n${tool.description}\n\nInput:\n${JSON.stringify(tool.inputSchema, null, 2)}`,
        value: tool,
      };
    },
    async call({ tool, args: input, agent: name }) {
      const result = await (await agent(name)).callRaw(tool, input);
      const images = [];
      const parts = result.content.map((c) => {
        if (c.type === "image") {
          const ext = { "image/jpeg": "jpg", "image/webp": "webp" }[c.mimeType] ?? "png";
          const file = path.join(shots, `${tool}-${Date.now()}-${images.length}.${ext}`);
          fs.writeFileSync(file, Buffer.from(c.data, "base64"));
          images.push(file);
          return `[image saved to ${file}]`;
        }
        return c.text ?? `[${c.type} content]`;
      });
      const out = parts.join("\n");
      if (result.isError) throw new Error(out);
      const text = result.content.map((c) => c.text ?? "").join("\n");
      return { out, value: { text, images } };
    },
    async open({ args: [target] }) {
      const url = !target
        ? await page.eval("location.href")
        : /^https?:/.test(target)
          ? target
          : `${base}${target.startsWith("/") ? "" : "/"}${target}`;
      await navigate(page, url);
      return `Opened ${await page.eval("location.href")}`;
    },
    async design({ args: [id] }) {
      if (!id) throw new Error("usage: design <designId>");
      const res = await fetch(`${api}/api/designs/${encodeURIComponent(id)}`);
      if (!res.ok) throw new Error(`design ${id}: ${res.status} ${await res.text()}`);
      const snapshot = await res.json();
      const boards = snapshot.nodes.filter((n) => n.parent === null).length;
      await navigate(page, `${base}/design/?id=${encodeURIComponent(id)}`);
      const rendered = await page
        .until(`document.querySelectorAll("[data-artboard]").length >= ${boards}`, 10_000)
        .then(
          () => true,
          () => false,
        );
      const count = await page.eval(`document.querySelectorAll("[data-artboard]").length`);
      return {
        out: rendered
          ? `Opened "${snapshot.meta.name}": ${count} of ${boards} artboards rendered`
          : `Opened "${snapshot.meta.name}", but only ${count} of ${boards} artboards rendered within 10 s`,
        value: { name: snapshot.meta.name, artboards: boards, rendered: count },
      };
    },
    async screenshot({ args: [file], flags: { selector, nth } }) {
      const out = path.resolve(file ?? path.join(shots, `page-${Date.now()}.png`));
      const params = { format: "png" };
      if (selector) {
        const r = await rect(page, selector, nth);
        params.clip = { x: r.x, y: r.y, width: r.w, height: r.h, scale: 1 };
      }
      const { data } = await page.send("Page.captureScreenshot", params);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, Buffer.from(data, "base64"));
      return { out, value: out };
    },
    async snapshot({ flags: { selector, nth } }) {
      return axTree(page, selector, nth);
    },
    async text({ flags: { selector, nth } }) {
      const el = selector
        ? `$deepOrThrow(${JSON.stringify(selector)}, ${Number(nth ?? 0)})`
        : "document.body";
      return page.eval(`$deepText(${el})`);
    },
    async query({ args: [selector] }) {
      if (!selector) throw new Error("usage: query <css>");
      const found = await page.eval(`$$deep(${JSON.stringify(selector)}).map((el) => {
        const r = el.getBoundingClientRect();
        const text = $deepText(el).replace(/\\s+/g, " ").trim();
        const inView = r.width > 0 && r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight;
        const label = el.getAttribute("aria-label") ?? el.getAttribute("title") ?? "";
        return { tag: el.localName, id: el.id, cls: el.getAttribute("class") ?? "", label, text, x: r.x, y: r.y, w: r.width, h: r.height, inView, shadow: el.getRootNode() instanceof ShadowRoot };
      })`);
      if (!found.length) return { out: `Nothing matches ${selector}`, value: [] };
      const shown = found.slice(0, 50).map((e, i) => {
        // StyleX's atomic classes, like x1lliihq, say nothing to a reader.
        const classes = e.cls.split(/\s+/).filter((c) => c && !/^x[a-z0-9]{5,8}$/.test(c));
        const name = `${e.tag}${e.id ? `#${e.id}` : ""}${classes.map((c) => `.${c}`).join("")}`;
        const where = `${Math.round(e.x)},${Math.round(e.y)} ${Math.round(e.w)}×${Math.round(e.h)}`;
        const notes = [e.shadow ? "in an artboard" : null, e.inView ? null : "out of view"].filter(
          Boolean,
        );
        const text = e.text.length > 80 ? `${e.text.slice(0, 80)}…` : e.text;
        const label = e.label ? ` [${e.label}]` : "";
        return `${i}  ${name}${label}  ${where}${notes.length ? ` (${notes.join(", ")})` : ""}${text ? `  "${text}"` : ""}`;
      });
      if (found.length > 50) shown.push(`… and ${found.length - 50} more`);
      return { out: shown.join("\n"), value: found };
    },
    async eval({ args: [expression] }) {
      if (!expression) throw new Error("usage: eval <js>");
      const value = await page.eval(expression);
      return { out: format(value), value: value ?? null };
    },
    async wait({ args: [expression], flags: { timeout } }) {
      if (!expression) throw new Error("usage: wait <js> [--timeout ms]");
      const value = await page.until(expression, Number(timeout ?? 5000));
      return { out: format(value), value: value ?? null };
    },
    async click({ args: target, flags: { nth, shift, double } }) {
      const { x, y, label } = await point(page, target, nth);
      await page.move(x - 1, y - 1);
      await page.click(x, y, { shift, double });
      await page.settle();
      const how = `${shift ? "Shift-" : ""}${double ? "double-clicked" : "clicked"}`;
      return `${how[0].toUpperCase()}${how.slice(1)} ${label} at ${Math.round(x)},${Math.round(y)}`;
    },
    async wheel({ args: [x, y, dx, dy], flags: { ctrl } }) {
      const [px, py, sx, sy] = [x, y, dx, dy].map(Number);
      if ([px, py, sx, sy].some((n) => !Number.isFinite(n))) {
        throw new Error("usage: wheel <x> <y> <dx> <dy> [--ctrl]");
      }
      await page.move(px, py);
      // Ten events 16 ms apart: one gesture, as a trackpad sends it.
      for (let i = 0; i < 10; i++) {
        await page.wheel(px, py, sx / 10, sy / 10, { ctrl });
        await sleep(16);
      }
      await page.settle();
      return `Scrolled ${sx},${sy} at ${px},${py}`;
    },
    async hover({ args: target, flags: { nth } }) {
      const { x, y, label } = await point(page, target, nth);
      // Two moves, so the page sees the pointer arrive.
      await page.move(x - 5, y - 5);
      await page.move(x, y);
      await page.settle();
      return `Moved to ${label} at ${Math.round(x)},${Math.round(y)}`;
    },
    async drag({ args: target, flags: { nth, by, to, steps, shift } }) {
      if (!by && !to) throw new Error("usage: drag <css|x y> --by <dx>,<dy> | --to <css>");
      const from = await point(page, target, nth);
      let end;
      if (to) end = await point(page, [to], 0);
      else {
        const [dx, dy] = String(by).split(",").map(Number);
        if (!Number.isFinite(dx) || !Number.isFinite(dy)) throw new Error("--by takes dx,dy");
        end = { x: from.x + dx, y: from.y + dy };
      }
      await page.drag(from, end, { steps: Number(steps ?? 10), shift });
      await page.settle();
      return `Dragged ${from.label} from ${Math.round(from.x)},${Math.round(from.y)} to ${Math.round(end.x)},${Math.round(end.y)}`;
    },
    async upload({ args: [selector, file], flags: { nth } }) {
      if (!selector || !file) throw new Error("usage: upload <css> <file>");
      if (!fs.existsSync(file)) throw new Error(`no file at ${file}`);
      const { result, exceptionDetails } = await page.send("Runtime.evaluate", {
        expression: `$deepOrThrow(${JSON.stringify(selector)}, ${Number(nth ?? 0)})`,
      });
      if (exceptionDetails)
        throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
      // Chrome fires the input's change event, as it does after the OS picker.
      await page.send("DOM.setFileInputFiles", { files: [file], objectId: result.objectId });
      await page.settle();
      return `Picked ${path.basename(file)} in ${selector}`;
    },
    async type({ args: [text] }) {
      if (text === undefined) throw new Error("usage: type <text>");
      await page.type(text);
      return `Typed ${JSON.stringify(text)}`;
    },
    async key({ args: [spec] }) {
      if (!spec) throw new Error("usage: key <key>, like Enter or Shift+1");
      await page.press(spec);
      await page.settle();
      return `Pressed ${spec}`;
    },
    async viewport({ args: [width, height] }) {
      const w = Number(width);
      const h = Number(height);
      if (!(w > 0 && h > 0)) throw new Error("usage: viewport <width> <height>");
      await page.send("Emulation.setDeviceMetricsOverride", {
        width: w,
        height: h,
        deviceScaleFactor: 1,
        mobile: false,
      });
      return `Viewport ${w}×${h}`;
    },
    async console({ flags: { all } }) {
      const list = all ? entries : entries.slice(shown);
      shown = entries.length;
      const out = list.length
        ? list.map((e) => `${e.at.slice(11, 23)} ${e.level}: ${e.text}`).join("\n")
        : all
          ? "Nothing logged."
          : "Nothing new logged.";
      return { out, value: list };
    },
  };

  const token = crypto.randomBytes(24).toString("hex");
  /**
   * Page commands run one at a time, so two shells can't interleave clicks and
   * keys. MCP calls don't touch the page, so they skip the queue: a
   * `call comments` left waiting mustn't hold up the clicks that post
   * the comment it waits for.
   */
  let queue = Promise.resolve();
  const unqueued = new Set(["call", "tools", "status", "stop"]);
  const control = http.createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401).end();
      return;
    }
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = JSON.parse(raw);
      const handle = async () => {
        touch();
        const run = commands[body.command];
        let reply;
        if (!run) {
          reply = {
            ok: false,
            out: `Unknown command ${body.command}. Run: node e2e/headless.mjs help`,
          };
        } else {
          try {
            // A command returns its text, or { out, value } when a program
            // reading the reply wants the data too, like eval's result.
            const result = await run({ args: [], flags: {}, ...body });
            reply =
              typeof result === "string" ? { ok: true, out: result } : { ok: true, ...result };
          } catch (error) {
            // Errors thrown in the page carry its stack, which says nothing useful here.
            const lines = error.message.replace(/^Error: /, "").split("\n");
            reply = { ok: false, out: lines.filter((l) => !/^\s+at /.test(l)).join("\n") };
            if (serverExit)
              reply.out += `\nThe server stopped on its own (${serverExit}): see logs`;
          }
        }
        log(body.command, reply.ok ? "ok" : `failed: ${reply.out.split("\n")[0]}`);
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(reply));
      };
      if (unqueued.has(body.command)) void handle();
      else queue = queue.then(handle);
    });
  });
  await new Promise((r) => control.listen(0, "127.0.0.1", r));

  const state = {
    pid: process.pid,
    port: control.address().port,
    token,
    base,
    server: api,
    dataDir: server?.dataDir ?? null,
    dir,
    idleMinutes: options.idleMinutes,
  };
  // Written last: the CLI waits for this file to know the session is ready.
  const file = path.join(dir, "state.json");
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(state), { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
  log(`ready at ${base}`);
}

// ---------------------------------------------------------------------------
// Helpers for the background process.

/** Installed in every page: deep queries and text that reach into open shadow roots. */
const DEEP = `
// "a >>> b" finds b anywhere inside a, shadow roots included.
window.$$deep = (selector, root = document) => {
  let scopes = [root];
  let found = [];
  for (const part of selector.split(">>>").map((p) => p.trim())) {
    found = [];
    const visit = (scope) => {
      found.push(...scope.querySelectorAll(part));
      for (const el of scope.querySelectorAll("*")) if (el.shadowRoot) visit(el.shadowRoot);
    };
    for (const scope of scopes) {
      if (scope.shadowRoot) visit(scope.shadowRoot);
      visit(scope);
    }
    scopes = found = [...new Set(found)];
  }
  return found;
};
window.$deep = (selector, root) => $$deep(selector, root)[0] ?? null;
window.$deepOrThrow = (selector, nth = 0) => {
  const all = $$deep(selector);
  if (!all.length) throw new Error("nothing matches " + selector);
  if (!all[nth]) throw new Error(selector + " matches " + all.length + ", so there's no --nth " + nth);
  return all[nth];
};
// innerText skips shadow roots, so splice each one's text in after its host.
window.$deepText = (el) => {
  const hosts = [...el.querySelectorAll("*")].filter((e) => e.shadowRoot);
  if (el.shadowRoot) hosts.unshift(el);
  let text = el.shadowRoot ? "" : el.innerText ?? el.textContent ?? "";
  for (const host of hosts) {
    for (const child of host.shadowRoot.children) {
      if (child.localName !== "style") text += "\\n" + $deepText(child);
    }
  }
  return text.replace(/\\n{3,}/g, "\\n\\n").trim();
};
`;

/** Loads a URL, then installs the deep queries and lets React hydrate. */
async function navigate(page, url) {
  await page.goto(url);
  await page.send("Runtime.evaluate", { expression: DEEP });
  // Hydration leaves nothing to wait on from outside.
  await sleep(300);
}

const format = (value) =>
  value === undefined
    ? "undefined"
    : typeof value === "string"
      ? value
      : JSON.stringify(value, null, 2);

/** `nth` picks one of several matches, counting from 0 as `query` lists them. */
async function rect(page, selector, nth = 0) {
  return page.eval(`(() => {
    const r = $deepOrThrow(${JSON.stringify(selector)}, ${Number(nth)}).getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  })()`);
}

/** Where to point: `<x> <y>`, or the center of the first element a selector matches. */
async function point(page, target, nth) {
  if (target.length === 2 && target.every((t) => /^-?\d+(\.\d+)?$/.test(t))) {
    return { x: Number(target[0]), y: Number(target[1]), label: "the point" };
  }
  const selector = target.join(" ");
  if (!selector) throw new Error("give a CSS selector, or x and y");
  const r = await rect(page, selector, nth);
  if (!r.w || !r.h) throw new Error(`${selector} has no size, so there's nothing to point at`);
  const x = r.x + r.w / 2;
  const y = r.y + r.h / 2;
  const view = await page.eval(`({ w: innerWidth, h: innerHeight })`);
  if (x < 0 || y < 0 || x >= view.w || y >= view.h) {
    throw new Error(
      `${selector} is out of view, at ${Math.round(x)},${Math.round(y)}. On the canvas, press Shift+1 to fit every artboard.`,
    );
  }
  return { x, y, label: selector };
}

/** The accessibility tree as indented lines, like `button "Start"`, without the empty wrappers. */
async function axTree(page, selector, nth = 0) {
  const { nodes } = await page.send("Accessibility.getFullAXTree");
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  let top = nodes.find((n) => !n.parentId);
  if (selector) {
    const { result } = await page.send("Runtime.evaluate", {
      expression: `$deepOrThrow(${JSON.stringify(selector)}, ${Number(nth)})`,
    });
    if (result.subtype === "error") throw new Error(result.description.split("\n")[0]);
    const { node } = await page.send("DOM.describeNode", { objectId: result.objectId });
    top = nodes.find((n) => n.backendDOMNodeId === node.backendNodeId);
    if (!top) throw new Error(`${selector} isn't in the accessibility tree; it may be hidden`);
  }
  const lines = [];
  const MAX = 500;
  const skip = new Set(["generic", "none", "InlineTextBox", "LineBreak"]);
  const walk = (node, depth, parentName) => {
    if (lines.length > MAX) return;
    const role = node.role?.value;
    const name = node.name?.value ?? "";
    const value = node.value?.value;
    // A button's or heading's text repeats its name, so leave it out.
    const repeat = role === "StaticText" && (!name.trim() || name === parentName);
    const shown = !node.ignored && !skip.has(role) && !repeat;
    if (shown) {
      const props = (node.properties ?? [])
        .filter(
          (p) =>
            ["focused", "checked", "disabled", "expanded", "selected"].includes(p.name) &&
            p.value.value,
        )
        .map((p) => p.name);
      const label =
        role === "StaticText"
          ? JSON.stringify(name)
          : `${role}${name ? ` ${JSON.stringify(name)}` : ""}`;
      const extra = [
        value !== undefined && value !== "" ? `value=${JSON.stringify(value)}` : null,
        ...props,
      ].filter(Boolean);
      lines.push(`${"  ".repeat(depth)}${label}${extra.length ? ` [${extra.join(", ")}]` : ""}`);
    }
    for (const id of node.childIds ?? []) {
      const child = byId.get(id);
      if (child) walk(child, shown ? depth + 1 : depth, shown ? name : parentName);
    }
  };
  walk(top, 0, null);
  if (lines.length > MAX)
    lines.splice(MAX, Infinity, `… cut at ${MAX} lines: pass --selector to look at one part`);
  return lines.join("\n") || "The accessibility tree is empty.";
}

// Last, so every helper above is defined before it runs.
if (command === "__daemon") {
  await daemon(args[0], JSON.parse(args[1]));
} else {
  process.exitCode = await cli();
}
