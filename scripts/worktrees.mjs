// Lists this repo's worktrees and removes the ones whose work has landed.
//
// Parallel agents each make a worktree with its own install, about 1.2 GB, and a full disk
// stops every agent with SQLITE_FULL. A worktree can go when it has no uncommitted or untracked
// changes and its branch is on origin/main, or its PR was merged (squash merges leave the branch
// off main) at the commit the PR merged. One touched in the last 24 hours stays, since a running agent's fresh worktree also
// sits on main. Without --prune this only prints what it would remove.
//
//   node scripts/worktrees.mjs [--prune] [--size]
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const prune = process.argv.includes("--prune");
const size = process.argv.includes("--size");

const git = (args, cwd) => {
  // GIT_OPTIONAL_LOCKS=0 keeps git status from rewriting the index, which `touched` reads.
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
  const r = spawnSync("git", args, { cwd, env, encoding: "utf8" });
  return { ok: r.status === 0, out: r.stdout?.trim() ?? "" };
};

const here = git(["rev-parse", "--show-toplevel"]).out;
const DAY = 24 * 60 * 60 * 1000;
git(["fetch", "--quiet", "origin", "main"]);
if (prune) git(["worktree", "prune"]);

const merged = new Set();
const gh = spawnSync(
  "gh",
  [
    "pr",
    "list",
    "--state",
    "merged",
    "--limit",
    "1000",
    "--json",
    "headRefOid",
    "-q",
    ".[].headRefOid",
  ],
  { encoding: "utf8" },
);
if (gh.status === 0) {
  for (const b of gh.stdout.split("\n")) if (b) merged.add(b);
} else {
  console.error("worktrees: gh isn't logged in, so squash-merged branches count as unmerged.");
}

// When the worktree's index or HEAD last changed: git status, checkout and commit all touch one.
const touched = (dir) => {
  const gitDir = path.resolve(dir, git(["rev-parse", "--git-dir"], dir).out);
  const times = ["index", "HEAD"].map((f) => {
    try {
      return fs.statSync(path.join(gitDir, f)).mtimeMs;
    } catch {
      return 0;
    }
  });
  return Math.max(...times);
};

const worktrees = [];
for (const block of git(["worktree", "list", "--porcelain"]).out.split("\n\n")) {
  const line = (key) =>
    block
      .split("\n")
      .find((l) => l.startsWith(key + " "))
      ?.slice(key.length + 1);
  const dir = line("worktree");
  if (dir)
    worktrees.push({ dir, head: line("HEAD"), branch: line("branch")?.replace("refs/heads/", "") });
}

const main = worktrees[0]?.dir;
let removable = 0;
for (const w of worktrees) {
  const status = git(["status", "--porcelain"], w.dir);
  const why =
    w.dir === main || w.dir === here
      ? "in use"
      : !status.ok
        ? "unreadable"
        : status.out
          ? "has changes"
          : Date.now() - touched(w.dir) < DAY
            ? "recent"
            : git(["merge-base", "--is-ancestor", w.head, "origin/main"]).ok
              ? "landed"
              : merged.has(w.head)
                ? "PR merged"
                : "unmerged";
  const kb = size
    ? Number(spawnSync("du", ["-sk", w.dir], { encoding: "utf8" }).stdout.split("\t")[0])
    : 0;
  const shown = size ? `${(kb / 1048576).toFixed(1)} GB  ` : "";
  const gone = why === "landed" || why === "PR merged";
  console.log(
    `${gone ? "remove" : "keep  "}  ${shown}${why.padEnd(11)}  ${w.branch ?? "(detached)"}  ${w.dir}`,
  );
  if (!gone) continue;
  removable++;
  if (prune && !git(["worktree", "remove", w.dir]).ok)
    console.error(`worktrees: couldn't remove ${w.dir}`);
}
console.log(
  prune
    ? `Removed ${removable} worktrees.`
    : `${removable} of ${worktrees.length} worktrees can go. Run with --prune to remove them.`,
);
