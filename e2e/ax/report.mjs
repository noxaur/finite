// Compares AX runs: one row per label and task, averaged over its runs.
//
//   node e2e/ax/report.mjs [label ...]     every label in e2e/ax/results by default
//   node e2e/ax/report.mjs --tools         also list each tool's average calls per run
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const results = path.join(path.dirname(fileURLToPath(import.meta.url)), "results");
const args = process.argv.slice(2);
const showTools = args.includes("--tools");
const labels = args.filter((a) => !a.startsWith("--"));
const chosen = labels.length ? labels : fs.existsSync(results) ? fs.readdirSync(results) : [];

/** The average of a grade over the runs that have one, or "–". */
function graded(runs, key) {
  const scores = runs.map((r) => r.grade?.[key]).filter((v) => typeof v === "number");
  return scores.length ? (scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1) : "–";
}

const rows = [];
const tools = {};
for (const label of chosen) {
  const dir = path.join(results, label);
  if (!fs.statSync(dir).isDirectory()) continue;
  const byTask = {};
  for (const run of fs.readdirSync(dir)) {
    const file = path.join(dir, run, "metrics.json");
    if (!fs.existsSync(file)) continue;
    const m = JSON.parse(fs.readFileSync(file, "utf8"));
    if (m.stop?.startsWith("api error")) {
      console.error(`skipped ${label}/${run}: ${m.stop}`);
      continue;
    }
    const gradeFile = path.join(dir, run, "grade.json");
    m.grade = fs.existsSync(gradeFile) ? JSON.parse(fs.readFileSync(gradeFile, "utf8")) : null;
    (byTask[m.task] ??= []).push(m);
  }
  for (const [task, runs] of Object.entries(byTask)) {
    const avg = (f) => runs.reduce((a, r) => a + (f(r) ?? 0), 0) / runs.length;
    rows.push({
      label,
      task,
      runs: runs.length,
      checks: `${avg((r) => r.check.passed / r.check.total).toFixed(2)}`,
      calls: avg((r) => r.total).toFixed(1),
      errors: avg((r) => r.errors.length).toFixed(1),
      outside: avg((r) => r.outside.length).toFixed(1),
      readKChars: (avg((r) => r.resultChars) / 1000).toFixed(1),
      shots: avg((r) => r.screenshots).toFixed(1),
      cost: `$${avg((r) => r.cost).toFixed(2)}`,
      seconds: avg((r) => r.seconds).toFixed(0),
      // Runs that finished with an artboard's content cut off, of those measured.
      clipped: `${runs.filter((r) => r.clipped > 0).length}/${runs.filter((r) => r.clipped != null).length}`,
      quality: graded(runs, "quality"),
      fit: graded(runs, "fit"),
    });
    for (const r of runs)
      for (const [name, n] of Object.entries(r.calls)) {
        const key = `${label}/${task}`;
        tools[key] ??= {};
        tools[key][name] = (tools[key][name] ?? 0) + n / runs.length;
      }
  }
}

const cols = [
  "label",
  "task",
  "runs",
  "checks",
  "calls",
  "errors",
  "outside",
  "readKChars",
  "shots",
  "cost",
  "seconds",
  "clipped",
  "quality",
  "fit",
];
console.log(`| ${cols.join(" | ")} |\n| ${cols.map(() => "---").join(" | ")} |`);
for (const r of rows) console.log(`| ${cols.map((c) => r[c]).join(" | ")} |`);
if (showTools) {
  for (const [key, counts] of Object.entries(tools)) {
    const list = Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .map(([n, c]) => `${n} ${c.toFixed(1)}`)
      .join(", ");
    console.log(`\n${key}: ${list}`);
  }
}
