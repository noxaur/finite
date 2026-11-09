import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  type Actor,
  Canvas,
  type Design,
  type DesignChange,
  type OpenDesign,
  Refused,
  ThreadEvent,
  ThreadMeta,
} from "@finite/protocol";
import type { z } from "zod";
import { applyPatch, inversePatch, moveFramesTo, overwritten, type Step } from "./canvas.ts";
import { readText, serial, toJson, writeAtomic } from "./files.ts";

/** A removed canvas is kept this long, then deleted when the design opens. */
export const REMOVED_KEEP_MS = 30 * 24 * 60 * 60 * 1000;
/** The error a thread gets when Finite stopped in the middle of its turn. */
export const INTERRUPTED_BY_RESTART =
  "Finite stopped while this turn was running, so it was cut off. Send a message to pick it up again.";
/** How many canvas patches each person can undo per canvas. */
const UNDO_DEPTH = 100;
/** How long external edits to `.finite/` settle before they're read back. */
const WATCH_DEBOUNCE_MS = 100;

export type OpenedDesign = OpenDesign & {
  /** Sends a change to every listener. The store also uses it for install progress. */
  emit(change: DesignChange): void;
  /**
   * Replaces the design's fields in place (same root), after setup rewrote its row or config, so
   * everyone holding `design` sees the change.
   */
  setDesign(next: Design): void;
  close(): void;
};

