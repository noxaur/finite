import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
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
  type CanvasToolInput,
  canvasTools,
  type Design,
  type Frame,
  type OpenDesign,
  type Previews,
  Refused,
  type SourceEditor,
  type TextLabel,
  type ThreadMeta,
} from "@finite/protocol";
import { inRoot } from "../source/files.ts";
import { snapLoc } from "../source/jsx.ts";
import { ensureBrandBoard } from "../store/brand.ts";
import type { Region, Screenshots } from "./screenshot.ts";

type CallToolResult = Awaited<ReturnType<Parameters<typeof tool>[3]>>;

export const GAP = 80;
/** A hugging frame's size when its content can't be measured (no Chrome, preview down). */
export const DEFAULT_SIZE = { width: 480, height: 320 };
/** The smallest a hugging frame gets, so a lone button still reads as a frame. */
export const MIN_HUG = { width: 200, height: 120 };
/** How far above its frame a label's top sits. */
export const LABEL_OFFSET = 120;
const NOTE_WIDTH = 480;
/** Room a section built around frames leaves on every side. */
const SECTION_PAD = 40;
const MAX_HUG_WIDTH = 1920;

/** What the canvas operations work with, whoever calls them. */
export type CanvasContext = {
  open: OpenDesign;
  actor: Actor;
  previews: Previews;
  source: SourceEditor;
  screenshots: Screenshots;
};

