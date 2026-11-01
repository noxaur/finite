// Grades the final screenshot of each AX run, blind to its label, so a tool
// change that saves calls but makes worse designs shows up.
//
//   node e2e/ax/grade.mjs [label ...]      grades runs without a grade.json yet
//
// Each run with a final.png gets one `claude -p` grader (--model, default
// claude-sonnet-5-5 at high effort) that sees the task and the image only,
// and writes grade.json: quality and fit from 1 to 10, and the issues it saw.
// report.mjs averages them.
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { tasks } from "./tasks.mjs";

const results = path.join(path.dirname(fileURLToPath(import.meta.url)), "results");
const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    model: { type: "string", default: "claude-sonnet-5-5" },
    effort: { type: "string", default: "high" },
    parallel: { type: "string", default: "6" },
  },
});

const runs = [];
for (const label of positionals.length ? positionals : fs.readdirSync(results)) {
  for (const run of fs.readdirSync(path.join(results, label))) {
    const dir = path.join(results, label, run);
    if (fs.existsSync(path.join(dir, "final.png")) && !fs.existsSync(path.join(dir, "grade.json")))
      runs.push(dir);
  }
}

function grade(dir) {
  const metrics = JSON.parse(fs.readFileSync(path.join(dir, "metrics.json"), "utf8"));
  const task = tasks[metrics.task].prompt({});
  // A neutral copy, so the path doesn't tell the grader which variant made it.
  const blind = fs.mkdtempSync(path.join(os.tmpdir(), "finite-ax-grade-"));
  const image = path.join(blind, `${crypto.randomUUID()}.png`);
  fs.copyFileSync(path.join(dir, "final.png"), image);
  const prompt = `You grade UI designs. An agent was given this task:\n\n${task}\n\nRead the image ${image} (one artboard of the result). Score it from 1 to 10 for visual quality (layout, spacing, alignment, hierarchy, polish, nothing clipped or overlapping) and from 1 to 10 for how well it fits the task. Reply with only JSON: {"quality": n, "fit": n, "issues": "one sentence"}.`;
  return new Promise((resolve) => {
    const child = spawn(
      "claude",
      [
        "-p",
        prompt,
        "--model",
        opts.model,
        "--effort",
        opts.effort,
        "--allowedTools",
        "Read",
        "--setting-sources",
        "project",
        "--strict-mcp-config",
        "--no-session-persistence",
        "--output-format",
        "json",
      ],
      { cwd: blind, stdio: ["ignore", "pipe", "ignore"] },
    );
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.on("exit", () => {
      try {
        const text = JSON.parse(out).result;
        const json = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
        fs.writeFileSync(path.join(dir, "grade.json"), JSON.stringify(json, null, 2));
        console.log(`${path.relative(results, dir)}: quality ${json.quality}, fit ${json.fit}`);
      } catch (error) {
        console.error(`${dir}: ${error.message}`);
      }
      fs.rmSync(blind, { recursive: true, force: true });
      resolve();
    });
  });
}

let next = 0;
await Promise.all(
  Array.from({ length: Math.min(Number(opts.parallel), runs.length) }, async () => {
    while (next < runs.length) await grade(runs[next++]);
  }),
);
