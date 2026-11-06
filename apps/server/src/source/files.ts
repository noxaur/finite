import { createHash, randomBytes } from "node:crypto";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Refused } from "@finite/protocol";

/** The first 8 hex digits of the sha1 of a file's source, as the Vite plugin stamps it. */
export function rev(code: string): string {
  return createHash("sha1").update(code).digest("hex").slice(0, 8);
}

/** The absolute path of `file` (posix, relative to `root`). Refuses paths that leave the root. */
export function inRoot(root: string, file: string): string {
  const abs = path.resolve(root, file);
  const rel = path.relative(root, abs);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Refused(`${file} is outside the design's folder`, "invalid");
  }
  return abs;
}

export function posixRelative(root: string, abs: string): string {
  return path.relative(root, abs).split(path.sep).join("/");
}

export async function readText(abs: string): Promise<string | undefined> {
  try {
    return await readFile(abs, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function mustRead(root: string, file: string): Promise<string> {
  const code = await readText(inRoot(root, file));
  if (code === undefined) throw new Refused(`${file} doesn't exist`, "not-found");
  return code;
}

/** Writes through a temp file and a rename, so a reader never sees half a file. */
export async function writeAtomic(abs: string, contents: string): Promise<void> {
  await mkdir(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.${randomBytes(4).toString("hex")}.finite-tmp`;
  try {
    await writeFile(tmp, contents);
    await rename(tmp, abs);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}

/** A mutex per absolute path. `locked` takes every lock in sorted order, so two callers can't deadlock. */
export function createLocks() {
  const tails = new Map<string, Promise<void>>();

  async function lockOne(key: string): Promise<() => void> {
    const prev = tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => (release = resolve));
    const tail = prev.then(() => next);
    tails.set(key, tail);
    await prev;
    return () => {
      release();
      if (tails.get(key) === tail) tails.delete(key);
    };
  }

  return async function locked<T>(paths: string[], fn: () => Promise<T>): Promise<T> {
    const releases: (() => void)[] = [];
    try {
      for (const key of [...new Set(paths)].sort()) releases.push(await lockOne(key));
      return await fn();
    } finally {
      for (const release of releases.reverse()) release();
    }
  };
}

export type Locked = ReturnType<typeof createLocks>;

/** Picks `dir/name.ext`, or `dir/name-2.ext`, … if that's taken. */
export async function freeName(abs: string): Promise<string> {
  const ext = path.extname(abs);
  const base = abs.slice(0, abs.length - ext.length);
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? abs : `${base}-${n}${ext}`;
    try {
      await access(candidate);
    } catch {
      return candidate;
    }
  }
}
