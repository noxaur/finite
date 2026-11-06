import { randomUUID } from "node:crypto";
import { copyFile, mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type AnyZodRawShape,
  createSdkMcpServer,
  type InferShape,
  tool,
} from "@anthropic-ai/claude-agent-sdk";
import {
  type Actor,
  type Canvas,
  canvasTools,
  type Frame,
  type OpenDesign,
  type Previews,
  Refused,
  type SourceEditor,
  type TextLabel,
  type ThreadMeta,
} from "@finite/protocol";
import type { Screenshots } from "./screenshot.ts";

type CallToolResult = Awaited<ReturnType<Parameters<typeof tool>[3]>>;

export const GAP = 80;
export const DEFAULT_SIZE = { width: 1440, height: 900 };
/** How far above its frame a label's top sits. */
export const LABEL_OFFSET = 120;
const NOTE_WIDTH = 480;

export type ToolContext = {
  open: OpenDesign;
  threadId: string;
  actor: Actor;
  previews: Previews;
  source: SourceEditor;
  screenshots: Screenshots;
  /** Allows production writes until the turn ends, and settles the thread if it succeeds. */
  grantProdWrite(): void;
  /** Starts a child thread with `prompt` as its first message. */
  spawn(prompt: string, canvasId: string | undefined): Promise<ThreadMeta>;
};

type Size = { width: number; height: number };
type Box = { x: number; y: number; width: number; height: number };

/**
 * Where new frames go: in a row starting right of `rightOf` (or the rightmost frame), top-aligned
 * with it, `GAP` apart, each pushed further right past any frame it would overlap.
 */
export function layoutRow(existing: Box[], sizes: Size[], rightOf?: Box): Box[] {
  const anchor =
    rightOf ??
    existing.reduce<Box | undefined>(
      (best, f) => (!best || f.x + f.width > best.x + best.width ? f : best),
      undefined,
    );
  const y = anchor ? anchor.y : 0;
  let x = anchor ? anchor.x + anchor.width + GAP : 0;
  const taken = [...existing];
  return sizes.map((size) => {
    let box = { x, y, ...size };
    for (let hit = overlap(taken, box); hit; hit = overlap(taken, box)) {
      box = { ...box, x: hit.x + hit.width + GAP };
    }
    taken.push(box);
    x = box.x + box.width + GAP;
    return box;
  });
}

function overlap(boxes: Box[], b: Box): Box | undefined {
  return boxes.find(
    (o) =>
      b.x < o.x + o.width + GAP &&
      o.x < b.x + b.width + GAP &&
      b.y - LABEL_OFFSET < o.y + o.height &&
      o.y - LABEL_OFFSET < b.y + b.height,
  );
}

export function boardDir(canvasId: string): string {
  return `.finite/boards/${canvasId}`;
}

