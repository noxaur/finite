// AX (agent experience) experiments: real agents use Finite's MCP tools on
// fixed tasks, and we measure how it went.
//
//   node e2e/ax/run.mjs --task restyle --runs 3 --label baseline
//   node e2e/ax/run.mjs --task restyle,mobile --runs 2 --label new-tools --bin /tmp/finite-server-new
//   node e2e/ax/run.mjs --task rebrand --runs 3 --label example --surface e2e/ax/surfaces/example.mjs
//   node e2e/ax/report.mjs                 compare every label's results
//
// Each run starts its own finite-server (--bin, default target/debug) with an
// empty data folder, seeds the task's design, and runs `claude -p` (--model,
// default claude-sonnet-5-5, and --effort, default medium) with only the
// Finite MCP server. Afterwards it checks the design, takes a screenshot,
// resumes the same agent to ask for its feedback on the tools, and saves the
// transcript, the feedback and metrics.json to e2e/ax/results/<label>/.
//
// Built-in tools stay on (minus Edit and Write), so the metrics show when an
// agent reaches past MCP: curl to the API, reading the server's code, and
// so on. Runs cost real money; --budget caps each one (default $4).
//
// --surface shows the agent a mock tool surface from a spec file instead of
// the server's own tools, answered through the same server (mock-surface.mjs).
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { findChrome, root, startServer } from "../lib.mjs";
import { connect } from "../mcp.mjs";
import { tasks } from "./tasks.mjs";

const { values: opts } = parseArgs({
  options: {
    task: { type: "string", default: "restyle" },
    runs: { type: "string", default: "1" },
    label: { type: "string", default: "baseline" },
    bin: { type: "string", default: path.join(root, "target/debug/finite-server") },
    model: { type: "string", default: "claude-sonnet-5-5" },
    effort: { type: "string", default: "medium" },
    budget: { type: "string", default: "4" },
    // A spec file for mock-surface.mjs, to try a tool design before building it.
    surface: { type: "string" },
    parallel: { type: "string", default: "4" },
    "no-feedback": { type: "boolean", default: false },
    // KEY=VALUE for the server, like RUST_LOG=debug. Repeatable.
    env: { type: "string", multiple: true, default: [] },
  },
});

const FEEDBACK = `Before you go, give candid feedback on the Finite MCP tools, from what happened in this session only. Bullet points, at most 12 in all:
1. Calls that failed, surprised you, or returned something you didn't expect, and why.
2. Anything you had to work around: extra calls, guessing ids, re-reading, reading files or code, or doing many small calls where one would do.
3. A tool or parameter you wished existed, and what you'd have done with it.
4. Tools you saw but didn't use or didn't understand.
Don't call any more tools.`;

/** The --env pairs as an object. */
function serverEnv() {
  return Object.fromEntries(
    opts.env.map((pair) => [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)]),
  );
}

// The checks and the server's render tool both need a browser.
process.env.FINITE_CHROME ??= findChrome();

async function startAxServer(bin) {
  const server = await startServer({
    bin,
    env: { ...serverEnv(), NO_COLOR: "1" },
    stdio: "ignore",
  });
  const api = async (method, p, body) => {
    const init = { method, headers: { "Content-Type": "application/json" } };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await fetch(server.url + p, init);
    if (!res.ok) throw new Error(`${method} ${p}: ${res.status} ${await res.text()}`);
    return res.json();
  };
  return { base: server.url, api, stop: () => server.stop() };
}

/** Runs `claude -p`, writing its stream-json to `file`, and resolves with the final result event. */
function claude(args, cwd, file) {
  return new Promise((resolve) => {
    const out = fs.createWriteStream(file, { flags: "a" });
    const child = spawn("claude", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let result = null;
    let buf = "";
    child.stdout.on("data", (chunk) => {
      out.write(chunk);
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        try {
          const event = JSON.parse(line);
          if (event.type === "result") result = event;
        } catch {}
      }
    });
    child.stderr.on("data", (chunk) => out.write(chunk));
    child.on("exit", () => out.end(() => resolve(result)));
  });
}

