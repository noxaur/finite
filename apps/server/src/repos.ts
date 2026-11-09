import { execFile, spawn, type ExecFileException } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
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
  // An ssh URL stays ssh: the person's key may be the only access they have to a private repo.
  const url = text.startsWith("git@")
    ? `git@github.com:${owner}/${name}.git`
    : `https://github.com/${owner}/${name}`;
  return { name: `${owner}/${name}`, url };
}

type GitHubRepo = {
  full_name: string;
  html_url: string;
  description: string | null;
  language: string | null;
  stargazers_count: number;
};

const SEARCH_LIMIT = "GitHub's search limit is reached. Wait a minute, or paste the repo's URL.";
const SEARCH_UNREACHABLE = "Couldn't reach GitHub. Paste the repo's URL instead.";
const GH_TIMEOUT_MS = 10_000;
const GH_UNUSABLE_MS = 5 * 60_000;
const SEARCH_CACHE_MS = 60_000;
const SEARCH_CACHE_SIZE = 32;

const execFileAsync = promisify(execFile);
const recentSearches = new Map<string, { at: number; repos: Repo[] }>();
let ghUnusableUntil = 0;

function toRepo(r: GitHubRepo): Repo {
  return {
    name: r.full_name,
    url: r.html_url,
    ...(r.description ? { description: r.description } : {}),
    ...(r.language ? { language: r.language } : {}),
    stars: r.stargazers_count,
  };
}

/** GitHub's search through the person's own `gh` login, or null when `gh` is missing or logged out. */
async function searchWithGh(query: string): Promise<Repo[] | null> {
  if (Date.now() < ghUnusableUntil) return null;
  try {
    const { stdout } = await execFileAsync(
      "gh",
      [
        "api",
        "--hostname",
        "github.com",
        "--method",
        "GET",
        "search/repositories",
        // -f sends the query as raw text; -F would read a leading `@` as a file to upload.
        "-f",
        `q=${query}`,
        "-F",
        "per_page=8",
      ],
      {
        env: { ...process.env, GH_PROMPT_DISABLED: "1" },
        timeout: GH_TIMEOUT_MS,
        killSignal: "SIGKILL",
      },
    );
    return (JSON.parse(stdout) as { items: GitHubRepo[] }).items.map(toRepo);
  } catch (error) {
    const { code, stderr = "" } = error as ExecFileException & { stderr?: string };
    // gh exits 4 when no account is logged in, and an expired token comes back as HTTP 401.
    if (code === "ENOENT" || code === 4 || /HTTP 401/.test(stderr)) {
      ghUnusableUntil = Date.now() + GH_UNUSABLE_MS;
      return null;
    }
    throw new Refused(
      /rate limit|HTTP 429/i.test(stderr) ? SEARCH_LIMIT : SEARCH_UNREACHABLE,
      "invalid",
    );
  }
}

/**
 * Repos that match `query`: the one a URL names, else GitHub's search, through `gh` when it's
 * installed and logged in and unauthenticated (about 10 requests a minute) when it isn't.
 */
export async function searchRepos(query: string): Promise<Repo[]> {
  const named = parseRepo(query);
  if (named && /[/:]/.test(query)) return [named];
  const recent = recentSearches.get(query);
  if (recent && Date.now() - recent.at < SEARCH_CACHE_MS) return recent.repos;
  let repos = await searchWithGh(query);
  if (!repos) {
    const res = await fetch(
      `https://api.github.com/search/repositories?per_page=8&q=${encodeURIComponent(query)}`,
      { headers: { accept: "application/vnd.github+json", "user-agent": "finite" } },
    ).catch(() => null);
    if (!res?.ok) {
      throw new Refused(res?.status === 403 ? SEARCH_LIMIT : SEARCH_UNREACHABLE, "invalid");
    }
    const body = (await res.json()) as { items: GitHubRepo[] };
    repos = body.items.map(toRepo);
  }
  recentSearches.delete(query);
  if (recentSearches.size >= SEARCH_CACHE_SIZE) {
    recentSearches.delete(recentSearches.keys().next().value!);
  }
  recentSearches.set(query, { at: Date.now(), repos });
  return repos;
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