export type ToolContext = CanvasContext & {
  threadId: string;
  /** Allows production writes until the turn ends, and settles the thread if it succeeds. */
  grantProdWrite(): void;
  /** Starts a child thread with `prompt` as its first message. */
  spawn(prompt: string, canvasId: string | undefined): Promise<ThreadMeta>;
  /** Connects finite.json's apps, or refuses with what to fix; then starts the next preview. */
  finishSetup(): Promise<object>;
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

/**
 * A new frame's size: what place_frames was given, the rest measured from its rendered content
 * (natural width without `width`), and never smaller than `MIN_HUG`.
 */
export async function frameSize(
  f: { width?: number | undefined; height?: number | undefined },
  measure: (width: number | undefined) => Promise<Size>,
): Promise<Size> {
  if (f.width !== undefined && f.height !== undefined) return { width: f.width, height: f.height };
  let measured: Size = { width: f.width ?? DEFAULT_SIZE.width, height: DEFAULT_SIZE.height };
  try {
    measured = await measure(f.width);
  } catch {
    // Unmeasured: the canvas still sizes a hugging frame's height once it renders.
  }
  return {
    width: f.width ?? Math.min(MAX_HUG_WIDTH, Math.max(MIN_HUG.width, measured.width)),
    height: f.height ?? Math.max(MIN_HUG.height, measured.height),
  };
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

/**
 * A path an agent gave, relative to the root. The agent works from the workspace root, so a path
 * that's relative to it and lands in the app's folder (`apps/web/src/x.tsx`) is taken too.
 */
export function rootRelative(design: Pick<Design, "root" | "workspace">, file: string): string {
  if (design.workspace === undefined || design.workspace === design.root) return file;
  const rel = path.relative(design.root, path.resolve(design.workspace, file));
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return file;
  return rel.split(path.sep).join("/");
}

/** What refusals and hints call the tools, so an agent is pointed at tools it has. */
export type ToolNames = { read: string; place: string; check: string };

const THREAD_TOOLS: ToolNames = {
  read: "read_canvas",
  place: "place_frames",
  check: "screenshot and frame_errors",
};

/** What the canvas tools do, as plain values, for a thread's tools and for `/mcp`. */
export function canvasOps(ctx: CanvasContext, names: ToolNames = THREAD_TOOLS) {
  const { open, actor } = ctx;
  const design = open.design;

  async function canvas(canvasId: string): Promise<Canvas> {
    const found = (await open.canvases()).find((c) => c.id === canvasId && !c.removedAt);
    if (!found) {
      throw new Refused(`There's no canvas ${canvasId}. Call ${names.read} to list the canvases.`);
    }
    return found;
  }

  async function findFrame(frameId: string): Promise<{ canvas: Canvas; frame: Frame }> {
    for (const c of await open.canvases()) {
      const frame = c.frames.find((f) => f.id === frameId);
      if (frame && !c.removedAt) return { canvas: c, frame };
    }
    throw new Refused(`There's no frame ${frameId}. Call ${names.read} to see the frames.`);
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
      sections: c.sections.map(({ id, name, x, y, width, height }) => ({
        id,
        name,
        x,
        y,
        width,
        height,
      })),
      slices: c.slices.map(({ id, frameId, name, x, y, width, height }) => ({
        id,
        frameId,
        name,
        x,
        y,
        width,
        height,
      })),
      comments: c.comments
        .filter((m) => !m.resolvedAt)
        .map((m) => ({
          id: m.id,
          ...(m.kind === "annotation" ? { kind: m.kind } : {}),
          anchor: m.anchor,
          author: m.author.name,
          text: m.text,
          replies: m.replies.map((r) => `${r.author.name}: ${r.text}`),
        })),
    };
  }

  /**
   * `region` cut to the frame's width, or a refusal when it starts past the right edge or ends
   * below the bottom of a fixed-height frame. A hugging frame has no fixed height, so only its
   * width is checked.
   */
  function cropped(frame: Frame, region: Region): Region {
    const size = `${frame.width}×${frame.height}`;
    if (region.x >= frame.width) {
      throw new Refused(
        `region starts at x ${region.x}, past the right edge of ${frame.name} (${size}). Use the frame's own pixels.`,
      );
    }
    if (!frame.hug && region.y + region.height > frame.height) {
      throw new Refused(
        `region ends at y ${region.y + region.height}, past the bottom of ${frame.name} (${size}). Use the frame's own pixels.`,
      );
    }
    return { ...region, width: Math.min(region.width, frame.width - region.x) };
  }

  /** Below everything on the canvas, at the left edge. */
  function belowAll(c: Canvas): { x: number; y: number } {
    const bottoms = [
      ...c.frames.map((f) => f.y + f.height),
      ...c.texts.map((t) => t.y + LABEL_OFFSET),
    ];
    return { x: 0, y: bottoms.length ? Math.max(...bottoms) + GAP : 0 };
  }

  return {
    canvas,
    findFrame,
    describe,

    async placeFrames({ canvasId, frames, rightOf }: CanvasToolInput<"place_frames">) {
      const c = await canvas(canvasId);
      const board = boardDir(canvasId);
      const files = await Promise.all(
        frames.map(async (f) => {
          const given = rootRelative(design, f.file);
          const rel = path.posix.normalize(
            given.startsWith(".finite/") ? given : path.posix.join(board, given),
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
        throw new Refused(`There's no frame ${rightOf} on ${c.name}. Call ${names.read}.`);
      }
      const sizes = await Promise.all(
        frames.map((f, i) =>
          frameSize(f, async (width) => {
            await ctx.previews.ensure(design);
            const url = ctx.previews.frameUrl(design.id, { kind: "file", file: files[i]! });
            return ctx.screenshots.measure(url, width);
          }),
        ),
      );
      const boxes = layoutRow(c.frames, sizes, anchor);
      const placed: Frame[] = frames.map((f, i) => ({
        id: randomUUID(),
        name: f.name,
        ...boxes[i]!,
        ...(f.height === undefined ? { hug: true } : {}),
        source: { kind: "file", file: files[i]! },
        placedBy: actor,
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
      return {
        placed: placed.map(({ id, name, x, y, width, height, source }) => ({
          id,
          name,
          x,
          y,
          width,
          height,
          source,
        })),
        next: `Check each frame with ${names.check}.`,
      };
    },

    async removeFrames({ canvasId, frameIds }: CanvasToolInput<"remove_frames">) {
      const c = await canvas(canvasId);
      for (const id of frameIds) {
        const frame = c.frames.find((f) => f.id === id);
        if (!frame) throw new Refused(`There's no frame ${id} on ${c.name}. Call ${names.read}.`);
        if (c.kind === "page" && frame.placedBy?.id !== actor.id) {
          throw new Refused(
            `"${frame.name}" on the ${c.name} page wasn't placed by this thread, so it stays. Ask the person to remove it.`,
          );
        }
      }
      const gone = c.frames.filter((f) => frameIds.includes(f.id));
      const labels = c.texts.filter((t) =>
        gone.some((f) => t.x === f.x && t.y === f.y - LABEL_OFFSET),
      );
      await open.patchCanvas(canvasId, { op: "removeFrames", frameIds }, actor);
      for (const label of labels) {
        await open.patchCanvas(canvasId, { op: "removeText", textId: label.id }, actor);
      }
      return { removed: frameIds };
    },

    async writeText(input: CanvasToolInput<"write_text">) {
      const { canvasId, textId, title, body, x, y, width } = input;
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
      return { textId: text.id, x: text.x, y: text.y };
    },

    async writeSection(input: CanvasToolInput<"write_section">) {
      const { canvasId, sectionId, remove, frameIds } = input;
      const c = await canvas(canvasId);
      const old = sectionId === undefined ? undefined : c.sections.find((s) => s.id === sectionId);
      if (sectionId !== undefined && !old) {
        throw new Refused(
          `There's no section ${sectionId} on ${c.name}. Call ${names.read} to list them, or leave sectionId out to make one.`,
        );
      }
      if (remove) {
        if (!old) throw new Refused("remove needs sectionId: the section to remove.");
        if (c.kind === "page" && old.author.id !== actor.id) {
          throw new Refused(
            `"${old.name}" on the ${c.name} page wasn't made by this thread, so it stays. Ask the person to remove it.`,
          );
        }
        await open.patchCanvas(canvasId, { op: "removeSection", sectionId: old.id }, actor);
        return { sectionId: old.id, removed: true };
      }
      const fitted = frameIds === undefined ? undefined : sectionAround(c, frameIds, names.read);
      const box = {
        x: input.x ?? fitted?.x ?? old?.x,
        y: input.y ?? fitted?.y ?? old?.y,
        width: input.width ?? fitted?.width ?? old?.width,
        height: input.height ?? fitted?.height ?? old?.height,
      };
      const name = input.name ?? old?.name;
      if (name === undefined) throw new Refused("A new section needs a name.");
      if (
        box.x === undefined ||
        box.y === undefined ||
        box.width === undefined ||
        box.height === undefined
      ) {
        throw new Refused("A new section needs x, y, width and height, or frameIds to wrap.");
      }
      const section = {
        id: old?.id ?? randomUUID(),
        name,
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
        author: old?.author ?? actor,
      };
      await open.patchCanvas(canvasId, { op: "setSection", section }, actor);
      return {
        sectionId: section.id,
        name: section.name,
        x: section.x,
        y: section.y,
        width: section.width,
        height: section.height,
      };
    },

    async comment({ frameId, loc, match, index, text, annotation }: CanvasToolInput<"comment">) {
      const { canvas: c } = await findFrame(frameId);
      if (loc === undefined && match !== undefined) {
        throw new Refused("match needs loc: give the file (and line) the element is in.");
      }
      const pinned = loc === undefined ? undefined : await pinLoc(design, loc, match);
      const id = randomUUID();
      await open.updateCanvas(
        c.id,
        (cv) => ({
          ...cv,
          comments: [
            ...cv.comments,
            {
              id,
              ...(annotation ? { kind: "annotation" as const } : {}),
              anchor: {
                frameId,
                ...(pinned === undefined ? {} : { loc: pinned }),
                ...(pinned === undefined || index === undefined ? {} : { index }),
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
      return { commentId: id, canvasId: c.id, ...(pinned ? { loc: pinned } : {}) };
    },

    async copyProduction({ canvasId, name, route }: CanvasToolInput<"copy_production">) {
      await canvas(canvasId);
      if ((name === undefined) === (route === undefined)) {
        throw new Refused("Give exactly one of name (a component) and route (a path like /cart).");
      }
      const base = name ?? routeName(route!);
      const toFile = `${boardDir(canvasId)}/${base}.tsx`;
      const { file } = await ctx.source.copyComponent(
        design,
        name === undefined ? { route: route! } : { name },
        toFile,
      );
      return { file, next: `${names.place} with file "${file}"` };
    },

    async addBrandAsset({ path: from, url }: CanvasToolInput<"add_brand_asset">) {
      if ((from === undefined) === (url === undefined)) {
        throw new Refused("Give exactly one of path and url.");
      }
      const dir = path.join(design.root, design.brandDir);
      await mkdir(dir, { recursive: true });
      let name: string;
      if (from !== undefined) {
        // Relative to the app's root, else to the workspace the agent works from.
        const inRootDir = path.resolve(design.root, from);
        const src =
          design.workspace === undefined || existsSync(inRootDir)
            ? inRootDir
            : path.resolve(design.workspace, from);
        name = path.basename(src);
        await copyFile(src, path.join(dir, name));
      } else {
        const res = await fetch(url!);
        if (!res.ok) throw new Refused(`${url} answered ${res.status}. Check the URL.`);
        name = path.posix.basename(new URL(url!).pathname) || `asset${extension(res)}`;
        await writeFile(path.join(dir, name), new Uint8Array(await res.arrayBuffer()));
      }
      const brand = await ensureBrandBoard(open, actor);
      return { file: path.posix.join(design.brandDir, name), brandCanvasId: brand.id };
    },

    cropped,

    async screenshot(frameId: string, region?: Region): Promise<Uint8Array> {
      const { frame } = await findFrame(frameId);
      const crop = region && cropped(frame, region);
      await ctx.previews.ensure(design);
      const url = ctx.previews.frameUrl(design.id, frame.source);
      return ctx.screenshots.capture(url, frame.width, frame.height, crop);
    },

    async frameErrors(frameId: string) {
      await findFrame(frameId);
      const preview = ctx.previews.state(design.id);
      if (preview.status === "error") {
        throw new Refused(`The design's preview is down, so no frame runs:\n\n${preview.log}`);
      }
      return ctx.previews
        .errors(design.id, frameId)
        .map(({ kind, message, stack }) => ({ kind, message, stack }));
    },
  };
}

/** The `finite` MCP server one thread's query talks to. */
export function canvasServer(ctx: ToolContext) {
  const { open, actor } = ctx;
  const design = open.design;
  const ops = canvasOps(ctx);

  async function meta(): Promise<ThreadMeta> {
    const found = (await open.threads()).find((t) => t.id === ctx.threadId);
    if (!found) throw new Refused(`Thread ${ctx.threadId} is gone.`);
    return found;
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
        return json(ops.describe(await ops.canvas(id)));
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
        return json(ops.describe(await ops.canvas(found.id)));
      },
    ),

    safeTool(
      "place_frames",
      `Puts TSX files on a canvas as frames, in a row right of rightOf (a frame id) or of the rightmost frame, with a title and why label above each. Files are paths under ${boardDir("<canvasId>")}/ (or relative to it) with a default-exported component. Frames hug their content: leave width out for a component (the frame takes its natural size, at least ${MIN_HUG.width}×${MIN_HUG.height}), pass width for a full page or screen (e.g. 1440 desktop, 390 mobile) and its height follows the content. Pass height only for a fixed viewport.`,
      canvasTools.place_frames,
      async (input) => json(await ops.placeFrames(input)),
    ),

    safeTool(
      "remove_frames",
      "Removes frames (and the title labels above them) from a canvas: any frame on a prototype canvas, only the frames this thread placed on a page.",
      canvasTools.remove_frames,
      async (input) => json(await ops.removeFrames(input)),
    ),

    safeTool(
      "write_text",
      "Writes a text label (title + body) on a canvas, or rewrites the one with textId. Without x/y it goes below everything else.",
      canvasTools.write_text,
      async (input) => json(await ops.writeText(input)),
    ),

    safeTool(
      "comment",
      "Pins a comment on a frame, or on one HTML element in it. loc is file:line:col as a selection gives it (col = the 0-based column of the element's `<`), or file:line, or a file with match (text the element shows); it snaps to the element there. index = which rendered instance of loc, from the selection. Use it to point people at what you changed or what you need from them. annotation: true leaves a note that stays on the canvas instead (a spacing rule, why a color): text only, and nobody has to answer it.",
      canvasTools.comment,
      async (input) => json(await ops.comment(input)),
    ),

    safeTool(
      "write_section",
      'Makes, changes or removes a section: a named rectangle on a canvas that groups frames, which move with it when a person drags it. Name it for the flow it holds ("Onboarding"). Give x, y, width, height, or frameIds to size it around those frames and their labels. With sectionId it changes that section (only the rectangle: frames stay put); remove: true with sectionId removes it and leaves the frames. read_canvas lists sections with their ids.',
      canvasTools.write_section,
      async (input) => json(await ops.writeSection(input)),
    ),

    safeTool(
      "copy_production",
      "Copies one production component (by name) or route file (by path) onto the board as a TSX file whose imports still point at production. Then place_frames it.",
      canvasTools.copy_production,
      async (input) => json(await ops.copyProduction(input)),
    ),

    safeTool(
      "move_to_prod",
      "Call only when a person asks to move, ship or get these frames to production. Allows Write/Edit on production files until this turn ends; then edit production to match the frames in production's conventions. The thread settles when the turn succeeds.",
      canvasTools.move_to_prod,
      async ({ frameIds }) => {
        const frames = await Promise.all(frameIds.map(ops.findFrame));
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
      `Copies a file (path relative to the project, or absolute) or downloads a URL into the brand folder (${design.brandDir}). The Brand page's assets board shows every file there (logos, images, fonts) by itself.`,
      canvasTools.add_brand_asset,
      async (input) => json(await ops.addBrandAsset(input)),
    ),

    safeTool(
      "spawn_thread",
      "Starts another agent on a side task in a child thread of this one, optionally on a canvas. It starts right away with prompt as its first message.",
      canvasTools.spawn_thread,
      async ({ prompt, canvasId }) => {
        if (canvasId !== undefined) await ops.canvas(canvasId);
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
      "Renders a frame at its size and returns a PNG, so you can see what people see. region ({x, y, width, height} in the frame's own pixels) crops to one part, to check a detail up close.",
      canvasTools.screenshot,
      async ({ frameId, region }) => {
        const png = await ops.screenshot(frameId, region);
        return {
          content: [
            { type: "image", data: Buffer.from(png).toString("base64"), mimeType: "image/png" },
          ],
        };
      },
    ),

    safeTool(
      "finish_setup",
      "Call in a setup thread after writing finite.json. Finite checks it and returns every problem to fix, or connects each app it lists as a design and starts the next one's preview (setup commands, services, dev server), returning whether it runs. Fix what it reports and call it again until the preview runs.",
      canvasTools.finish_setup,
      async () => json(await ctx.finishSetup()),
    ),

    safeTool(
      "frame_errors",
      "Lists the runtime errors, unhandled rejections and console errors a frame reported, or why the design's preview is down.",
      canvasTools.frame_errors,
      async ({ frameId }) => {
        const errors = await ops.frameErrors(frameId);
        return errors.length === 0 ? text("No errors.") : json(errors);
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

/**
 * The stamped loc an agent's `file[:line[:col]]` (plus optional text) means, snapped to the HTML
 * element there.
 */
export async function pinLoc(
  design: Pick<Design, "root" | "workspace">,
  loc: string,
  match?: string,
): Promise<string> {
  const { root } = design;
  const parts = /^(.+?)(?::(\d+))?(?::(\d+))?$/.exec(loc.trim());
  if (!parts) throw new Refused(`${loc} isn't a loc. Write file:line:col, file:line or a file.`);
  const [, given, line, column] = parts;
  const file = rootRelative(
    design,
    path.posix.normalize(given!.replace(/\\/g, "/").replace(/^\.\//, "")),
  );
  const code = await readFile(inRoot(root, file), "utf8").catch(() => undefined);
  if (code === undefined) {
    throw new Refused(
      `${file} isn't a file in the design. loc's file is relative to the project root.`,
    );
  }
  return snapLoc(code, file, {
    line: line === undefined ? undefined : Number(line),
    column: column === undefined ? undefined : Number(column),
    ...(match === undefined ? {} : { match }),
  });
}

/**
 * The box of a section around frames: their union, with the label above each, and `SECTION_PAD`
 * on every side.
 */
export function sectionAround(c: Canvas, frameIds: string[], read: string): Box {
  const frames = frameIds.map((id) => {
    const frame = c.frames.find((f) => f.id === id);
    if (!frame) throw new Refused(`There's no frame ${id} on ${c.name}. Call ${read}.`);
    return frame;
  });
  const left = Math.min(...frames.map((f) => f.x));
  const top = Math.min(...frames.map((f) => f.y - LABEL_OFFSET));
  const right = Math.max(...frames.map((f) => f.x + f.width));
  const bottom = Math.max(...frames.map((f) => f.y + f.height));
  return {
    x: left - SECTION_PAD,
    y: top - SECTION_PAD,
    width: right - left + SECTION_PAD * 2,
    height: bottom - top + SECTION_PAD * 2,
  };
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
