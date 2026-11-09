import { z } from "zod";
import {
  Canvas,
  CanvasKind,
  CanvasPatch,
  ClaudeStatus,
  CommentAnchor,
  ComponentInfo,
  Design,
  DesignEntry,
  EffortLevel,
  Id,
  InstallState,
  Inline,
  Loc,
  NewNode,
  PreviewState,
  RefusalCode,
  Rect,
  Remap,
  Rev,
  Route,
  Selection,
  SendMode,
  Settings,
  SourceEdit,
  ThreadEvent,
  ThreadMeta,
  Token,
  TokenMode,
  User,
} from "./model.ts";

export const PROTOCOL_VERSION = 1;

/** The path of the one WebSocket each tab opens. */
export const WS_PATH = "/api/ws";

const designId = Id;

/** What `subscribe` returns: everything a design screen needs to draw. */
export const DesignState = z.object({
  design: Design,
  canvases: z.array(Canvas),
  threads: z.array(ThreadMeta),
  preview: PreviewState,
  routes: z.array(Route),
  /** The dependency install a new design waits on, while it runs or after it failed. */
  install: InstallState.optional(),
});
export type DesignState = z.infer<typeof DesignState>;

const ref = { designId, threadId: Id };

/**
 * Every request a client sends on `/api/ws`, keyed by `type`, with the shape of its reply value.
 * `rid` is added by {@link ClientMessage}.
 */
