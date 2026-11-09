import { randomUUID } from "node:crypto";
import {
  type Actor,
  type Canvas,
  type Comment,
  type OpenDesign,
  PROTOCOL_VERSION,
  Refused,
  type Route,
  type ThreadMeta,
} from "@finite/protocol";
import { carrySelection, setupReason, startSetup, startThread } from "./agent/index.ts";
import { setupPrompt } from "./agent/instructions.ts";
import type { Context, Handlers } from "./hub.ts";
import { installOf } from "./store/index.ts";
import { syncRoutes } from "./store/routes.ts";

/**
 * One function per request type: thin glue from the wire to the modules in store/, preview/,
 * source/ and agent/. Logic that's more than a line or two belongs in the module.
 */
export const handlers: Handlers = {
  async hello({ user }, { client }) {
    client.user = user;
    return { version: PROTOCOL_VERSION, user };
  },

  "designs.list": (_, { modules }) => modules.store.designs(),
  "design.create": ({ name, kind, source }, { modules }) =>
    modules.store.create({ name, kind, ...(source === undefined ? {} : { source }) }),
  "design.connect": ({ path }, { modules }) => modules.store.connect(path),
  "design.rename": ({ id, name }, { modules }) => modules.store.rename(id, name),
  async "design.remove"({ id }, { modules }) {
    // Sessions working in the design stop first, so none writes into a folder on its way out.
    await Promise.all([modules.previews.stop(id), modules.agents.stopDesign(id)]);
    await modules.store.remove(id);
    return null;
  },

  async "design.setup"({ designId }, { hub, modules, by }) {
    const open = await hub.open(designId);
    const { model, effort, fast } = await modules.store.settings();
    const thread = await startSetup(open, { model, effort, fast });
    const reason = await setupReason(open.design, modules.previews.state(designId));
    const text = setupPrompt(open.design.name, reason);
    await modules.agents.send(
      open,
      thread.id,
      { text, attachments: [], model, effort, fast, by },
      "steer",
    );
    return { threadId: thread.id };
  },

  async subscribe({ designId }, { client, hub, modules }) {
    const open = await hub.open(designId);
    client.subscriptions.add(designId);
    // A new blank design installs its dependencies first; the dev server starts after.
    const install = installOf(open);
    (install?.done ?? Promise.resolve())
      .then(() => modules.previews.ensure(open.design))
      .catch((error: unknown) => console.error(`preview for ${designId} failed:`, error));
    const routes: Route[] = install ? [] : await modules.previews.routes(designId).catch(() => []);
    if (routes.length) await syncRoutes(open, routes);
    const [canvases, threads] = await Promise.all([open.canvases(), open.threads()]);
    return {
      design: open.design,
      canvases,
      threads,
      preview: modules.previews.state(designId),
      routes,
      ...(install ? { install: install.state } : {}),
    };
  },
  async unsubscribe({ designId }, { client, hub }) {
    hub.unsubscribe(client, designId);
    return null;
  },

  async "canvas.create"({ designId, kind, name, threadId }, ctx) {
    const open = await ctx.hub.open(designId);
    return open.createCanvas(
      { kind, name, ...(threadId === undefined ? {} : { threadId }) },
      ctx.by,
    );
  },
  "canvas.rename": ({ designId, canvasId, name }, ctx) =>
    updateCanvas(ctx, designId, canvasId, (c) => ({ ...c, name })),
  "canvas.remove": ({ designId, canvasId }, ctx) =>
    updateCanvas(ctx, designId, canvasId, (c) => ({ ...c, removedAt: Date.now() })),
  "canvas.restore": ({ designId, canvasId }, ctx) =>
    updateCanvas(ctx, designId, canvasId, (c) => without(c, "removedAt")),
  async "canvas.patch"({ designId, canvasId, patch }, ctx) {
    const open = await ctx.hub.open(designId);
    return open.patchCanvas(canvasId, patch, ctx.by);
  },
  async "canvas.undo"({ designId, canvasId }, ctx) {
    return (await ctx.hub.open(designId)).undoCanvas(canvasId, ctx.by);
  },
  async "canvas.redo"({ designId, canvasId }, ctx) {
    return (await ctx.hub.open(designId)).undoCanvas(canvasId, ctx.by, true);
  },

  async "source.edit"({ designId, canvasId, edits }, ctx) {
    const open = await ctx.hub.open(designId);
    const canvas = await findCanvas(open, canvasId);
    const { remap, created } = await ctx.modules.source.apply(open, edits, ctx.by, canvas);
    return { remap, created };
  },
  async "source.undo"({ designId }, ctx) {
    await ctx.modules.source.undo(await ctx.hub.open(designId), ctx.by);
    return null;
  },
  async "source.redo"({ designId }, ctx) {
    await ctx.modules.source.redo(await ctx.hub.open(designId), ctx.by);
    return null;
  },
  async "source.detach"({ designId, ...input }, ctx) {
    return ctx.modules.source.detach(await ctx.hub.open(designId), input, ctx.by);
  },
  async "source.inline"({ designId, loc }, ctx) {
    return ctx.modules.source.inline(await ctx.hub.open(designId), loc);
  },
  async "canvas.draw"({ designId, ...input }, ctx) {
    return ctx.modules.source.draw(await ctx.hub.open(designId), input, ctx.by);
  },
  async "canvas.exportSlice"({ designId, ...input }, ctx) {
    return ctx.modules.source.exportSlice(await ctx.hub.open(designId), input);
  },
  async "asset.add"({ designId, attachment }, ctx) {
    return ctx.modules.source.addAsset(await ctx.hub.open(designId), attachment);
  },

  "comment.add": ({ designId, canvasId, anchor, text }, ctx) =>
    updateCanvas(ctx, designId, canvasId, (c) => ({
      ...c,
      comments: [
        ...c.comments,
        { id: randomUUID(), anchor, author: ctx.by, text, replies: [], createdAt: Date.now() },
      ],
    })),
  async "comment.reply"({ designId, canvasId, commentId, text }, ctx) {
    const open = await ctx.hub.open(designId);
    return updateComment(open, canvasId, commentId, commentEdit.reply(text, ctx.by), ctx.by);
  },
  async "comment.resolve"({ designId, canvasId, commentId }, ctx) {
    const open = await ctx.hub.open(designId);
    return updateComment(open, canvasId, commentId, commentEdit.resolve, ctx.by);
  },
  async "comment.reopen"({ designId, canvasId, commentId }, ctx) {
    const open = await ctx.hub.open(designId);
    return updateComment(open, canvasId, commentId, commentEdit.reopen, ctx.by);
  },

  async "thread.send"(params, ctx) {
    const { designId, text, attachments, selection, model, effort, fast, mode } = params;
    const open = await ctx.hub.open(designId);
    const turn = {
      text,
      attachments,
      model,
      fast,
      by: ctx.by,
      ...(selection === undefined ? {} : { selection }),
      ...(effort === undefined ? {} : { effort }),
    };
    if (params.threadId !== undefined) {
      await ctx.modules.agents.send(open, params.threadId, turn, mode);
      return { threadId: params.threadId };
    }
    // `new.prototype` makes the thread's canvas with it; `new.canvasId` joins one; else it has none.
    const thread = await startThread(open, params.new ?? {}, turn);
    // A prototype started from a selection starts with the selected frames on its canvas.
    const canvasId = thread.canvasIds[0];
    if (params.new?.prototype && canvasId && selection?.length) {
      turn.selection = await carrySelection(open, canvasId, selection, ctx.by);
    }
    await ctx.modules.agents.send(open, thread.id, turn, mode);
    return { threadId: thread.id };
  },
  async "thread.queued"({ designId, threadId, queuedId, text }, ctx) {
    return ctx.modules.agents.editQueued(await ctx.hub.open(designId), threadId, queuedId, text);
  },
  async "thread.interrupt"({ designId, threadId }, ctx) {
    await ctx.modules.agents.interrupt(await ctx.hub.open(designId), threadId);
    return null;
  },
  "thread.snooze": ({ designId, threadId, until }, ctx) =>
    updateThread(ctx, designId, threadId, (meta) =>
      until === null ? without(meta, "snoozedUntil") : { ...meta, snoozedUntil: until },
    ),
  "thread.settle": ({ designId, threadId, settled }, ctx) =>
    updateThread(ctx, designId, threadId, (meta) =>
      settled ? { ...meta, settledAt: Date.now() } : without(meta, "settledAt"),
    ),
  "thread.rename": ({ designId, threadId, title }, ctx) =>
    updateThread(ctx, designId, threadId, (meta) => ({ ...meta, title })),
  async "thread.history"({ designId, threadId }, ctx) {
    return (await ctx.hub.open(designId)).history(threadId);
  },

  "settings.get": (_, { modules }) => modules.store.settings(),
  async "settings.set"({ settings }, { hub, modules }) {
    const patch = Object.fromEntries(
      Object.entries(settings).filter(([, v]) => v !== undefined),
    ) as Parameters<typeof modules.store.setSettings>[0];
    const next = await modules.store.setSettings(patch);
    hub.broadcastAll({ type: "settings", settings: next });
    return next;
  },
  "claude.status": (_, { modules }) => modules.agents.status(),

  async "tokens.get"({ designId }, ctx) {
    return ctx.modules.source.tokens((await ctx.hub.open(designId)).design);
  },
  async "tokens.set"({ designId, ...input }, ctx) {
    return ctx.modules.source.setToken((await ctx.hub.open(designId)).design, input);
  },
  async "components.list"({ designId }, ctx) {
    return ctx.modules.source.components((await ctx.hub.open(designId)).design);
  },

  async "frame.error"({ designId, frameId, kind, message, stack }, { modules }) {
    modules.previews.reportError(designId, {
      frameId,
      kind,
      message,
      at: Date.now(),
      ...(stack === undefined ? {} : { stack }),
    });
    return null;
  },
};

