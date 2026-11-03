// Micro AX: a cheap way to try an idea for the MCP tools before a full AX run.
//
// A full run (run.mjs) builds a design from nothing with `claude -p` and costs
// about $0.30. Most ideas only change one step, like changing a part that
// several screens share. So a micro run seeds the design as it would be just
// before that step, and any agent with a shell does the step through this CLI.
// Every call goes through `call`, which logs it, so the numbers don't depend on
// the agent's own account.
//
//   node e2e/ax/micro.mjs start <dir> --scenario <name> [--env K=V ...]
//   node e2e/ax/micro.mjs brief <dir>            what the agent reads: task, instructions, tools
//   node e2e/ax/micro.mjs call <dir> <tool> [json|@file|-]
//   node e2e/ax/micro.mjs check <dir>            the scenario's checks and the call log, as JSON
//   node e2e/ax/micro.mjs stop <dir>
//
// `start` runs its own finite-server (--bin, default target/debug) with an
// empty data folder, in the background, until `stop`.
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { connect, idAfter } from "../mcp.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const [command, dirArg, ...rest] = process.argv.slice(2);
const { values: opts, positionals } = parseArgs({
  args: rest,
  allowPositionals: true,
  options: {
    scenario: { type: "string" },
    bin: { type: "string", default: path.join(root, "target/debug/finite-server") },
    env: { type: "string", multiple: true, default: [] },
  },
});

const TITLES = ["Welcome", "Pick your plants", "All set"];

/** A top bar as an agent writes it for each screen: inline styles, its own title. */
const bar = (title) =>
  `<header data-name="Top bar" style="display: flex; align-items: center; gap: 12px; padding: 16px 20px; background: #f0fdf4; border-bottom: 1px solid #bbf7d0; flex-shrink: 0">` +
  `<div data-name="Logo" style="width: 28px; height: 28px; border-radius: 8px; background: #16a34a"></div>` +
  `<span data-name="Title" style="font: 500 17px Inter, sans-serif; color: #14532d">${title}</span>` +
  `</header>`;

const body = (title) =>
  `<main data-name="Body" style="padding: 24px 20px; font: 15px/1.5 Inter, sans-serif; color: #374151"><p style="margin: 0">${title} screen content.</p></main>`;

/** Three screens with the same top bar, as copies; returns their ids. */
async function seedScreens(mcp) {
  const design = (await mcp.call("create_design", { name: "Plantpal" })).match(
    /designId "([^"]+)"/,
  )[1];
  const boards = [];
  const bars = [];
  for (const [i, title] of TITLES.entries()) {
    const out = await mcp.call("create_artboard", {
      designId: design,
      name: title,
      width: 390,
      height: 400,
      x: i * 450,
      y: 0,
      html: bar(title) + body(title),
    });
    boards.push(idAfter(out, "artboard"));
    bars.push(idAfter(out, '"Top bar"'));
  }
  return { design, boards, bars };
}

const CHANGE =
  `In the Finite design "Plantpal", the top bar that all three screens share changed. ` +
  `It now needs a back-arrow button at its left and a "Help" link at its right, and its title should be bold. ` +
  `Each screen keeps its own title. Make the change on every screen and check it. Stop when you're done.`;

/** Whether each artboard's top bar has the change. */
async function checkChange(mcp, ctx) {
  const notes = [];
  let done = 0;
  // A bold title can come from the shared CSS, which the HTML doesn't show.
  const shared = await mcp.callRaw("get_shared_css", { designId: ctx.design }).catch(() => null);
  const css = shared && !shared.isError ? (shared.content?.[0]?.text ?? "") : "";
  const boldShared = /font-weight: ?(6|7|8|9)00|font-weight: ?bold/i.test(css);
  for (const [i, board] of ctx.boards.entries()) {
    const html = await mcp.call("get_html", { designId: ctx.design, nodeId: board });
    // The top bar's own HTML: the artboard's name repeats the title.
    const start = html.indexOf("<header");
    const header = start < 0 ? "" : html.slice(start, html.indexOf("</header>", start));
    const ok = {
      title: header.includes(TITLES[i]),
      help: /Help/.test(header),
      arrow: /←|‹|&larr;|arrow|<svg|chevron/i.test(header),
      bold:
        boldShared ||
        /font-weight: ?(6|7|8|9)00|font-weight: ?bold|font: ?(6|7|8|9)00|<b>|<strong>/i.test(
          header,
        ),
    };
    const all = Object.values(ok).every(Boolean);
    if (all) done++;
    else
      notes.push(
        `${TITLES[i]}: missing ${Object.entries(ok)
          .filter(([, v]) => !v)
          .map(([k]) => k)
          .join(", ")}`,
      );
  }
  return { passed: done, total: ctx.boards.length, notes };
}

