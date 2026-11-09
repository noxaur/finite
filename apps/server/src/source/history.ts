import { Refused } from "@finite/protocol";

/** One file's change: `before` became `after` at offset `at`. Spans are whole lines plus a line of context each side. */
export type Patch = {
  file: string;
  before: string;
  after: string;
  at: number;
  /** The change made the file, so undoing it deletes the file and redoing it starts from nothing. */
  created?: boolean;
};

/** The smallest whole-line span that turns `oldCode` into `newCode`, or undefined when they're equal. */
export function diffPatch(file: string, oldCode: string, newCode: string): Patch | undefined {
  if (oldCode === newCode) return undefined;
  const max = Math.min(oldCode.length, newCode.length);
  let prefix = 0;
  while (prefix < max && oldCode[prefix] === newCode[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < max - prefix &&
    oldCode[oldCode.length - 1 - suffix] === newCode[newCode.length - 1 - suffix]
  )
    suffix++;

  let start = oldCode.lastIndexOf("\n", prefix - 1) + 1;
  if (start > 0) start = oldCode.lastIndexOf("\n", start - 2) + 1;
  let end = oldCode.length - suffix;
  for (let lines = 0; lines < 2 && end < oldCode.length; lines++) {
    const nl = oldCode.indexOf("\n", end);
    end = nl === -1 ? oldCode.length : nl + 1;
  }
  const delta = newCode.length - oldCode.length;
  return {
    file,
    before: oldCode.slice(start, end),
    after: newCode.slice(start, end + delta),
    at: start,
  };
}

/**
 * Swaps `from` for `to` in `code`: at `at` when it's still there, else wherever it appears once.
 * Undefined when `from` is gone or ambiguous (someone changed that part of the file since).
 */
export function swap(
  code: string,
  from: string,
  to: string,
  at: number,
): { code: string; at: number } | undefined {
  let index = code.startsWith(from, at) ? at : -1;
  if (index === -1) {
    const first = code.indexOf(from);
    if (first === -1 || code.indexOf(from, first + 1) !== -1) return undefined;
    index = first;
  }
  return { code: code.slice(0, index) + to + code.slice(index + from.length), at: index };
}

type Entry = { patches: Patch[] };

/** Undo and redo stacks per design and actor. A new change clears that actor's redo stack. */
export function createHistory(limit = 100) {
  const stacks = new Map<string, { undo: Entry[]; redo: Entry[] }>();
  const stack = (key: string) => {
    let s = stacks.get(key);
    if (!s) stacks.set(key, (s = { undo: [], redo: [] }));
    return s;
  };

  return {
    push(key: string, patches: Patch[]): void {
      const s = stack(key);
      s.undo.push({ patches });
      if (s.undo.length > limit) s.undo.shift();
      s.redo = [];
    },
    /**
     * Pops the next step and hands it to `run`, which applies it and returns the patches as they
     * now stand. A refused step is dropped, so the next undo reaches further back.
     */
    async step(
      key: string,
      direction: "undo" | "redo",
      run: (patches: Patch[]) => Promise<Patch[]>,
    ): Promise<void> {
      const s = stack(key);
      const entry = s[direction].pop();
      if (!entry) throw new Refused(`Nothing to ${direction}`, "not-found");
      const patches = await run(entry.patches);
      s[direction === "undo" ? "redo" : "undo"].push({ patches });
    },
  };
}

/** Applies `patches` backwards (undo) or forwards (redo) to the given file contents. */
export function stepPatches(
  contents: Map<string, string>,
  patches: Patch[],
  direction: "undo" | "redo",
): { contents: Map<string, string>; patches: Patch[] } {
  const out = new Map(contents);
  const moved: Patch[] = [];
  for (const patch of direction === "undo" ? [...patches].reverse() : patches) {
    const [from, to] =
      direction === "undo" ? [patch.after, patch.before] : [patch.before, patch.after];
    const code = out.get(patch.file);
    const result = code === undefined ? undefined : swap(code, from, to, patch.at);
    if (!result) {
      throw new Refused(
        `${patch.file} changed in the same place since, so Finite can't ${direction} this step. It was skipped; ${direction} again to go further back, or ask the agent.`,
        "stale",
      );
    }
    out.set(patch.file, result.code);
    moved.push({ ...patch, at: result.at });
  }
  return { contents: out, patches: direction === "undo" ? moved.reverse() : moved };
}