export const requests = {
  hello: { params: { user: User }, result: z.object({ version: z.number(), user: User }) },

  "designs.list": { params: {}, result: z.array(DesignEntry) },
  "design.create": {
    params: {
      name: z.string().min(1),
      kind: z.enum(["blank", "import"]),
      /** What to import from: a Figma link, a URL, or attachment paths. */
      source: z.string().optional(),
    },
    result: DesignEntry,
  },
  "design.connect": { params: { path: z.string().min(1) }, result: DesignEntry },
  /** Clones a git repo into `path` (a leading `~` is the home folder), then connects the clone. */
  "design.clone": {
    params: { url: z.string().min(1), path: z.string().min(1) },
    result: DesignEntry,
  },
  /** The folders inside `path` (a leading `~` is the home folder), for the path picker. */
  "fs.list": {
    params: { path: z.string().min(1) },
    result: z.object({
      /** The folder that was listed, as an absolute path. */
      path: z.string(),
      /** Folder names, without the path, sorted, hidden ones left out. */
      dirs: z.array(z.string()),
    }),
  },
  /** GitHub repos matching `query`, or the one repo a pasted URL or `owner/name` names. */
  "repo.search": {
    params: { query: z.string().min(1) },
    result: z.array(
      z.object({
        /** `owner/name`. */
        name: z.string(),
        url: z.string(),
        description: z.string().optional(),
        language: z.string().optional(),
        stars: z.number().optional(),
      }),
    ),
  },
  "design.rename": { params: { id: designId, name: z.string().min(1) }, result: DesignEntry },
  "design.remove": { params: { id: designId }, result: z.null() },
  /** Starts a setup thread on the design, which writes `finite.json` and calls `finish_setup`. */
  "design.setup": { params: { designId }, result: z.object({ threadId: Id }) },

  subscribe: { params: { designId }, result: DesignState },
  unsubscribe: { params: { designId }, result: z.null() },

  "canvas.create": {
    params: { designId, kind: CanvasKind, name: z.string().min(1), threadId: Id.optional() },
    result: Canvas,
  },
  "canvas.rename": { params: { designId, canvasId: Id, name: z.string().min(1) }, result: Canvas },
  "canvas.remove": { params: { designId, canvasId: Id }, result: Canvas },
  "canvas.restore": { params: { designId, canvasId: Id }, result: Canvas },
  "canvas.patch": { params: { designId, canvasId: Id, patch: CanvasPatch }, result: Canvas },
  /** Takes back (or redoes) this person's last `canvas.patch` on the canvas. */
  "canvas.undo": { params: { designId, canvasId: Id }, result: Canvas },
  "canvas.redo": { params: { designId, canvasId: Id }, result: Canvas },

  "source.edit": {
    /** `canvasId` is the canvas the edit was made on: a prototype refuses edits outside `.finite/`. */
    params: { designId, canvasId: Id, edits: z.array(SourceEdit).min(1) },
    /** `created` is the loc of each new node that named a `ref`. */
    result: z.object({ remap: Remap, created: z.record(z.string(), Loc) }),
  },
  "source.undo": { params: { designId }, result: z.null() },
  "source.redo": { params: { designId }, result: z.null() },
  /** Copies a production file into the prototype's board and, given an `importer`, points it at the copy. */
  "source.detach": {
    params: { designId, canvasId: Id, file: z.string(), importer: z.string().optional() },
    result: z.object({ file: z.string() }),
  },
  /** The element's children as editable runs. `keeps` lists what the runs hold but can't change. */
  "source.inline": {
    params: { designId, loc: Loc },
    result: z.object({
      rev: Rev,
      content: z.array(Inline),
      keeps: z.array(
        z.object({
          id: z.number().int().min(0),
          kind: z.string(),
          label: z.string(),
          loc: Loc.optional(),
        }),
      ),
    }),
  },

  /** Writes a board file holding `node` and adds a frame for it at `box`. */
  "canvas.draw": {
    params: { designId, canvasId: Id, box: Rect, name: z.string(), node: NewNode },
    result: z.object({
      canvas: Canvas,
      frameId: Id,
      file: z.string(),
      created: z.record(z.string(), Loc),
    }),
  },
  /** Renders a slice to a PNG in Chrome. `url` is a `data:` URL, ready for a download link. */
  "canvas.exportSlice": {
    params: { designId, canvasId: Id, sliceId: Id },
    result: z.object({ url: z.string() }),
  },
  /** Copies an attachment into the design's brand folder. `asset` is what `NewNode.src` names. */
  "asset.add": {
    params: { designId, attachment: z.string() },
    result: z.object({ asset: z.string() }),
  },

  "comment.add": {
    params: {
      designId,
      canvasId: Id,
      anchor: CommentAnchor,
      text: z.string().min(1),
      /** An annotation is a note that stays on the canvas; no agent is asked to act on it. */
      kind: z.enum(["comment", "annotation"]).optional(),
    },
    result: Canvas,
  },
  "comment.reply": {
    params: { designId, canvasId: Id, commentId: Id, text: z.string().min(1) },
    result: Canvas,
  },
  "comment.resolve": { params: { designId, canvasId: Id, commentId: Id }, result: Canvas },
  "comment.reopen": { params: { designId, canvasId: Id, commentId: Id }, result: Canvas },

  "thread.send": {
    /** Exactly one of `threadId` (an existing thread) and `new` (start one). */
    params: {
      designId,
      threadId: Id.optional(),
      new: z
        .object({
          canvasId: Id.optional(),
          parentId: Id.optional(),
          /** Makes a prototype canvas for the thread (instead of `canvasId`), named with it. */
          prototype: z.boolean().optional(),
        })
        .optional(),
      text: z.string().min(1),
      /** Paths returned by `POST /api/designs/:id/attachments`. */
      attachments: z.array(z.string()),
      selection: z.array(Selection).optional(),
      model: z.string(),
      effort: EffortLevel.optional(),
      fast: z.boolean(),
      mode: SendMode,
    },
    result: z.object({ threadId: Id }),
  },
  /** Edits a queued message's text, or drops it with `null`. */
  "thread.queued": {
    params: { ...ref, queuedId: Id, text: z.string().nullable() },
    result: ThreadMeta,
  },
  "thread.interrupt": { params: ref, result: z.null() },
  /** `until: null` wakes it. */
  "thread.snooze": { params: { ...ref, until: z.number().nullable() }, result: ThreadMeta },
  "thread.settle": { params: { ...ref, settled: z.boolean() }, result: ThreadMeta },
  "thread.rename": { params: { ...ref, title: z.string().min(1) }, result: ThreadMeta },
  "thread.history": { params: ref, result: z.array(ThreadEvent) },

  "settings.get": { params: {}, result: Settings },
  "settings.set": { params: { settings: Settings.partial() }, result: Settings },
  "claude.status": { params: {}, result: ClaudeStatus },

  "tokens.get": { params: { designId }, result: z.array(Token) },
  /** `value: null` removes the token from that mode. */
  "tokens.set": {
    params: { designId, name: z.string().min(1), mode: TokenMode, value: z.string().nullable() },
    result: z.array(Token),
  },
  "components.list": { params: { designId }, result: z.array(ComponentInfo) },

  /** What a frame's bridge reported: runtime errors, rejections, console.error. */
  "frame.error": {
    params: {
      designId,
      frameId: Id,
      kind: z.enum(["error", "rejection", "console"]),
      message: z.string(),
      stack: z.string().optional(),
      loc: Loc.optional(),
    },
    result: z.null(),
  },
} as const satisfies Record<string, { params: z.ZodRawShape; result: z.ZodType }>;

export type RequestType = keyof typeof requests;

type RequestShape<K extends RequestType> = {
  type: z.ZodLiteral<K>;
  rid: z.ZodString;
} & (typeof requests)[K]["params"] extends infer S extends z.ZodRawShape
  ? S
  : never;
type RequestSchema<K extends RequestType> = z.ZodObject<RequestShape<K>>;