/** The `finite` MCP server one thread's query talks to. */
export function canvasServer(ctx: ToolContext) {
  const { open, actor } = ctx;
  const design = open.design;

  async function canvas(canvasId: string): Promise<Canvas> {
    const found = (await open.canvases()).find((c) => c.id === canvasId && !c.removedAt);
    if (!found) {
      throw new Refused(`There's no canvas ${canvasId}. Call read_canvas to list the canvases.`);
    }
    return found;
  }

  async function meta(): Promise<ThreadMeta> {
    const found = (await open.threads()).find((t) => t.id === ctx.threadId);
    if (!found) throw new Refused(`Thread ${ctx.threadId} is gone.`);
    return found;
  }

  async function findFrame(frameId: string): Promise<{ canvas: Canvas; frame: Frame }> {
    for (const c of await open.canvases()) {
      const frame = c.frames.find((f) => f.id === frameId);
      if (frame && !c.removedAt) return { canvas: c, frame };
    }
    throw new Refused(`There's no frame ${frameId}. Call read_canvas to see the frames.`);
  }

  /** Links the canvas to this thread both ways. */
  async function link(canvasId: string): Promise<void> {
    await open.updateCanvas(
      canvasId,
      (c) =>
        c.threadIds.includes(ctx.threadId)
          ? c
          : { ...c, threadIds: [...c.threadIds, ctx.threadId] },
      actor,
    );
    await open.updateThread(ctx.threadId, (m) =>
      m.canvasIds.includes(canvasId)
        ? m
        : { ...m, canvasIds: [...m.canvasIds, canvasId], updatedAt: Date.now() },
    );
  }

  function describe(c: Canvas) {
    return {
      id: c.id,
      name: c.name,
      kind: c.kind,
      ...(c.kind === "prototype" ? { boardDir: boardDir(c.id) } : {}),
      frames: c.frames.map(({ id, name, x, y, width, height, source }) => ({
        id,
        name,
        x,
        y,
        width,
        height,
        source,
      })),
      texts: c.texts.map(({ id, title, body, x, y, width }) => ({ id, title, body, x, y, width })),
      comments: c.comments
        .filter((m) => !m.resolvedAt)
        .map((m) => ({
          id: m.id,
          anchor: m.anchor,
          author: m.author.name,
          text: m.text,
          replies: m.replies.map((r) => `${r.author.name}: ${r.text}`),
        })),
    };
  }

  /** Below everything on the canvas, at the left edge. */
  function belowAll(c: Canvas): { x: number; y: number } {
    const bottoms = [
      ...c.frames.map((f) => f.y + f.height),
      ...c.texts.map((t) => t.y + LABEL_OFFSET),
    ];
    return { x: 0, y: bottoms.length ? Math.max(...bottoms) + GAP : 0 };
  }

  const tools = [
    safeTool(
      "read_canvas",
      "Reads a canvas: its frames (with their TSX files), text labels and open comments. Without canvasId it reads this thread's latest canvas, or lists every canvas when the thread has none.",
      canvasTools.read_canvas,
      async ({ canvasId }) => {
        const id = canvasId ?? (await meta()).canvasIds.at(-1);
        if (id === undefined) {
          const all = (await open.canvases()).filter((c) => !c.removedAt);
          return json({
            canvases: all.map((c) => ({
              id: c.id,
              name: c.name,
              kind: c.kind,
              frames: c.frames.length,
            })),
            hint: "This thread has no canvas yet. open_canvas makes one.",
          });
        }
        return json(describe(await canvas(id)));
      },
    ),

    safeTool(
      "open_canvas",
      'Opens the canvas with this name (a page such as "Brand", or a prototype), or makes a new prototype canvas, and links it to this thread.',
      canvasTools.open_canvas,
      async ({ name }) => {
        const all = (await open.canvases()).filter((c) => !c.removedAt);
        const found =
          all.find((c) => c.name === name) ??
          all.find((c) => c.name.toLowerCase() === name.toLowerCase()) ??
          (await open.createCanvas({ kind: "prototype", name, threadId: ctx.threadId }, actor));
        await link(found.id);
        return json(describe(await canvas(found.id)));
      },
    ),

    safeTool(
      "place_frames",
      `Puts TSX files on a canvas as frames, in a row right of rightOf (a frame id) or of the rightmost frame, with a title and why label above each. Files are paths under ${boardDir("<canvasId>")}/ (or relative to it) with a default-exported component. Default size ${DEFAULT_SIZE.width}×${DEFAULT_SIZE.height}.`,
      canvasTools.place_frames,
      async ({ canvasId, frames, rightOf }) => {
        const c = await canvas(canvasId);
        const board = boardDir(canvasId);
        const files = await Promise.all(
          frames.map(async (f) => {
            const rel = path.posix.normalize(
              f.file.startsWith(".finite/") ? f.file : path.posix.join(board, f.file),
            );
            if (!rel.startsWith(".finite/")) {
              throw new Refused(`${f.file} isn't a prototype file. Write it under ${board}/.`);
            }
            const exists = await stat(path.join(design.root, rel)).then(
              (s) => s.isFile(),
              () => false,
            );
            if (!exists) throw new Refused(`${rel} doesn't exist. Write it first.`);
            return rel;
          }),
        );
        const anchor = rightOf === undefined ? undefined : c.frames.find((f) => f.id === rightOf);
        if (rightOf !== undefined && !anchor) {
          throw new Refused(`There's no frame ${rightOf} on ${c.name}. Call read_canvas.`);
        }
        const boxes = layoutRow(
          c.frames,
          frames.map((f) => ({
            width: f.width ?? DEFAULT_SIZE.width,
            height: f.height ?? DEFAULT_SIZE.height,
          })),
          anchor,
        );
        const placed: Frame[] = frames.map((f, i) => ({
          id: randomUUID(),
          name: f.name,
          ...boxes[i]!,
          source: { kind: "file", file: files[i]! },
        }));
        await open.patchCanvas(canvasId, { op: "addFrames", frames: placed }, actor);
        for (const [i, frame] of placed.entries()) {
          const text: TextLabel = {
            id: randomUUID(),
            x: frame.x,
            y: frame.y - LABEL_OFFSET,
            width: frame.width,
            title: frames[i]!.title,
            body: frames[i]!.why,
            author: actor,
          };
          await open.patchCanvas(canvasId, { op: "setText", text }, actor);
        }
        return json({
          placed: placed.map(({ id, name, x, y, width, height, source }) => ({
            id,
            name,
            x,
            y,
            width,
            height,
            source,
          })),
          next: "Check each frame with screenshot and frame_errors.",
        });
      },
    ),

    safeTool(
      "write_text",
      "Writes a text label (title + body) on a canvas, or rewrites the one with textId. Without x/y it goes below everything else.",
      canvasTools.write_text,
      async ({ canvasId, textId, title, body, x, y, width }) => {
        const c = await canvas(canvasId);
        const old = textId === undefined ? undefined : c.texts.find((t) => t.id === textId);
        if (textId !== undefined && !old) {
          throw new Refused(`There's no text ${textId} on ${c.name}. Leave textId out to add one.`);
        }
        const at = belowAll(c);
        const text: TextLabel = {
          id: old?.id ?? randomUUID(),
          x: x ?? old?.x ?? at.x,
          y: y ?? old?.y ?? at.y,
          width: width ?? old?.width ?? NOTE_WIDTH,
          title,
          body,
          author: actor,
        };
        await open.patchCanvas(canvasId, { op: "setText", text }, actor);
        return json({ textId: text.id, x: text.x, y: text.y });
      },
    ),

    safeTool(
      "comment",
      "Pins a comment on a frame, or on one element in it (loc = file:line:col from a selection or the source; index = which rendered instance of loc, from the selection). Use it to point people at what you changed or what you need from them.",
      canvasTools.comment,
      async ({ frameId, loc, index, text }) => {
        const { canvas: c } = await findFrame(frameId);
        const id = randomUUID();
        await open.updateCanvas(
          c.id,
          (cv) => ({
            ...cv,
            comments: [
              ...cv.comments,
              {
                id,
                anchor: {
                  frameId,
                  ...(loc === undefined ? {} : { loc }),
                  ...(loc === undefined || index === undefined ? {} : { index }),
                },
                author: actor,
                text,
                replies: [],
                createdAt: Date.now(),
              },
            ],
          }),
          actor,
        );
        return json({ commentId: id, canvasId: c.id });
      },
    ),

    safeTool(
      "copy_production",
      "Copies one production component (by name) or route file (by path) onto the board as a TSX file whose imports still point at production. Then place_frames it.",
      canvasTools.copy_production,
      async ({ canvasId, name, route }) => {
        await canvas(canvasId);
        if ((name === undefined) === (route === undefined)) {
          throw new Refused(
            "Give exactly one of name (a component) and route (a path like /cart).",
          );
        }
        const base = name ?? routeName(route!);
        const toFile = `${boardDir(canvasId)}/${base}.tsx`;
        const { file } = await ctx.source.copyComponent(
          design,
          name === undefined ? { route: route! } : { name },
          toFile,
        );
        return json({ file, next: `place_frames with file "${file}"` });
      },
    ),

    safeTool(
      "move_to_prod",
      "Call only when a person asks to move, ship or get these frames to production. Allows Write/Edit on production files until this turn ends; then edit production to match the frames in production's conventions. The thread settles when the turn succeeds.",
      canvasTools.move_to_prod,
      async ({ frameIds }) => {
        const frames = await Promise.all(frameIds.map(findFrame));
        ctx.grantProdWrite();
        return json({
          allowed: "Production Write/Edit is on until this turn ends.",
          frames: frames.map(({ frame }) => ({
            id: frame.id,
            name: frame.name,
            source: frame.source,
          })),
          next: "Change the production files to match. Reuse production components and tokens.",
        });
      },
    ),

    safeTool(
      "add_brand_asset",
      `Copies a file (path relative to the project, or absolute) or downloads a URL into the brand folder (${design.brandDir}) and lists it on the Brand page.`,
      canvasTools.add_brand_asset,
      async ({ path: from, url, kind }) => {
        if ((from === undefined) === (url === undefined)) {
          throw new Refused("Give exactly one of path and url.");
        }
        const dir = path.join(design.root, design.brandDir);
        await mkdir(dir, { recursive: true });
        let name: string;
        if (from !== undefined) {
          const src = path.resolve(design.root, from);
          name = path.basename(src);
          await copyFile(src, path.join(dir, name));
        } else {
          const res = await fetch(url!);
          if (!res.ok) throw new Refused(`${url} answered ${res.status}. Check the URL.`);
          name = path.posix.basename(new URL(url!).pathname) || `asset${extension(res)}`;
          await writeFile(path.join(dir, name), new Uint8Array(await res.arrayBuffer()));
        }
        const rel = path.posix.join(design.brandDir, name);
        const all = await open.canvases();
        const brand =
          all.find((c) => c.kind === "page" && c.name === "Brand" && !c.removedAt) ??
          (await open.createCanvas({ kind: "page", name: "Brand" }, actor));
        const at = belowAll(await canvas(brand.id));
        await open.patchCanvas(
          brand.id,
          {
            op: "setText",
            text: {
              id: randomUUID(),
              ...at,
              width: NOTE_WIDTH,
              title: name,
              body: `${kind} · ${rel}`,
              author: actor,
            },
          },
          actor,
        );
        return json({ file: rel, brandCanvasId: brand.id });
      },
    ),

    safeTool(
      "spawn_thread",
      "Starts another agent on a side task in a child thread of this one, optionally on a canvas. It starts right away with prompt as its first message.",
      canvasTools.spawn_thread,
      async ({ prompt, canvasId }) => {
        if (canvasId !== undefined) await canvas(canvasId);
        const child = await ctx.spawn(prompt, canvasId);
        return json({ threadId: child.id, title: child.title });
      },
    ),

    safeTool(
      "name_thread",
      "Names this thread, and its prototype canvas, in the prototypes list: 2–4 words about what it's for.",
      canvasTools.name_thread,
      async ({ title }) => {
        const thread = await open.updateThread(ctx.threadId, (m) => ({
          ...m,
          title,
          updatedAt: Date.now(),
        }));
        // A prototype is its thread and first canvas, so the canvas takes the name too.
        const first = (await open.canvases()).find((c) => c.id === thread.canvasIds[0]);
        if (first?.kind === "prototype" && first.name !== title) {
          await open.updateCanvas(first.id, (c) => ({ ...c, name: title }), actor);
        }
        return json({ title });
      },
    ),

    safeTool(
      "screenshot",
      "Renders a frame at its size and returns a PNG, so you can see what people see.",
      canvasTools.screenshot,
      async ({ frameId }) => {
        const { frame } = await findFrame(frameId);
        await ctx.previews.ensure(design);
        const url = ctx.previews.frameUrl(design.id, frame.source);
        const png = await ctx.screenshots.capture(url, frame.width, frame.height);
        return {
          content: [
            { type: "image", data: Buffer.from(png).toString("base64"), mimeType: "image/png" },
          ],
        };
      },
    ),

    safeTool(
      "frame_errors",
      "Lists the runtime errors, unhandled rejections and console errors a frame reported.",
      canvasTools.frame_errors,
      async ({ frameId }) => {
        await findFrame(frameId);
        const errors = ctx.previews.errors(design.id, frameId);
        if (errors.length === 0) return text("No errors.");
        return json(errors.map(({ kind, message, stack }) => ({ kind, message, stack })));
      },
    ),
  ];

  return createSdkMcpServer({ name: "finite", version: "1.0.0", tools, alwaysLoad: true });
}

/** A tool whose refusals and failures come back as a tool error the agent reads. */
function safeTool<S extends AnyZodRawShape>(
  name: string,
  description: string,
  shape: S,
  handler: (args: InferShape<S>) => Promise<CallToolResult>,
) {
  return tool(name, description, shape, async (args) => {
    try {
      return await handler(args);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ...text(message), isError: true };
    }
  });
}

function text(value: string): CallToolResult {
  return { content: [{ type: "text", text: value }] };
}

function json(value: unknown): CallToolResult {
  return text(JSON.stringify(value));
}

/** `/` → Home, `/cart/:id` → CartId. */
function routeName(route: string): string {
  const words = route.split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (words.length === 0) return "Home";
  return words.map((w) => w[0]!.toUpperCase() + w.slice(1)).join("");
}

function extension(res: Response): string {
  const type = res.headers.get("content-type") ?? "";
  const ext = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/svg+xml": ".svg",
    "image/webp": ".webp",
  }[type.split(";")[0]!.trim()];
  return ext ?? "";
}