/** Loads `<root>/.finite/`: canvases and thread metadata stay in memory, files are the truth. */
export async function openDesign(design: Design): Promise<OpenedDesign> {
  const dir = path.join(design.root, ".finite");
  const canvasDir = path.join(dir, "canvases");
  const threadDir = path.join(dir, "threads");
  await Promise.all([
    fsp.mkdir(canvasDir, { recursive: true }),
    fsp.mkdir(threadDir, { recursive: true }),
  ]);

  const run = serial();
  const listeners = new Set<(change: DesignChange) => void>();
  /** The text each file had when this process last read or wrote it, to tell external edits apart. */
  const known = new Map<string, string>();
  const canvases = new Map<string, Canvas>();
  const threads = new Map<string, ThreadMeta>();

  /** Per canvas and actor: the steps that undo their patches, and the ones that redo their undos. */
  const stacks = new Map<string, { undo: Step[]; redo: Step[] }>();
  const stackOf = (canvasId: string, by: Actor) => {
    const key = `${canvasId}\u0000${by.kind}:${by.id}`;
    let stack = stacks.get(key);
    if (!stack) stacks.set(key, (stack = { undo: [], redo: [] }));
    return stack;
  };
  const push = (list: Step[], step: Step) => {
    list.push(step);
    if (list.length > UNDO_DEPTH) list.shift();
  };

  const canvasFile = (id: string) => path.join(canvasDir, `${safeId(id)}.json`);
  const threadFile = (id: string) => path.join(threadDir, `${safeId(id)}.json`);
  const eventsFile = (id: string) => path.join(threadDir, `${safeId(id)}.jsonl`);

  async function save(file: string, value: unknown) {
    const text = toJson(value);
    await writeAtomic(file, text);
    known.set(file, text);
  }

  function emit(change: DesignChange) {
    for (const fn of listeners) {
      try {
        fn(change);
      } catch (error) {
        console.error("a design listener failed:", error);
      }
    }
  }

  /** Reads one canvas or thread file; `undefined` when it's gone or isn't valid. */
  async function load<T>(file: string, schema: z.ZodType<T>): Promise<T | undefined> {
    const text = await readText(file);
    if (text === undefined) return undefined;
    known.set(file, text);
    try {
      const parsed = schema.safeParse(JSON.parse(text));
      if (parsed.success) return parsed.data;
    } catch {
      // Not JSON; reported below.
    }
    console.warn(`skipping ${file}: it isn't a valid ${path.basename(path.dirname(file))} file`);
    return undefined;
  }

  const now = Date.now();
  for (const name of await fsp.readdir(canvasDir)) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(canvasDir, name);
    const canvas = await load<Canvas>(file, Canvas);
    if (!canvas) continue;
    if (canvas.removedAt !== undefined && now - canvas.removedAt > REMOVED_KEEP_MS) {
      await fsp.rm(file, { force: true });
      continue;
    }
    canvases.set(canvas.id, canvas);
  }
  for (const name of await fsp.readdir(threadDir)) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(threadDir, name);
    const meta = await load<ThreadMeta>(file, ThreadMeta);
    if (!meta) continue;
    // No session outlives this process, so a thread still marked running was cut off by a crash.
    if (meta.running) {
      const stopped = { ...meta, running: false, awaitingSince: now, updatedAt: now };
      const cutOff: ThreadEvent = { type: "error", message: INTERRUPTED_BY_RESTART, at: now };
      await fsp.appendFile(eventsFile(meta.id), `${JSON.stringify(cutOff)}\n`);
      await save(file, stopped);
      threads.set(meta.id, stopped);
    } else threads.set(meta.id, meta);
  }

  function canvasOf(id: string): Canvas {
    const canvas = canvases.get(id);
    if (!canvas) throw new Refused(`no canvas ${id} in this design`, "not-found");
    return canvas;
  }
  function threadOf(id: string): ThreadMeta {
    const meta = threads.get(id);
    if (!meta) throw new Refused(`no thread ${id} in this design`, "not-found");
    return meta;
  }

  async function putCanvas(next: Canvas): Promise<Canvas> {
    const canvas = Canvas.parse({ ...next, updatedAt: Date.now() });
    await save(canvasFile(canvas.id), canvas);
    canvases.set(canvas.id, canvas);
    emit({ type: "canvas", canvas });
    return canvas;
  }
  async function putThread(next: ThreadMeta): Promise<ThreadMeta> {
    const meta = ThreadMeta.parse(next);
    await save(threadFile(meta.id), meta);
    threads.set(meta.id, meta);
    emit({ type: "thread", meta });
    return meta;
  }

  /** Applies one patch; returns the canvas it named and the step that takes it back. */
  async function apply({ canvasId, patch, found }: Step): Promise<{ canvas: Canvas; step: Step }> {
    const canvas = canvasOf(canvasId);
    // Applying first refuses a patch that doesn't fit, before its inverse is worked out.
    if (patch.op !== "moveFramesTo") {
      const next = applyPatch(canvas, patch);
      if (found !== undefined && !isDeepStrictEqual(overwritten(canvas, patch), found)) {
        throw new Refused("it no longer has the value this step left", "stale");
      }
      const step = inversePatch(canvas, patch);
      const saved = await putCanvas(next);
      return { canvas: saved, step: { ...step, found: overwritten(saved, step.patch) } };
    }
    const moved = moveFramesTo(canvas, canvasOf(patch.toCanvasId), patch.frameIds);
    const step = inversePatch(canvas, patch);
    await putCanvas(moved.to);
    return { canvas: await putCanvas(moved.from), step };
  }

  // Git pulls and editors change these folders too; read back what changed and pass it on.
  const timers = new Map<string, NodeJS.Timeout>();
  const watchers = [canvasDir, threadDir].map((folder) => {
    const watcher = fs.watch(folder, (_event, name) => {
      if (!name || !name.endsWith(".json")) return;
      const file = path.join(folder, name);
      clearTimeout(timers.get(file));
      timers.set(
        file,
        setTimeout(() => {
          timers.delete(file);
          void run(() => reread(file)).catch((error: unknown) =>
            console.error(`reading ${file} failed:`, error),
          );
        }, WATCH_DEBOUNCE_MS).unref(),
      );
    });
    watcher.on("error", (error) => console.error(`watching ${folder} failed:`, error));
    watcher.unref();
    return watcher;
  });

  async function reread(file: string) {
    const text = await readText(file);
    if (text === undefined || text === known.get(file)) return;
    if (path.dirname(file) === canvasDir) {
      const canvas = await load<Canvas>(file, Canvas);
      if (!canvas) return;
      canvases.set(canvas.id, canvas);
      emit({ type: "canvas", canvas });
    } else {
      const meta = await load<ThreadMeta>(file, ThreadMeta);
      if (!meta) return;
      threads.set(meta.id, meta);
      emit({ type: "thread", meta });
    }
  }

  const open: OpenedDesign = {
    design,
    emit,

    setDesign(next) {
      for (const key of Object.keys(design)) delete (design as Record<string, unknown>)[key];
      Object.assign(design, next);
    },

    async canvases() {
      // A canvas a git pull adds may be older than the ones already here.
      return [...canvases.values()].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
    },

    createCanvas({ kind, name, threadId }, _by) {
      return run(async () => {
        const id = randomUUID();
        if (threadId !== undefined) {
          const meta = threadOf(threadId);
          await putThread({ ...meta, canvasIds: [...meta.canvasIds, id], updatedAt: Date.now() });
        }
        return putCanvas({
          id,
          kind,
          name,
          threadIds: threadId === undefined ? [] : [threadId],
          frames: [],
          texts: [],
          comments: [],
          sections: [],
          slices: [],
          // Strictly after every other canvas, so pages made in the same millisecond keep their order.
          createdAt: Math.max(
            Date.now(),
            ...[...canvases.values()].map((c) => (c.createdAt ?? 0) + 1),
          ),
          updatedAt: Date.now(),
        });
      });
    },

    patchCanvas(canvasId, patch, by) {
      return run(async () => {
        const { step, canvas } = await apply({ canvasId, patch });
        const stack = stackOf(canvasId, by);
        push(stack.undo, step);
        stack.redo = [];
        return canvas;
      });
    },

    undoCanvas(canvasId, by, redo = false) {
      return run(async () => {
        canvasOf(canvasId);
        const stack = stackOf(canvasId, by);
        const from = redo ? stack.redo : stack.undo;
        const step = from.pop();
        if (!step) {
          throw new Refused(
            redo ? "Nothing to redo on this canvas." : "Nothing to undo on this canvas.",
            "not-found",
          );
        }
        try {
          const applied = await apply(step);
          push(redo ? stack.undo : stack.redo, applied.step);
          return canvasOf(canvasId);
        } catch (error) {
          if (!(error instanceof Refused)) throw error;
          throw new Refused(
            `Can't ${redo ? "redo" : "undo"} that: ${error.message}. Someone else changed it since. It was skipped; ${redo ? "redo" : "undo"} again to go further back.`,
            error.code,
          );
        }
      });
    },

    updateCanvas(canvasId, fn, _by) {
      return run(async () => {
        const canvas = canvasOf(canvasId);
        const next = fn(canvas);
        // Returning the canvas itself means nothing changed.
        if (next === canvas) return canvas;
        return putCanvas({ ...next, id: canvas.id });
      });
    },

    async threads() {
      return [...threads.values()];
    },

    createThread(init) {
      return run(async () => {
        const at = Date.now();
        return putThread({
          title: "New thread",
          canvasIds: [],
          ...init,
          id: randomUUID(),
          running: false,
          queued: [],
          createdAt: at,
          updatedAt: at,
        });
      });
    },

    updateThread(threadId, fn) {
      return run(async () => {
        const meta = threadOf(threadId);
        return putThread({ ...fn(meta), id: meta.id });
      });
    },

    async appendEvent(threadId, event) {
      if (event.type !== "text.delta") {
        await run(async () => {
          threadOf(threadId);
          await fsp.appendFile(eventsFile(threadId), `${JSON.stringify(event)}\n`);
        });
      }
      emit({ type: "thread.event", threadId, event });
    },

    async history(threadId) {
      threadOf(threadId);
      const text = (await readText(eventsFile(threadId))) ?? "";
      const events: ThreadEvent[] = [];
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
          const parsed = ThreadEvent.safeParse(JSON.parse(line));
          if (parsed.success) events.push(parsed.data);
        } catch {
          // A line cut short by a crash; skip it.
        }
      }
      return events;
    },

    async saveAttachment(name, data) {
      const clean =
        path
          .basename(name)
          .replace(/[^\w.-]+/g, "_")
          .replace(/^\.+/, "") || "file";
      const rel = path.posix.join(".finite", "attachments", `${randomUUID().slice(0, 8)}-${clean}`);
      await writeAtomic(path.join(design.root, rel), data);
      return { path: rel };
    },

    on(fn) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },

    close() {
      for (const watcher of watchers) watcher.close();
      for (const timer of timers.values()) clearTimeout(timer);
      listeners.clear();
    },
  };
  return open;
}

/** Ids name files, so keep them to one path segment. */
function safeId(id: string): string {
  if (!/^[\w-]+$/.test(id)) throw new Refused(`${JSON.stringify(id)} isn't a valid id`, "invalid");
  return id;
}
