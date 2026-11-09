import { readFile } from "node:fs/promises";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  type Actor,
  type Canvas,
  type Comment,
  type Design,
  type EditOp,
  type Frame,
  mcpTools,
  type OpenDesign,
  Refused,
  type SourceEdit,
} from "@finite/protocol";
import type { z } from "zod";
import { startThread } from "../agent/index.ts";
import { policy } from "../agent/policy.ts";
import type { RenderedElement, Screenshots } from "../agent/screenshot.ts";
import { boardDir, canvasOps, rootRelative, type ToolNames } from "../agent/tools.ts";
import { commentEdit, updateComment } from "../handlers.ts";
import type { Hub, Modules } from "../hub.ts";
import { inRoot } from "../source/files.ts";
import { parseLoc } from "../source/rewrite.ts";
import { installOf } from "../store/index.ts";
import { MCP_INSTRUCTIONS } from "./instructions.ts";

export type McpContext = {
  hub: Hub;
  modules: Modules;
  screenshots: Screenshots;
  /** Who this session's changes belong to. */
  actor(): Actor;
};

const NAMES: ToolNames = { read: "read", place: "edit's place op", check: "render" };
const MAX_TEXT = 40_000;
const MAX_RENDER = 6;
const MAX_WAIT_SECONDS = 55;

type ElementOp = Extract<
  EditOp,
  { op: "style" | "content" | "attr" | "remove" | "duplicate" | "reorder" }
>;
type Stamped = RenderedElement & { loc: string; rev: string };

function text(value: string): CallToolResult {
  return { content: [{ type: "text", text: value }] };
}

function json(value: unknown): CallToolResult {
  return text(JSON.stringify(value));
}

/** `value` from `offset`, at most `MAX_TEXT` characters, saying how to get what's left. */
function paged(value: string, offset = 0): CallToolResult {
  const end = offset + MAX_TEXT;
  if (offset === 0 && value.length <= MAX_TEXT) return text(value);
  if (offset >= value.length) return text(`Nothing past offset ${value.length}.`);
  if (end >= value.length) return text(value.slice(offset));
  return text(
    `${value.slice(offset, end)}\n\nShowing characters ${offset} to ${end} of ${value.length}. Pass offset ${end} for the rest.`,
  );
}

function isElementOp(op: EditOp): op is ElementOp {
  return ["style", "content", "attr", "remove", "duplicate", "reorder"].includes(op.op);
}

function hasStamp(element: RenderedElement): element is Stamped {
  return element.loc !== undefined && element.rev !== undefined;
}

/** Whether `file` (relative to the root) is a prototype or brand file, not production. */
function isDesignFile(design: Pick<Design, "brandDir">, file: string): boolean {
  const brand = design.brandDir.replace(/\/+$/, "");
  return file.startsWith(".finite/") || file.startsWith(`${brand}/`);
}

/** `file` as an agent gave it, relative to the root; `absolute` when it was an absolute path. */
function fromRoot(design: Design, file: string): { rel: string; absolute: boolean } {
  const absolute = path.isAbsolute(file);
  const given = absolute ? path.relative(design.root, file).split(path.sep).join("/") : file;
  return { rel: absolute ? given : rootRelative(design, given), absolute };
}

function revsOf(elements: readonly Stamped[]): Record<string, string> {
  return Object.fromEntries(elements.map((e) => [parseLoc(e.loc).file, e.rev]));
}

function uniqueLocs(elements: readonly Stamped[]): string[] {
  return [...new Set(elements.map((e) => e.loc))];
}

/** One stamped element per loc. */
function perLoc(elements: readonly Stamped[]): Stamped[] {
  return uniqueLocs(elements).map((loc) => elements.find((e) => e.loc === loc)!);
}

/** The element tree as one short line per element, indented by depth. */
function tree(elements: readonly RenderedElement[]): string {
  return elements
    .map((e) => {
      const where = e.loc ?? "(no loc)";
      const words = e.text ? ` ${JSON.stringify(e.text)}` : "";
      return `${"  ".repeat(e.depth)}${e.tag} ${where}${words}`;
    })
    .join("\n");
}