/** Counts from a transcript: which tools, how many failed, and what reached past MCP. */
function analyze(file) {
  const uses = new Map();
  const calls = {};
  const errors = [];
  const outside = [];
  let resultChars = 0;
  let screenshots = 0;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const content = event.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block.type === "tool_use") {
        const name = block.name.replace(/^mcp__finite__/, "");
        uses.set(block.id, { name, input: block.input });
        calls[name] = (calls[name] ?? 0) + 1;
        if (!block.name.startsWith("mcp__finite__") && block.name !== "ToolSearch") {
          outside.push(`${name}: ${JSON.stringify(block.input).slice(0, 160)}`);
        }
      } else if (block.type === "tool_result") {
        const use = uses.get(block.tool_use_id);
        const parts = Array.isArray(block.content)
          ? block.content
          : [{ type: "text", text: String(block.content ?? "") }];
        const text = parts.map((p) => p.text ?? "").join("\n");
        if (use?.name === "render" && use.input?.output !== "layout") screenshots++;
        else resultChars += text.length;
        if (block.is_error) errors.push(`${use?.name ?? "?"}: ${text.slice(0, 220)}`);
      }
    }
  }
  const total = Object.values(calls).reduce((a, b) => a + b, 0);
  return { calls, total, errors, outside, resultChars, screenshots };
}

function workdir(kind, dir, files = {}) {
  const cwd = path.join(dir, "work");
  fs.mkdirSync(cwd, { recursive: true });
  if (kind === "web-src")
    fs.cpSync(path.join(root, "apps/web/src"), path.join(cwd, "web"), { recursive: true });
  for (const [name, content] of Object.entries(files))
    fs.writeFileSync(path.join(cwd, name), content);
  return cwd;
}