async function findCanvas(open: OpenDesign, canvasId: string): Promise<Canvas> {
  const canvas = (await open.canvases()).find((c) => c.id === canvasId);
  if (!canvas) throw new Refused(`no canvas ${canvasId} in this design`, "not-found");
  return canvas;
}

async function updateCanvas(
  ctx: Context,
  designId: string,
  canvasId: string,
  fn: (canvas: Canvas) => Canvas,
): Promise<Canvas> {
  return (await ctx.hub.open(designId)).updateCanvas(canvasId, fn, ctx.by);
}

/** The changes a comment takes, for the wire and for `/mcp`. */
export const commentEdit = {
  reply:
    (text: string, by: Actor) =>
    (comment: Comment): Comment => ({
      ...comment,
      replies: [...comment.replies, { id: randomUUID(), author: by, text, createdAt: Date.now() }],
    }),
  resolve: (comment: Comment): Comment => ({ ...comment, resolvedAt: Date.now() }),
  reopen: (comment: Comment): Comment => without(comment, "resolvedAt"),
};

export function updateComment(
  open: OpenDesign,
  canvasId: string,
  commentId: string,
  fn: (comment: Comment) => Comment,
  by: Actor,
): Promise<Canvas> {
  return open.updateCanvas(
    canvasId,
    (canvas) => {
      if (!canvas.comments.some((c) => c.id === commentId)) {
        throw new Refused(`no comment ${commentId} on this canvas`, "not-found");
      }
      return { ...canvas, comments: canvas.comments.map((c) => (c.id === commentId ? fn(c) : c)) };
    },
    by,
  );
}

async function updateThread(
  ctx: Context,
  designId: string,
  threadId: string,
  fn: (meta: ThreadMeta) => ThreadMeta,
): Promise<ThreadMeta> {
  return (await ctx.hub.open(designId)).updateThread(threadId, (meta) => ({
    ...fn(meta),
    updatedAt: Date.now(),
  }));
}

/** A copy of `value` without `keys`, for clearing optional fields. */
function without<T extends object, K extends keyof T>(value: T, ...keys: K[]): Omit<T, K> {
  const copy = { ...value };
  for (const key of keys) delete copy[key];
  return copy;
}
