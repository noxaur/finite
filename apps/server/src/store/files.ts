import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

/** Writes through a temp file and a rename, so a reader never sees half a file. */
export async function writeAtomic(file: string, data: string | Uint8Array): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID().slice(0, 8)}.tmp`;
  try {
    await fs.writeFile(temp, data);
    await fs.rename(temp, file);
  } catch (error) {
    await fs.rm(temp, { force: true });
    throw error;
  }
}

/** Formats JSON the way every `.finite` file is written, so git diffs stay small. */
export function toJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** The file's text, or `undefined` when it doesn't exist. */
export async function readText(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function readJson(file: string): Promise<unknown> {
  const text = await readText(file);
  return text === undefined ? undefined : (JSON.parse(text) as unknown);
}

export async function exists(file: string): Promise<boolean> {
  return fs.stat(file).then(
    () => true,
    () => false,
  );
}

/** Runs tasks one at a time, in order. A failed task doesn't stop the ones after it. */
export function serial() {
  let tail: Promise<unknown> = Promise.resolve();
  return function run<T>(task: () => Promise<T>): Promise<T> {
    const result = tail.then(task);
    tail = result.catch(() => {});
    return result;
  };
}