async function runOnce(taskName, index, outDir) {
  const task = tasks[taskName];
  const dir = path.join(outDir, `${taskName}-${index}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const server = await startAxServer(opts.bin);
  try {
    const seeder = await connect(server.base, "Seeder");
    const ctx = await task.seed(seeder, server.api);
    const config = path.join(dir, "mcp.json");
    fs.writeFileSync(
      config,
      JSON.stringify({
        mcpServers: {
          finite: opts.surface
            ? {
                type: "stdio",
                command: process.execPath,
                args: [path.join(root, "e2e/ax/mock-surface.mjs"), path.resolve(opts.surface)],
                env: { FINITE_BASE: server.base, FINITE_AGENT: `ax-${taskName}-${index}` },
              }
            : {
                type: "http",
                url: `${server.base}/mcp`,
                headers: { "X-Finite-Agent": `ax-${taskName}-${index}` },
              },
        },
      }),
    );
    const transcript = path.join(dir, "transcript.jsonl");
    const common = [
      "--model",
      opts.model,
      "--effort",
      opts.effort,
      "--mcp-config",
      config,
      "--strict-mcp-config",
      "--setting-sources",
      "project",
      "--disable-slash-commands",
      "--dangerously-skip-permissions",
      "--disallowedTools",
      "Edit",
      "Write",
      "NotebookEdit",
      "WebFetch",
      "WebSearch",
      "Agent",
      "--output-format",
      "stream-json",
      "--verbose",
    ];
    const cwd = workdir(task.workdir, dir, task.files);
    // A check can look at what the agent left in its folder, like an exported file.
    ctx.workdir = cwd;
    const started = Date.now();
    const result = await claude(
      ["-p", task.prompt(ctx), ...common, "--max-budget-usd", opts.budget],
      cwd,
      transcript,
    );
    let seconds = Math.round((Date.now() - started) / 1000);
    const metrics = analyze(transcript);

    // A follow-up in the same session, like a change to what it built.
    // It's measured on its own too, since that's what some tools are for.
    let last = result;
    let change = null;
    if (task.followUp && result?.session_id) {
      const file = path.join(dir, "transcript-change.jsonl");
      const changeStarted = Date.now();
      last = await claude(
        [
          "-p",
          task.followUp(ctx),
          "--resume",
          result.session_id,
          ...common,
          "--max-budget-usd",
          opts.budget,
        ],
        cwd,
        file,
      );
      const changed = analyze(file);
      change = {
        ...changed,
        cost: last?.total_cost_usd ?? null,
        seconds: Math.round((Date.now() - changeStarted) / 1000),
        stop: last?.api_error ? `api error: ${last.api_error}` : (last?.subtype ?? "no result"),
      };
      seconds += change.seconds;
      for (const [name, n] of Object.entries(changed.calls))
        metrics.calls[name] = (metrics.calls[name] ?? 0) + n;
      metrics.total += changed.total;
      metrics.errors.push(...changed.errors);
      metrics.outside.push(...changed.outside);
      metrics.resultChars += changed.resultChars;
      metrics.screenshots += changed.screenshots;
    }

    const checker = await connect(server.base, "Checker");
    let check;
    try {
      check = await task.check(checker, ctx);
    } catch (error) {
      check = { passed: 0, total: 1, notes: [`check failed: ${error.message}`] };
    }
    const design = check.design ?? ctx.design;
    const board = check.screenshot ?? ctx.board;
    if (design && board) {
      const shot = await checker.callRaw("render", {
        designId: design,
        select: `#${board}`,
        scale: 0.5,
      });
      const image = shot.content?.find((c) => c.type === "image");
      if (image) fs.writeFileSync(path.join(dir, "final.png"), Buffer.from(image.data, "base64"));
    }

    // Artboards the agent left with content cut off by their edge, by the
    // server's own layout check, so a variant that warns about clipping can
    // be compared with one that doesn't.
    let clipped = null;
    if (design) {
      try {
        const layout = await checker.call("render", {
          designId: design,
          output: "layout",
          depth: 0,
        });
        clipped = layout.split("Layout: content is cut off by the artboard's edge").length - 1;
      } catch {}
    }

    let feedback = "";
    if (!opts["no-feedback"] && last?.session_id) {
      const fb = await claude(
        ["-p", FEEDBACK, "--resume", last.session_id, ...common, "--max-budget-usd", "1"],
        cwd,
        path.join(dir, "feedback.jsonl"),
      );
      feedback = fb?.result ?? "";
      fs.writeFileSync(path.join(dir, "feedback.md"), feedback);
    }
    const summary = {
      task: taskName,
      index,
      label: opts.label,
      env: serverEnv(),
      surface: opts.surface ?? null,
      model: opts.model,
      effort: opts.effort,
      seconds,
      cost: (result?.total_cost_usd ?? 0) + (change?.cost ?? 0) || null,
      turns: result?.num_turns ?? null,
      // A usage limit or outage ends a run early but still reports success,
      // so name it, and report.mjs leaves the run out.
      stop: result?.api_error
        ? `api error: ${result.api_error}`
        : change?.stop?.startsWith("api error")
          ? change.stop
          : (result?.subtype ?? "no result"),
      check,
      clipped,
      ...metrics,
      // The follow-up on its own: calls, errors and cost for the change.
      change,
    };
    fs.writeFileSync(path.join(dir, "metrics.json"), JSON.stringify(summary, null, 2));
    console.log(
      `${opts.label} ${taskName}#${index}: ${check.passed}/${check.total} checks, ${metrics.total} calls` +
        (change ? ` (${change.total} for the change)` : "") +
        ", " +
        `${metrics.errors.length} errors, ${metrics.outside.length} outside MCP, $${summary.cost?.toFixed(2)}, ${seconds}s`,
    );
    return summary;
  } finally {
    await server.stop();
  }
}

const outDir = path.join(root, "e2e/ax/results", opts.label);
fs.mkdirSync(outDir, { recursive: true });
const jobs = [];
for (const t of opts.task.split(",")) {
  if (!tasks[t]) throw new Error(`unknown task ${t}; tasks: ${Object.keys(tasks).join(", ")}`);
  for (let i = 0; i < Number(opts.runs); i++) jobs.push([t, i]);
}
const limit = Number(opts.parallel);
let next = 0;
await Promise.all(
  Array.from({ length: Math.min(limit, jobs.length) }, async () => {
    while (next < jobs.length) {
      const [t, i] = jobs[next++];
      try {
        await runOnce(t, i, outDir);
      } catch (error) {
        console.error(`${t}#${i} failed: ${error.stack ?? error}`);
      }
    }
  }),
);
