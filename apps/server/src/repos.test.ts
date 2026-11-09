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