function requestSchema<K extends RequestType>(type: K): RequestSchema<K> {
  const shape = { type: z.literal(type), rid: z.string().min(1), ...requests[type].params };
  return z.object(shape) as unknown as RequestSchema<K>;
}

const requestSchemas = Object.fromEntries(
  (Object.keys(requests) as RequestType[]).map((k) => [k, requestSchema(k)]),
) as { [K in RequestType]: RequestSchema<K> };

const threadSend = requestSchemas["thread.send"].refine(
  (m) => (m.threadId === undefined) !== (m.new === undefined),
  "thread.send needs exactly one of threadId and new",
);

export const ClientMessage = z.discriminatedUnion("type", [
  ...(Object.values(requestSchemas).filter((s) => s !== requestSchemas["thread.send"]) as [
    RequestSchema<Exclude<RequestType, "thread.send">>,
    ...RequestSchema<Exclude<RequestType, "thread.send">>[],
  ]),
  threadSend,
]);
export type ClientMessage = { [K in RequestType]: z.infer<RequestSchema<K>> }[RequestType];

/** A request of one type, `rid` and `type` included. */
export type Request<K extends RequestType> = Extract<ClientMessage, { type: K }>;
/** What a caller passes for a request: the message without `type` and `rid`. */
export type Params<K extends RequestType> = Omit<Request<K>, "type" | "rid">;
/** The reply value of a request. */
export type Result<K extends RequestType> = z.infer<(typeof requests)[K]["result"]>;

export const results = Object.fromEntries(
  (Object.keys(requests) as RequestType[]).map((k) => [k, requests[k].result]),
) as { [K in RequestType]: (typeof requests)[K]["result"] };

// Server to client

export const Reply = z.union([
  z.object({ type: z.literal("reply"), rid: z.string(), ok: z.literal(true), value: z.unknown() }),
  z.object({
    type: z.literal("reply"),
    rid: z.string(),
    ok: z.literal(false),
    reason: z.string(),
    code: RefusalCode.optional(),
  }),
]);
export type Reply = z.infer<typeof Reply>;

export const ServerEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("designs"), list: z.array(DesignEntry) }),
  /** The whole canvas, after any change to it. */
  z.object({ type: z.literal("canvas"), designId, canvas: Canvas }),
  z.object({ type: z.literal("thread"), designId, meta: ThreadMeta }),
  z.object({ type: z.literal("thread.event"), designId, threadId: Id, event: ThreadEvent }),
  z.object({ type: z.literal("preview"), designId, ...PreviewState.shape }),
  z.object({ type: z.literal("routes"), designId, routes: z.array(Route) }),
  /** A new design's dependency install (the designs list shows it through `installing`). */
  z.object({ type: z.literal("install"), designId, install: InstallState }),
  z.object({ type: z.literal("settings"), settings: Settings }),
  /** A setup thread's `finish_setup` passed: the design to show now (`next`, maybe the same one). */
  z.object({ type: z.literal("setup.done"), designId, next: Id }),
]);
export type ServerEvent = z.infer<typeof ServerEvent>;

export const ServerMessage = z.union([Reply, ServerEvent]);
export type ServerMessage = z.infer<typeof ServerMessage>;

/** A readable one-line reason for a zod failure, e.g. `canvas.patch: patch.frames.0.x: expected number`. */
export function describeIssues(error: z.ZodError, prefix?: string): string {
  const issue = error.issues[0];
  if (!issue) return prefix ? `${prefix}: invalid message` : "invalid message";
  const where = issue.path.length ? `${issue.path.join(".")}: ` : "";
  const more = error.issues.length > 1 ? ` (and ${error.issues.length - 1} more)` : "";
  return `${prefix ? `${prefix}: ` : ""}${where}${issue.message}${more}`;
}

/** Parses one client frame, or says what's wrong with it. */
export function parseClientMessage(
  data: unknown,
): { ok: true; message: ClientMessage } | { ok: false; rid?: string; reason: string } {
  let json: unknown = data;
  if (typeof data === "string") {
    try {
      json = JSON.parse(data);
    } catch {
      return { ok: false, reason: "message isn't JSON" };
    }
  }
  const rid =
    typeof json === "object" && json !== null && typeof (json as { rid?: unknown }).rid === "string"
      ? (json as { rid: string }).rid
      : undefined;
  const type =
    typeof json === "object" && json !== null ? (json as { type?: unknown }).type : undefined;
  if (typeof type !== "string" || !(type in requests)) {
    return {
      ok: false,
      ...(rid === undefined ? {} : { rid }),
      reason: `unknown message type ${JSON.stringify(type)}`,
    };
  }
  const parsed = ClientMessage.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      ...(rid === undefined ? {} : { rid }),
      reason: describeIssues(parsed.error, type),
    };
  }
  return { ok: true, message: parsed.data as ClientMessage };
}
