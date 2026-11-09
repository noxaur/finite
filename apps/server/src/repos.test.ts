import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Refused } from "@finite/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { listDirs } from "./browse.ts";
import { handlers } from "./handlers.ts";
import type { Context } from "./hub.ts";
import { parseRepo } from "./repos.ts";

describe("parseRepo", () => {
  it("reads https, ssh and short forms", () => {
    const want = { name: "acme/app", url: "https://github.com/acme/app" };
    expect(parseRepo("https://github.com/acme/app")).toEqual(want);
    expect(parseRepo("https://github.com/acme/app.git")).toEqual(want);
    expect(parseRepo("https://github.com/acme/app/tree/main/src")).toEqual(want);
    expect(parseRepo("git@github.com:acme/app.git")).toEqual({
      name: "acme/app",
      url: "git@github.com:acme/app.git",
    });
    expect(parseRepo("acme/app")).toEqual(want);
  });

  it("refuses text that names no repo", () => {
    expect(parseRepo("dashboard")).toBeNull();
    expect(parseRepo("https://example.com/acme/app")).toBeNull();
  });
});

describe("searchRepos", () => {
  let bin: string;
  let calls: string;
  let searchRepos: typeof import("./repos.ts").searchRepos;
  const fetchMock = vi.fn<typeof fetch>();
  const item = {
    full_name: "acme/app",
    html_url: "https://github.com/acme/app",
    description: null,
    language: "TypeScript",
    stargazers_count: 7,
  };
  const row = {
    name: "acme/app",
    url: "https://github.com/acme/app",
    language: "TypeScript",
    stars: 7,
  };
  const success = `printf '%s' '${JSON.stringify({ items: [item] })}'`;
  const loggedOut = `printf 'To get started with GitHub CLI, please run:  gh auth login\\n' >&2; exit 4`;

  // PATH is only this folder, so the real gh can never run. The script can use shell builtins only.
  const fakeGh = (body: string) =>
    fs.writeFile(
      path.join(bin, "gh"),
      `#!/bin/sh\nprintf 'prompt=%s ' "$GH_PROMPT_DISABLED" >> '${calls}'\nprintf '[%s]' "$@" >> '${calls}'\nprintf '\\n' >> '${calls}'\n${body}\n`,
      { mode: 0o755 },
    );
  const spawned = async () =>
    (await fs.readFile(calls, "utf8").catch(() => "")).split("\n").filter(Boolean);

  beforeEach(async () => {
    bin = await fs.mkdtemp(path.join(os.tmpdir(), "finite-gh-"));
    calls = path.join(bin, "calls");
    vi.stubEnv("PATH", bin);
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => Response.json({ items: [item] }));
    vi.stubGlobal("fetch", fetchMock);
    // Each test starts with an empty cache and no remembered gh failure.
    vi.resetModules();
    ({ searchRepos } = await import("./repos.ts"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    await fs.rm(bin, { recursive: true, force: true });
  });

  it("maps gh's results to rows, with one read-only search and no prompts", async () => {
    await fakeGh(success);
    expect(await searchRepos("@hello world")).toEqual([row]);
    expect(await spawned()).toEqual([
      "prompt=1 [api][--hostname][github.com][--method][GET][search/repositories][-f][q=@hello world][-F][per_page=8]",
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("falls back to fetch when gh is missing, and doesn't look for it again", async () => {
    expect(await searchRepos("one")).toEqual([row]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe(
      "https://api.github.com/search/repositories?per_page=8&q=one",
    );
    await fakeGh(success);
    await searchRepos("two");
    expect(await spawned()).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("falls back when gh is logged out, and remembers it for a few minutes", async () => {
    await fakeGh(loggedOut);
    expect(await searchRepos("one")).toEqual([row]);
    await searchRepos("two");
    expect(await spawned()).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const later = Date.now() + 6 * 60_000;
    vi.spyOn(Date, "now").mockReturnValue(later);
    await fakeGh(success);
    await searchRepos("three");
    expect(await spawned()).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("falls back on an expired token", async () => {
    await fakeGh(`printf 'gh: Bad credentials (HTTP 401)\\n' >&2; exit 1`);
    expect(await searchRepos("one")).toEqual([row]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses on gh's rate limit without fetching, and tries gh again next time", async () => {
    await fakeGh(`printf 'gh: API rate limit exceeded for user ID 1. (HTTP 403)\\n' >&2; exit 1`);
    await expect(searchRepos("one")).rejects.toThrow(/search limit is reached/);
    await expect(searchRepos("two")).rejects.toThrow(/search limit is reached/);
    expect(await spawned()).toHaveLength(2);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses any other gh failure without fetching", async () => {
    await fakeGh(`printf 'gh: Server Error (HTTP 500)\\n' >&2; exit 1`);
    await expect(searchRepos("one")).rejects.toThrow(/Couldn't reach GitHub/);
    await fakeGh(`printf 'not json'`);
    await expect(searchRepos("two")).rejects.toThrow(/Couldn't reach GitHub/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps fetch's own refusals when gh can't help", async () => {
    fetchMock.mockResolvedValueOnce(new Response("", { status: 403 }));
    await expect(searchRepos("one")).rejects.toThrow(/search limit is reached/);
    fetchMock.mockResolvedValueOnce(new Response("", { status: 500 }));
    await expect(searchRepos("two")).rejects.toThrow(/Couldn't reach GitHub/);
  });

  it("answers a repeated query from the cache for a minute", async () => {
    await fakeGh(success);
    await searchRepos("one");
    expect(await searchRepos("one")).toEqual([row]);
    expect(await spawned()).toHaveLength(1);

    const later = Date.now() + 61_000;
    vi.spyOn(Date, "now").mockReturnValue(later);
    await searchRepos("one");
    expect(await spawned()).toHaveLength(2);
  });

  it("keeps the cache small, dropping the oldest search", async () => {
    await fakeGh(success);
    for (let i = 0; i < 33; i++) await searchRepos(`query ${i}`);
    expect(await spawned()).toHaveLength(33);
    await searchRepos("query 32");
    expect(await spawned()).toHaveLength(33);
    await searchRepos("query 0");
    expect(await spawned()).toHaveLength(34);
  });

  it("answers a pasted URL or owner/name without gh or the network", async () => {
    await fakeGh(success);
    expect(await searchRepos("https://github.com/acme/app")).toEqual([
      { name: "acme/app", url: "https://github.com/acme/app" },
    ]);
    expect(await searchRepos("acme/app")).toEqual([
      { name: "acme/app", url: "https://github.com/acme/app" },
    ]);
    expect(await spawned()).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("listDirs", () => {
  it("lists folders only, sorted, without hidden ones", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "finite-browse-"));
    try {
      await fs.mkdir(path.join(root, "b"));
      await fs.mkdir(path.join(root, "a"));
      await fs.mkdir(path.join(root, ".git"));
      await fs.writeFile(path.join(root, "file.txt"), "");
      expect(await listDirs(root)).toEqual({ path: root, dirs: ["a", "b"] });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("refuses a folder that isn't there", async () => {
    await expect(listDirs(path.join(os.tmpdir(), "finite-no-such-folder"))).rejects.toThrow(
      /Can't read/,
    );
  });
});

describe("design.clone", () => {
  let root: string;
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, stdio: "ignore" });
  const clone = (path: string, connect: (folder: string) => Promise<unknown>) =>
    handlers["design.clone"]({ url: "acme/app", path }, {
      modules: { store: { connect } },
    } as unknown as Context);

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "finite-clone-"));
    // A local repo stands in for github.com/acme/app.
    const repo = path.join(root, "remote", "acme", "app");
    await fs.mkdir(repo, { recursive: true });
    await fs.writeFile(path.join(repo, "README.md"), "hi");
    git(repo, "init", "-q");
    git(repo, "add", ".");
    git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
    vi.stubEnv("GIT_CONFIG_COUNT", "1");
    vi.stubEnv("GIT_CONFIG_KEY_0", `url.file://${path.join(root, "remote")}/.insteadOf`);
    vi.stubEnv("GIT_CONFIG_VALUE_0", "https://github.com/");
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("adds the repo's name under a path ending in /, and keeps a clone that connects", async () => {
    const connect = vi.fn(async (folder: string) => folder);
    await clone(`${root}/code/`, connect);
    const folder = path.join(root, "code", "app");
    expect(connect).toHaveBeenCalledWith(folder);
    expect(await fs.readdir(folder)).toContain("README.md");
  });

  it("deletes a clone that Finite refuses to connect", async () => {
    const folder = path.join(root, "app");
    const refusal = new Refused("Not a supported project.", "unsupported-project");
    await expect(
      clone(folder, async () => {
        throw refusal;
      }),
    ).rejects.toBe(refusal);
    await expect(fs.stat(folder)).rejects.toThrow();
  });

  it("refuses a folder with files in it and leaves them alone", async () => {
    await fs.writeFile(path.join(root, "keep.txt"), "mine");
    await expect(clone(root, vi.fn())).rejects.toThrow(/already has files/);
    expect(await fs.readFile(path.join(root, "keep.txt"), "utf8")).toBe("mine");
  });
});
