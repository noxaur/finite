// Cleans up after the previous `vp run dev`, so the next one can start and
// target/ doesn't grow forever.
//
// A dev server that outlived its terminal keeps the ports, and a live
// `next dev` also holds apps/web/.next/dev/lock, so a new run would fail.
// The ports are fixed, so only one checkout can run dev at a time: this stops
// a Finite dev server from any checkout, and refuses to touch anything else.
//
// Cargo never deletes old artifacts, so with cargo-sweep installed this
// deletes every build file nothing has used since the previous run started.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ports = [Number(process.env.FINITE_PORT ?? 4100), 5310];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const run = (cmd, args) => spawnSync(cmd, args, { encoding: "utf8" }).stdout?.trim() ?? "";

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const sweep = (flag) => spawnSync("cargo", ["sweep", flag, root], { stdio: "inherit" }).status;
if (spawnSync("cargo", ["sweep", "--version"]).status !== 0) {
  console.log("dev-cleanup: `cargo install cargo-sweep` to delete stale build files from target/");
} else {
  if (fs.existsSync(path.join(root, "sweep.timestamp"))) sweep("--file");
  sweep("--stamp");
}

if (process.platform === "win32") process.exit(0);

const pids = new Set();
for (const port of ports) {
  for (const pid of run("lsof", ["-t", `-iTCP:${port}`, "-sTCP:LISTEN"]).split("\n")) {
    if (pid) pids.add(Number(pid));
  }
}
try {
  const lock = JSON.parse(fs.readFileSync(path.join(root, "apps/web/.next/dev/lock"), "utf8"));
  if (alive(lock.pid)) pids.add(lock.pid);
} catch {}

for (const pid of pids) {
  const command = run("ps", ["-o", "command=", "-p", String(pid)]);
  if (!/finite-server|next-server|next dev/.test(command)) {
    console.error(`dev-cleanup: ${command || `process ${pid}`} holds a dev port; stop it first.`);
    process.exit(1);
  }
  const cwd = run("lsof", ["-a", "-d", "cwd", "-p", String(pid), "-Fn"])
    .split("\n")
    .find((line) => line.startsWith("n"))
    ?.slice(1);
  console.log(`dev-cleanup: stopping ${command} (${pid})${cwd ? ` in ${cwd}` : ""}`);
  process.kill(pid, "SIGTERM");
}

for (let waited = 0; [...pids].some(alive) && waited < 5000; waited += 100) await sleep(100);
for (const pid of pids) if (alive(pid)) process.kill(pid, "SIGKILL");
