import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { Refused } from "@finite/protocol";
import { expandHome } from "./browse.ts";

export type Repo = {
  name: string;
  url: string;
  description?: string;
  language?: string;
  stars?: number;
};

/**
 * The repo a pasted GitHub URL or `owner/name` names, or null. Accepts https and ssh forms,
 * with or without `.git`, and ignores anything after the repo (`/tree/main`).
 */
export function parseRepo(input: string): Repo | null {
  const text = input.trim();
  const match =
    /^(?:https?:\/\/github\.com\/|git@github\.com:)([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/?#].*)?$/.exec(
      text,
    ) ?? /^([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(text);
  if (!match) return null;
  const [, owner, name] = match;
  return { name: `${owner}/${name}`, url: `https://github.com/${owner}/${name}` };
}

type GitHubRepo = {
  full_name: string;
  html_url: string;
  description: string | null;
  language: string | null;
  stargazers_count: number;
};

/** Repos that match `query`: the one a URL names, else GitHub's public search (unauthenticated, rate limited). */
export async function searchRepos(query: string): Promise<Repo[]> {
  const named = parseRepo(query);
  if (named && /[/:]/.test(query)) return [named];
  const res = await fetch(
    `https://api.github.com/search/repositories?per_page=8&q=${encodeURIComponent(query)}`,
    { headers: { accept: "application/vnd.github+json", "user-agent": "finite" } },
  ).catch(() => null);
  if (!res?.ok) {
    throw new Refused(
      res?.status === 403
        ? "GitHub's search limit is reached. Wait a minute, or paste the repo's URL."
        : "Couldn't reach GitHub. Paste the repo's URL instead.",
      "invalid",
    );
  }
  const body = (await res.json()) as { items: GitHubRepo[] };
  return body.items.map((r) => ({
    name: r.full_name,
    url: r.html_url,
    ...(r.description ? { description: r.description } : {}),
    ...(r.language ? { language: r.language } : {}),
    stars: r.stargazers_count,
  }));
}

/**
 * Clones `url` and returns the folder it landed in. A `target` ending in `/` is the parent
 * (the repo's name is added); any other is the clone's own folder, which must not exist yet
 * or be empty.
 */
export async function cloneRepo(url: string, target: string): Promise<string> {
  const repo = parseRepo(url);
  if (!repo)
    throw new Refused("That isn't a GitHub repo. Paste https://github.com/owner/name.", "invalid");
  const into = expandHome(
    target.endsWith("/") ? path.join(target, repo.name.split("/")[1]!) : target,
  );
  const existing = await fs.readdir(into).catch(() => null);
  if (existing?.length) {
    throw new Refused(
      `${into} already has files in it. Pick an empty folder or a new name.`,
      "invalid",
    );
  }
  await fs.mkdir(path.dirname(into), { recursive: true });
  await new Promise<void>((resolve, reject) => {
    // `--` ends options so a URL can never be read as a flag.
    const git = spawn("git", ["clone", "--", repo.url, into], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    git.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    git.on("error", () =>
      reject(new Refused("git isn't installed, or isn't on the PATH.", "invalid")),
    );
    git.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(
            new Refused(
              `git clone failed: ${stderr.trim().split("\n").at(-1) ?? "unknown error"}`,
              "invalid",
            ),
          ),
    );
  });
  return into;
}
