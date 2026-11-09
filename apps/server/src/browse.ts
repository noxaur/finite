import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Refused } from "@finite/protocol";

/** `~` and `~/x` mean the home folder; anything else is resolved from the server's working folder. */
export function expandHome(input: string): string {
  if (input === "~") return os.homedir();
  if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
  return path.resolve(input);
}

/** The folders inside `input`, sorted, with hidden ones left out. */
export async function listDirs(input: string): Promise<{ path: string; dirs: string[] }> {
  const dir = expandHome(input);
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => {
    throw new Refused(`Can't read ${input}. Check that the folder exists.`, "invalid");
  });
  const dirs: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    // A symlink to a folder counts as one.
    const isDir =
      entry.isDirectory() ||
      (entry.isSymbolicLink() &&
        (await fs.stat(path.join(dir, entry.name)).catch(() => null))?.isDirectory());
    if (isDir) dirs.push(entry.name);
  }
  return { path: dir, dirs: dirs.sort((a, b) => a.localeCompare(b)) };
}