export const scenarios = {
  // Three screens whose top bars are copies, and a change to the bar.
  "change-copies": {
    seed: seedScreens,
    prompt: () => CHANGE,
    check: checkChange,
  },
  // The same screens, with the first bar a component and the others instances of it.
  "change-component": {
    async seed(mcp) {
      const ctx = await seedScreens(mcp);
      await mcp.call("create_component", {
        designId: ctx.design,
        nodeId: ctx.bars[0],
        name: "Top bar",
        replaceNodeIds: ctx.bars.slice(1),
      });
      return ctx;
    },
    prompt: () => CHANGE,
    check: checkChange,
  },
  // Building from nothing: does the agent share the bar, and what does the change cost?
  build: {
    async seed(mcp) {
      const design = (await mcp.call("create_design", { name: "Plantpal" })).match(
        /designId "([^"]+)"/,
      )[1];
      return { design };
    },
    prompt: () =>
      `In the Finite design "Plantpal", build three small mobile screens (390 × 400) for a plant-care app: ` +
      `${TITLES.map((t) => `"${t}"`).join(", ")}. They share one top bar (a logo and the screen's title) and each has a line of text. ` +
      `Keep it simple. When they're built, run \`node e2e/ax/micro.mjs mark <dir> change\`, then make this change: ${CHANGE.replace(/^In the Finite design "Plantpal", /, "")}`,
    async check(mcp, ctx) {
      const info = JSON.parse(await mcp.call("get_basic_info", { designId: ctx.design }));
      const boards = info.artboards.slice(0, 3);
      return checkChange(mcp, { ...ctx, boards: boards.map((b) => b.id) });
    },
  },
};

/** A Chromium for get_screenshot and get_layout, if the server wouldn't find one itself. */
function defaultChrome() {
  return (
    ["/opt/helium-browser-bin/chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"].find((p) =>
      fs.existsSync(p),
    ) ?? ""
  );
}

/** Tools that only read, and the ones that only say what an agent is doing. */
const READS = /^(list_designs|get_|find_nodes|find_placement|wait_for_comments)/;
const STATUS = /^(start|finish)_working_on_nodes$/;

const freePort = () =>
  new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });

const statePath = (dir) => path.join(dir, "state.json");
const readState = (dir) => JSON.parse(fs.readFileSync(statePath(dir), "utf8"));

/** Opens an MCP session and returns the client with the server's instructions. */
async function session(base, agent) {
  const mcp = await connect(base, agent);
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "micro", version: "1" },
      },
    }),
  });
  const data = (await res.text())
    .split("\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => l.slice(6))
    .join("");
  return { mcp, instructions: JSON.parse(data).result.instructions ?? "" };
}

async function start(dir) {
  const scenario = scenarios[opts.scenario];
  if (!scenario) throw new Error(`--scenario: one of ${Object.keys(scenarios).join(", ")}`);
  fs.mkdirSync(dir, { recursive: true });
  const port = await freePort();
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "finite-micro-data-"));
  const env = Object.fromEntries(
    opts.env.map((pair) => [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)]),
  );
  const log = fs.openSync(path.join(dir, "server.log"), "a");
  const child = spawn(opts.bin, [], {
    env: {
      // Screenshots and get_layout need a browser.
      FINITE_CHROME: defaultChrome(),
      ...process.env,
      ...env,
      FINITE_PORT: String(port),
      FINITE_DATA_DIR: data,
      RUST_LOG: "warn",
    },
    stdio: ["ignore", log, log],
    detached: true,
  });
  child.unref();
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  const seeder = await connect(base, "Seeder");
  const ctx = await scenario.seed(seeder);
  fs.writeFileSync(
    statePath(dir),
    JSON.stringify({ base, pid: child.pid, data, scenario: opts.scenario, env, ctx }, null, 2),
  );
  fs.writeFileSync(path.join(dir, "calls.jsonl"), "");
  console.log(`Started ${opts.scenario} at ${base}. Brief: node e2e/ax/micro.mjs brief ${dir}`);
}