/** Whether a person wrote the comment's latest message, so an agent owes it an answer. */
function isWaiting(comment: Comment): boolean {
  return (
    comment.kind !== "annotation" &&
    !comment.resolvedAt &&
    (comment.replies.at(-1)?.author ?? comment.author).kind === "person"
  );
}

/** The six tools external agents use, on one session's MCP server. */
export function finiteMcpServer(ctx: McpContext): McpServer {
  const { hub, modules, screenshots } = ctx;
  const server = new McpServer(
    { name: "finite", version: "1.0.0" },
    { instructions: MCP_INSTRUCTIONS },
  );

  function register<S extends z.ZodRawShape>(
    name: string,
    description: string,
    inputSchema: S,
    handler: (args: z.infer<z.ZodObject<S>>, signal: AbortSignal) => Promise<CallToolResult>,
  ) {
    const run = async (
      args: z.infer<z.ZodObject<S>>,
      extra: { signal: AbortSignal },
    ): Promise<CallToolResult> => {
      try {
        return await handler(args, extra.signal);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ...text(message), isError: true };
      }
    };
    server.registerTool(name, { description, inputSchema }, run as never);
  }

  /** A design by id, or by a name only one design has. */
  async function designOf(ref: string): Promise<OpenDesign> {
    const list = await modules.store.designs();
    if (list.some((d) => d.id === ref)) return hub.open(ref);
    const named = list.filter((d) => d.name === ref);
    if (named.length === 1) return hub.open(named[0]!.id);
    const choices = (named.length > 1 ? named : list).map((d) => `${d.name} (${d.id})`).join(", ");
    if (named.length > 1) {
      throw new Refused(`${named.length} designs are named ${ref}. Pass one id: ${choices}.`);
    }
    throw new Refused(
      list.length === 0
        ? `There's no design ${ref}, and no designs yet. Make one with designs' create or connect.`
        : `There's no design ${ref}. The designs are: ${choices}.`,
    );
  }

  const opsOf = (open: OpenDesign) =>
    canvasOps(
      { open, actor: ctx.actor(), previews: modules.previews, source: modules.source, screenshots },
      NAMES,
    );

  /** Refuses at once while a new design's dependencies install: no frame can load yet. */
  function refuseInstalling(open: OpenDesign): void {
    const install = installOf(open);
    if (!install) return;
    throw new Refused(
      install.state.status === "error"
        ? `The design's dependencies failed to install, so no frame can load:\n\n${install.state.log}`
        : "The design's dependencies are still installing, so no frame can load yet. Call read on this design to see when the install is done, then try again.",
    );
  }

  /** Starts the design's dev server, or refuses with why it can't run. */
  async function previewUp(open: OpenDesign): Promise<void> {
    refuseInstalling(open);
    await modules.previews.ensure(open.design);
    const state = modules.previews.state(open.design.id);
    if (state.status === "error") {
      throw new Refused(`The design's preview is down, so no frame runs:\n\n${state.log}`);
    }
  }

  /** Runs `use` with the preview up, then lets it idle unless someone is watching the design. */
  async function withPreview<T>(open: OpenDesign, use: () => Promise<T>): Promise<T> {
    try {
      await previewUp(open);
      return await use();
    } finally {
      hub.release(open.design.id);
    }
  }

  /** One fresh load of the frame, and what each selector matches in it. */
  async function matchIn(open: OpenDesign, frame: Frame, selects: (string | undefined)[]) {
    const url = modules.previews.frameUrl(open.design.id, frame.source);
    const found = await screenshots.elements(url, frame.width, frame.height, selects);
    return found.map((result, i) => {
      if (Array.isArray(result)) return result;
      throw new Refused(`${JSON.stringify(selects[i])} isn't a CSS selector: ${result.invalid}`);
    });
  }

  register(
    "designs",
    `Lists, creates, connects, renames or removes designs. A design is a React project.

- {} or {"action": "list"}: every design, latest change first.
- {"action": "create", "name": "Shop"}: a new blank Vite + React + Tailwind project.
- {"action": "connect", "path": "/abs/path/to/project"}: connects a project on this machine.
- {"action": "rename", "designId": "…", "name": "…"}.
- {"action": "remove", "designId": "<exact id>"}: Finite forgets the design. A connected project stays on disk.`,
    mcpTools.designs,
    async ({ action = "list", designId, name, path: folder, offset }) => {
      const need = <T>(value: T | undefined, what: string): T => {
        if (value === undefined) throw new Refused(`designs' ${action} needs ${what}.`);
        return value;
      };
      const setupHint = (setup: boolean | undefined) =>
        setup
          ? { hint: "Finite can't run this folder yet. Open it in Finite to run its setup." }
          : {};
      switch (action) {
        case "list": {
          const list = await modules.store.designs();
          const rows = [...list]
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .map(({ id, name, root, origin, installing, setup, updatedAt }) => ({
              id,
              name,
              root,
              origin,
              ...(installing ? { installing } : {}),
              ...(setup ? { setup } : {}),
              updatedAt,
              preview: modules.previews.state(id).status,
              ...setupHint(setup),
            }));
          return paged(JSON.stringify(rows), offset);
        }
        case "create": {
          const entry = await modules.store.create({
            name: need(name, "name"),
            kind: "blank",
          });
          return json({ ...entry, next: "Its dependencies install first. Call read to check." });
        }
        case "connect": {
          const entry = await modules.store.connect(need(folder, "path"));
          return json({ ...entry, ...setupHint(entry.setup) });
        }
        case "rename": {
          const open = await designOf(need(designId, "designId"));
          return json(await modules.store.rename(open.design.id, need(name, "name")));
        }
        case "remove": {
          const id = need(designId, "designId");
          const list = await modules.store.designs();
          if (!list.some((d) => d.id === id)) {
            throw new Refused(`Removing a design takes its exact id, and ${id} isn't one.`);
          }
          // Sessions working in the design stop first, so none writes into a folder on its way out.
          await Promise.all([modules.previews.stop(id), modules.agents.stopDesign(id)]);
          await modules.store.remove(id);
          return json({ removed: id });
        }
      }
    },
  );

  register(
    "read",
    `Shows a design as text.

- {"designId": "…"}: the overview: root folder, router, styling convention, brand folder, preview state and canvases.
- {"designId": "…", "canvasId": "…"}: a canvas's frames, text labels and open comments.
- {"designId": "…", "frameId": "…"}: the frame's rendered elements, one line each: tag, loc, text. [data-finite-loc="src/x.tsx:12:4"] selects exactly the element a line names, in select here and in edit's element ops. select narrows the list to a CSS selector's matches ("nav, nav *" includes what's inside).
- {"designId": "…", "file": "src/App.tsx"}: a file in the project.
- {"designId": "…", "what": "tokens" | "components" | "routes"}.`,
    mcpTools.read,
    async ({ designId, canvasId, frameId, select, file, what, offset }) => {
      const open = await designOf(designId);
      const ops = opsOf(open);
      const design = open.design;
      if ([canvasId, frameId, file, what].filter((v) => v !== undefined).length > 1) {
        throw new Refused("Pass one of canvasId, frameId, file and what.");
      }
      if (select !== undefined && frameId === undefined) {
        throw new Refused("select needs frameId: it picks elements in one frame.");
      }
      if (canvasId !== undefined) {
        return paged(JSON.stringify(ops.describe(await ops.canvas(canvasId))), offset);
      }
      if (frameId !== undefined) {
        const { frame } = await ops.findFrame(frameId);
        const [elements] = await withPreview(open, () => matchIn(open, frame, [select]));
        if (elements!.length === 0) {
          return text(
            select === undefined
              ? `Frame ${frame.name} rendered no stamped elements. Call render to see it.`
              : `${JSON.stringify(select)} matches nothing in ${frame.name}. Leave select out to see every element.`,
          );
        }
        return paged(tree(elements!), offset);
      }
      if (file !== undefined) {
        const { rel } = fromRoot(design, file);
        const code = await readFile(inRoot(design.root, rel), "utf8").catch(() => undefined);
        if (code === undefined) throw new Refused(`${rel} isn't a file in the design.`);
        return paged(code, offset);
      }
      if (what === "tokens") {
        return paged(JSON.stringify(await modules.source.tokens(design)), offset);
      }
      if (what === "components") {
        return paged(JSON.stringify(await modules.source.components(design)), offset);
      }
      if (what === "routes") {
        const routes = await withPreview(open, () => modules.previews.routes(design.id));
        return paged(JSON.stringify(routes), offset);
      }
      const canvases = (await open.canvases()).filter((c) => !c.removedAt);
      const install = installOf(open);
      return paged(
        JSON.stringify({
          id: design.id,
          name: design.name,
          root: design.root,
          ...(design.workspace === undefined ? {} : { workspace: design.workspace }),
          router: design.router,
          styling: design.styling,
          brandDir: design.brandDir,
          ...(design.setup ? { setup: true } : {}),
          preview: modules.previews.state(design.id),
          ...(install ? { install: install.state } : {}),
          canvases: canvases.map((c) => ({
            id: c.id,
            name: c.name,
            kind: c.kind,
            frames: c.frames.length,
            openComments: c.comments.filter((m) => !m.resolvedAt).length,
          })),
        }),
        offset,
      );
    },
  );

  register(
    "edit",
    `Changes a design. Ops run in order. On the first failure the rest don't run, and the result lists what was applied and what was refused.

Ops that name no canvasId use the last canvas op's canvas in this call, else this call's canvasId.

{"op": "canvas", "name": "Checkout"}
Finds the page or prototype with that name, or makes a new prototype. Returns canvasId and boardDir.
{"op": "write", "file": "Hero.tsx", "content": "export default function Hero() {…}"}
Writes a whole file. A relative path goes in the canvas's board. With production: true, or for a .finite/ or brand folder path, it's from the project root.
{"op": "place", "frames": [{"file": "Hero.tsx", "name": "Hero", "title": "…", "why": "…", "width": 1440}], "rightOf": "<frameId>"}
Puts written files on the canvas in a row. Leave width out for a component (it takes its natural size). Pass 1440 or 390 for a screen.
{"op": "remove_frames", "frameIds": ["…"]}
{"op": "text", "title": "…", "body": "…"}
A note on the canvas. textId rewrites one; x, y and width place it.
{"op": "section", "name": "Onboarding", "frameIds": ["…"]}
A named rectangle that groups frames: people drag it and the frames inside move with it. Give frameIds to size it around them, or x, y, width and height. sectionId changes one (the rectangle only); {"op": "section", "sectionId": "…", "remove": true} removes it and keeps the frames. read lists a canvas's sections.
{"op": "copy_production", "name": "Button"} or {"op": "copy_production", "route": "/cart"}
{"op": "brand_asset", "path": "logo.svg"} or {"op": "brand_asset", "url": "https://…"}
{"op": "token", "name": "--brand", "mode": "light", "value": "#123456"}
Writes the project's stylesheet, so it needs production: true. undo doesn't take it back: set the old value again.

Element ops pick elements with a CSS selector in the live frame, and rewrite the TSX that made them. [data-finite-loc="src/x.tsx:12:4"] selects exactly the element a line of read's frame list names:
{"op": "style", "frameId": "…", "select": ".cta", "styles": {"background-color": "#123456", "padding": null}}
{"op": "content", "frameId": "…", "select": "h1", "text": "New heading"}
{"op": "attr", "frameId": "…", "select": "a.cta", "name": "href", "value": "/start"}
{"op": "remove", "frameId": "…", "select": ".banner"}
{"op": "duplicate", "frameId": "…", "select": ".card:first-child"}
{"op": "reorder", "frameId": "…", "select": "#b", "before": "#a"}
before: null moves it last. Both must be siblings in one file.

Element ops in a row on one canvas apply as one transaction and one undo step.

Production code is refused unless you pass production: true, which you may do only when the person asked to move, ship or change production.`,
    mcpTools.edit,
    async ({ designId, canvasId, production = false, ops: list }) => {
      const open = await designOf(designId);
      const ops = opsOf(open);
      const design = open.design;
      const actor = ctx.actor();
      let current = canvasId;

      const targetCanvas = (given: string | undefined): string => {
        const id = given ?? current;
        if (id === undefined) {
          throw new Refused(
            "This op needs a canvas. Put a canvas op before it, or pass canvasId. read lists the canvases.",
          );
        }
        return id;
      };

      const refuseProduction = (file: string) => {
        throw new Refused(
          `${file} is production code. Pass production: true only if the person asked to change production; otherwise copy_production it onto a board and edit the copy.`,
        );
      };

      async function runOp(op: Exclude<EditOp, ElementOp>): Promise<object> {
        switch (op.op) {
          case "canvas": {
            const all = (await open.canvases()).filter((c) => !c.removedAt);
            let found =
              all.find((c) => c.name === op.name) ??
              all.find((c) => c.name.toLowerCase() === op.name.toLowerCase());
            if (!found) {
              const { model, fast } = await modules.store.settings();
              // A prototype is listed by its thread, so it needs one.
              const thread = await startThread(
                open,
                { prototype: true },
                { text: op.name, model, fast, by: actor },
              );
              found = await ops.canvas(thread.canvasIds[0]!);
            }
            current = found.id;
            return {
              canvasId: found.id,
              name: found.name,
              kind: found.kind,
              boardDir: boardDir(found.id),
            };
          }
          case "write": {
            const { rel: given, absolute } = fromRoot(design, op.file);
            const rooted = production || absolute || isDesignFile(design, given);
            const rel = rooted
              ? path.posix.normalize(given)
              : path.posix.join(boardDir((await ops.canvas(targetCanvas(op.canvasId))).id), given);
            const allowed = policy(
              "Write",
              { file_path: path.join(design.root, rel) },
              {
                root: design.root,
                brandDir: design.brandDir,
                prodWrite: production,
                prodGrant: "pass production: true on edit",
                ...(design.workspace === undefined ? {} : { workspace: design.workspace }),
              },
            );
            if (allowed.behavior === "deny") throw new Refused(allowed.message);
            await modules.source.write(open, rel, op.content, actor);
            return { file: rel };
          }
          case "place": {
            refuseInstalling(open);
            try {
              return await ops.placeFrames({
                canvasId: targetCanvas(op.canvasId),
                frames: op.frames,
                ...(op.rightOf === undefined ? {} : { rightOf: op.rightOf }),
              });
            } finally {
              // Measuring a frame that hugs its content starts the preview.
              hub.release(design.id);
            }
          }
          case "remove_frames":
            return ops.removeFrames({
              canvasId: targetCanvas(op.canvasId),
              frameIds: op.frameIds,
            });
          case "text": {
            const { op: _op, canvasId: given, ...fields } = op;
            return ops.writeText({ ...fields, canvasId: targetCanvas(given) });
          }
          case "section": {
            const { op: _op, canvasId: given, ...fields } = op;
            return ops.writeSection({ ...fields, canvasId: targetCanvas(given) });
          }
          case "copy_production": {
            const { op: _op, canvasId: given, ...from } = op;
            return ops.copyProduction({ ...from, canvasId: targetCanvas(given) });
          }
          case "brand_asset": {
            const { op: _op, ...from } = op;
            return ops.addBrandAsset(from);
          }
          case "token": {
            if (!production) {
              throw new Refused(
                "A token lives in the project's own stylesheet, so it's a production change. Pass production: true only if the person asked for it.",
              );
            }
            const { op: _op, ...token } = op;
            await modules.source.setToken(design, token);
            return { token: op.name, mode: op.mode, value: op.value };
          }
        }
      }

      /** The element ops at the start of `rest` that land on the first one's canvas. */
      async function takeBatch(rest: readonly EditOp[]) {
        const batch: { op: ElementOp; frame: Frame }[] = [];
        let canvas: Canvas | undefined;
        for (const op of rest) {
          if (!isElementOp(op)) break;
          let found: Awaited<ReturnType<typeof ops.findFrame>>;
          try {
            found = await ops.findFrame(op.frameId);
          } catch (error) {
            // A later op's bad frame fails that op, after the ones before it apply.
            if (batch.length > 0) break;
            throw error;
          }
          if (canvas && found.canvas.id !== canvas.id) break;
          canvas = found.canvas;
          batch.push({ op, frame: found.frame });
        }
        return { batch, canvas: canvas! };
      }

      async function applyBatch(batch: { op: ElementOp; frame: Frame }[], canvas: Canvas) {
        const byFrame = new Map<string, { frame: Frame; selects: string[] }>();
        for (const { op, frame } of batch) {
          const entry = byFrame.get(frame.id) ?? { frame, selects: [] };
          entry.selects.push(op.select);
          if (op.op === "reorder" && op.before !== null) entry.selects.push(op.before);
          byFrame.set(frame.id, entry);
        }
        const matches = new Map<string, RenderedElement[]>();
        const keyOf = (frameId: string, select: string) => `${frameId}\u0000${select}`;
        await withPreview(open, () =>
          Promise.all(
            [...byFrame.values()].map(async ({ frame, selects }) => {
              const found = await matchIn(open, frame, selects);
              selects.forEach((select, i) => matches.set(keyOf(frame.id, select), found[i]!));
            }),
          ),
        );

        const stampedFor = (frame: Frame, select: string): Stamped[] => {
          const found = matches.get(keyOf(frame.id, select))!;
          if (found.length === 0) {
            throw new Refused(
              `${JSON.stringify(select)} matches nothing in ${frame.name}. Call read with frameId to see its elements.`,
            );
          }
          const stamped = found.filter(hasStamp);
          if (stamped.length === 0) {
            throw new Refused(
              `${JSON.stringify(select)} matches only elements with no loc in ${frame.name} (a library renders them), so there's no TSX to change. Select the nearest element read lists with a loc.`,
            );
          }
          for (const { loc } of stamped) {
            const { file } = parseLoc(loc);
            if (!production && !isDesignFile(design, file)) refuseProduction(file);
          }
          return stamped;
        };

        const edits: SourceEdit[] = [];
        const applied: object[] = [];
        for (const { op, frame } of batch) {
          const stamped = stampedFor(frame, op.select);
          const locs = uniqueLocs(stamped);
          const repeats = stamped.length - locs.length;
          applied.push({
            op: op.op,
            locs,
            ...(repeats > 0
              ? {
                  note: `${stamped.length} rendered elements come from ${locs.length} JSX element${locs.length === 1 ? "" : "s"}, so this changed every instance.`,
                }
              : {}),
          });
          const revs = revsOf(stamped);
          switch (op.op) {
            case "style": {
              for (const tag of new Set(stamped.map((e) => e.tag))) {
                const same = stamped.filter((e) => e.tag === tag);
                edits.push({
                  kind: "style",
                  locs: uniqueLocs(same),
                  tag,
                  styles: op.styles,
                  revs: revsOf(same),
                });
              }
              break;
            }
            case "content":
              for (const e of perLoc(stamped)) {
                edits.push({ kind: "text", loc: e.loc, tag: e.tag, text: op.text, revs });
              }
              break;
            case "attr":
              for (const e of perLoc(stamped)) {
                edits.push({ kind: "attr", loc: e.loc, name: op.name, value: op.value, revs });
              }
              break;
            case "remove":
              edits.push({ kind: "remove", locs, revs });
              break;
            case "duplicate":
              edits.push({ kind: "duplicate", locs, revs });
              break;
            case "reorder": {
              if (locs.length !== 1) {
                throw new Refused(
                  `${JSON.stringify(op.select)} matches ${locs.length} JSX elements; reorder moves one. Narrow the selector.`,
                );
              }
              const el = stamped[0]!;
              const before = op.before === null ? [] : stampedFor(frame, op.before);
              if (uniqueLocs(before).length > 1) {
                throw new Refused(
                  `${JSON.stringify(op.before)} matches several JSX elements; reorder needs one to go before. Narrow the selector.`,
                );
              }
              edits.push({
                kind: "reorder",
                loc: el.loc,
                tag: el.tag,
                before: before[0]?.loc ?? null,
                revs: revsOf([el, ...before]),
              });
              break;
            }
          }
        }
        // Without production, a page takes the prototype fence too: it covers CSS modules.
        const fenced = production ? canvas : { ...canvas, kind: "prototype" as const };
        await modules.source.apply(open, edits, actor, fenced);
        return applied;
      }

      const applied: object[] = [];
      let at = 0;
      try {
        while (at < list.length) {
          const op = list[at]!;
          if (isElementOp(op)) {
            const { batch, canvas } = await takeBatch(list.slice(at));
            applied.push(...(await applyBatch(batch, canvas)));
            at += batch.length;
          } else {
            applied.push({ op: op.op, ...(await runOp(op)) });
            at += 1;
          }
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return {
          ...json({
            applied,
            refused: { index: at, op: list[at]?.op, reason },
            next: `The ops before index ${at} are done. Nothing from index ${at} on ran. Fix it and send those ops again.`,
          }),
          isError: true,
        };
      }
      return json({ applied, next: "Check what you changed with render." });
    },
  );

  register(
    "render",
    `A PNG of each frame at its size, with the runtime errors it reported. Pass frameIds, or canvasId for its frames. At most ${MAX_RENDER} per call. region ({"x": 0, "y": 0, "width": 320, "height": 200}, in the frame's own pixels) crops one frame to a part of it, to check a detail up close.`,
    mcpTools.render,
    async ({ designId, frameIds, canvasId, region }) => {
      const open = await designOf(designId);
      const ops = opsOf(open);
      if ((frameIds === undefined) === (canvasId === undefined)) {
        throw new Refused("Pass exactly one of frameIds and canvasId.");
      }
      if (region && frameIds?.length !== 1) {
        throw new Refused("region crops one frame: pass a single frame in frameIds.");
      }
      const frames =
        frameIds === undefined
          ? (await ops.canvas(canvasId!)).frames
          : (await Promise.all(frameIds.map(ops.findFrame))).map(({ frame }) => frame);
      if (frames.length === 0) return text("That canvas has no frames yet.");

      const content: CallToolResult["content"] = [];
      await withPreview(open, async () => {
        for (const frame of frames.slice(0, MAX_RENDER)) {
          try {
            const url = modules.previews.frameUrl(open.design.id, frame.source);
            const { png, errors: loaded } = await screenshots.captureWithErrors(
              url,
              frame.width,
              frame.height,
              region && ops.cropped(frame, region),
            );
            // This load's errors first, then what an open page's bridge reported.
            const seen = new Set<string>();
            const errors = [...loaded, ...(await ops.frameErrors(frame.id))].filter(
              ({ message }) => !seen.has(message) && seen.add(message),
            );
            content.push(
              { type: "text", text: `${frame.name} (${frame.id})` },
              { type: "image", data: Buffer.from(png).toString("base64"), mimeType: "image/png" },
              {
                type: "text",
                text: errors.length === 0 ? "No errors." : JSON.stringify(errors),
              },
            );
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            content.push({
              type: "text",
              text: `${frame.name} (${frame.id}) didn't render: ${reason}`,
            });
          }
        }
      });
      const left = frames.length - MAX_RENDER;
      if (left > 0) {
        content.push({
          type: "text",
          text: `${left} more frame${left === 1 ? "" : "s"} not shown. Pass frameIds for the rest.`,
        });
      }
      return { content };
    },
  );

  register(
    "comments",
    `Comments people pinned to frames, and your answers.

- {"designId": "…"}: open comments on every canvas; canvasId limits it to one. "waiting": true means a person spoke last.
- {"designId": "…", "wait": 55}: blocks until a comment is waiting, up to 55 seconds. Call it again to keep listening.
- {"designId": "…", "add": {"frameId": "…", "text": "…", "loc": "src/x.tsx:12:4"}}: pins one. Leave loc out to pin it to the frame. "annotation": true leaves a note that stays on the canvas for people; it never counts as waiting.
- {"designId": "…", "reply": [{"commentId": "…", "text": "Made it a link.", "resolve": true}]}.
- {"designId": "…", "resolve": ["…"]} or {"designId": "…", "reopen": ["…"]}.`,
    mcpTools.comments,
    async (args, signal) => {
      const { designId, canvasId, wait, add, reply, resolve, reopen, offset } = args;
      const open = await designOf(designId);
      const ops = opsOf(open);
      const actor = ctx.actor();

      const listed = async () => {
        const canvases = (await open.canvases()).filter(
          (c) => !c.removedAt && (canvasId === undefined || c.id === canvasId),
        );
        return canvases.flatMap((c) =>
          c.comments
            .filter((m) => !m.resolvedAt)
            .map((m) => ({
              id: m.id,
              canvasId: c.id,
              ...(m.kind === "annotation" ? { kind: m.kind } : {}),
              anchor: m.anchor,
              author: m.author.name,
              messages: [
                { author: m.author.name, text: m.text },
                ...m.replies.map((r) => ({ author: r.author.name, text: r.text })),
              ],
              waiting: isWaiting(m),
            })),
        );
      };

      async function canvasOfComment(commentId: string): Promise<string> {
        const found = (await open.canvases()).find(
          (c) =>
            !c.removedAt &&
            (canvasId === undefined || c.id === canvasId) &&
            c.comments.some((m) => m.id === commentId),
        );
        if (!found) {
          throw new Refused(`There's no comment ${commentId}. Call comments to list them.`);
        }
        return found.id;
      }

      if (add || reply || resolve || reopen) {
        const added = add ? await ops.comment(add) : undefined;
        for (const r of reply ?? []) {
          const on = await canvasOfComment(r.commentId);
          await updateComment(open, on, r.commentId, commentEdit.reply(r.text, actor), actor);
          if (r.resolve) {
            await updateComment(open, on, r.commentId, commentEdit.resolve, actor);
          }
        }
        for (const id of resolve ?? []) {
          await updateComment(open, await canvasOfComment(id), id, commentEdit.resolve, actor);
        }
        for (const id of reopen ?? []) {
          await updateComment(open, await canvasOfComment(id), id, commentEdit.reopen, actor);
        }
        return json({
          ...(added ? { added } : {}),
          ...(reply ? { replied: reply.map((r) => r.commentId) } : {}),
          ...(resolve ? { resolved: resolve } : {}),
          ...(reopen ? { reopened: reopen } : {}),
        });
      }

      if (wait === undefined || wait === false) {
        return paged(JSON.stringify(await listed()), offset);
      }

      const seconds = wait === true ? MAX_WAIT_SECONDS : Math.min(wait, MAX_WAIT_SECONDS);
      const waiting = await new Promise<Awaited<ReturnType<typeof listed>>>((done) => {
        let finished = false;
        const finish = (value: Awaited<ReturnType<typeof listed>>) => {
          if (finished) return;
          finished = true;
          off();
          clearTimeout(timer);
          signal.removeEventListener("abort", give);
          done(value);
        };
        const give = () => finish([]);
        const check = () =>
          void listed().then(
            (all) => {
              const owed = all.filter((c) => c.waiting);
              if (owed.length > 0) finish(owed);
            },
            () => {},
          );
        const off = open.on((change) => {
          if (change.type === "canvas") check();
        });
        const timer = setTimeout(give, seconds * 1000);
        signal.addEventListener("abort", give, { once: true });
        if (signal.aborted) give();
        else check();
      });
      if (waiting.length === 0) {
        return text("No comment is waiting yet. Call comments with wait again to keep listening.");
      }
      return paged(
        JSON.stringify({
          comments: waiting,
          next: "Make the change, render it, then reply with what you changed and resolve: true.",
        }),
        offset,
      );
    },
  );

  register(
    "undo",
    "Takes back your own last step; never anyone else's. Without canvasId it undoes your last file change (a write or a batch of element ops). With canvasId it undoes your last change to that canvas (one frame, label or section placed, moved or removed). redo: true redoes.",
    mcpTools.undo,
    async ({ designId, canvasId, redo = false }) => {
      const open = await designOf(designId);
      const actor = ctx.actor();
      const verb = redo ? "Redid" : "Undid";
      if (canvasId !== undefined) {
        await open.undoCanvas(canvasId, actor, redo);
        return text(`${verb} your last change to canvas ${canvasId}.`);
      }
      await (redo ? modules.source.redo(open, actor) : modules.source.undo(open, actor));
      return text(`${verb} your last file change.`);
    },
  );

  return server;
}