async function brief(dir) {
  const state = readState(dir);
  const { mcp, instructions } = await session(state.base, "Reader");
  const tools = await mcp.tools();
  const prompt = scenarios[state.scenario].prompt(state.ctx).replaceAll("<dir>", dir);
  const lines = [
    `# Task`,
    "",
    prompt,
    "",
    `# How to use the tools`,
    "",
    `Call a tool with: node e2e/ax/micro.mjs call ${dir} <tool> '<json arguments>'`,
    `For long arguments, write the JSON to a file and pass @file. Images a tool returns are saved as PNG files, and their paths printed.`,
    "",
    `# The server's instructions`,
    "",
    instructions,
    "",
    `# Tools`,
  ];
  for (const t of tools) {
    lines.push("", `## ${t.name}`, "", t.description ?? "", "", "```json");
    lines.push(JSON.stringify(t.inputSchema), "```");
  }
  console.log(lines.join("\n"));
}

async function call(dir, tool, input) {
  const state = readState(dir);
  let text = input ?? "{}";
  if (text === "-") text = fs.readFileSync(0, "utf8");
  else if (text.startsWith("@")) text = fs.readFileSync(text.slice(1), "utf8");
  const args = JSON.parse(text);
  const mcp = await connect(state.base, "Agent");
  const started = Date.now();
  let result;
  try {
    result = await mcp.callRaw(tool, args);
  } catch (error) {
    result = { content: [{ type: "text", text: String(error.message) }], isError: true };
  }
  const out = [];
  let images = 0;
  for (const c of result.content ?? []) {
    if (c.type === "image") {
      const shots = path.join(dir, "shots");
      fs.mkdirSync(shots, { recursive: true });
      const file = path.join(shots, `${Date.now()}-${images++}.png`);
      fs.writeFileSync(file, Buffer.from(c.data, "base64"));
      out.push(`[image saved to ${file}]`);
    } else out.push(c.text ?? "");
  }
  const printed = out.join("\n");
  fs.appendFileSync(
    path.join(dir, "calls.jsonl"),
    JSON.stringify({
      tool,
      argsChars: text.length,
      resultChars: printed.length,
      images,
      error: Boolean(result.isError),
      ms: Date.now() - started,
      ...(result.isError ? { message: printed.slice(0, 300) } : {}),
    }) + "\n",
  );
  console.log(printed);
  if (result.isError) process.exitCode = 1;
}

function calls(dir) {
  const lines = fs.readFileSync(path.join(dir, "calls.jsonl"), "utf8").split("\n").filter(Boolean);
  const phases = { main: [] };
  let phase = "main";
  for (const line of lines) {
    const entry = JSON.parse(line);
    if (entry.mark) phases[(phase = entry.mark)] = [];
    else phases[phase].push(entry);
  }
  return Object.fromEntries(
    Object.entries(phases).map(([name, list]) => [
      name,
      {
        calls: list.length,
        // Calls that change the design: what an idea for editing should cut.
        edits: list.filter((c) => !READS.test(c.tool) && !STATUS.test(c.tool)).length,
        errors: list.filter((c) => c.error).length,
        readKChars: Math.round(list.reduce((a, c) => a + c.resultChars, 0) / 100) / 10,
        writeKChars: Math.round(list.reduce((a, c) => a + c.argsChars, 0) / 100) / 10,
        tools: list.reduce((a, c) => ({ ...a, [c.tool]: (a[c.tool] ?? 0) + 1 }), {}),
        errorMessages: list.filter((c) => c.error).map((c) => `${c.tool}: ${c.message}`),
      },
    ]),
  );
}

async function check(dir) {
  const state = readState(dir);
  const mcp = await connect(state.base, "Checker");
  const result = await scenarios[state.scenario].check(mcp, state.ctx);
  const summary = { scenario: state.scenario, env: state.env, check: result, phases: calls(dir) };
  fs.writeFileSync(path.join(dir, "result.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

function stop(dir) {
  const state = readState(dir);
  try {
    process.kill(state.pid);
  } catch {}
  fs.rmSync(state.data, { recursive: true, force: true });
  console.log("Stopped.");
}

if (!dirArg) {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\nimport")[0]);
  process.exit(1);
}
const dir = path.resolve(dirArg);
switch (command) {
  case "start":
    await start(dir);
    break;
  case "brief":
    await brief(dir);
    break;
  case "call":
    await call(dir, positionals[0], positionals[1]);
    break;
  case "mark":
    fs.appendFileSync(
      path.join(dir, "calls.jsonl"),
      JSON.stringify({ mark: positionals[0] }) + "\n",
    );
    console.log(`Marked ${positionals[0]}.`);
    break;
  case "check":
    await check(dir);
    break;
  case "stop":
    stop(dir);
    break;
  default:
    throw new Error(`unknown command ${command}`);
}
