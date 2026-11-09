import { z } from "zod";

/** A JSX opening element: `"src/pages/Home.tsx:12:4"`, a posix path relative to the design root, line, column. */
export const Loc = z.string().regex(/^[^:]+:\d+:\d+$/, "a loc looks like src/App.tsx:12:4");
export type Loc = z.infer<typeof Loc>;

/** The first 8 hex digits of the sha1 of a file's source when Vite transformed it (`data-finite-rev`). */
export const Rev = z.string().regex(/^[0-9a-f]{8}$/, "a rev is 8 hex digits");
export type Rev = z.infer<typeof Rev>;

export const Id = z.string().min(1);

export const User = z.object({ id: Id, name: z.string() });
export type User = z.infer<typeof User>;

/** Who made a change. An agent's id is its thread id. */
export const Actor = z.object({
  kind: z.enum(["person", "agent"]),
  id: Id,
  name: z.string(),
});
export type Actor = z.infer<typeof Actor>;

export const EffortLevel = z.enum(["low", "medium", "high", "xhigh", "max"]);
export type EffortLevel = z.infer<typeof EffortLevel>;

export const Rect = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});
export type Rect = z.infer<typeof Rect>;

// Designs

export const DesignOrigin = z.enum(["connected", "blank", "import"]);
export type DesignOrigin = z.infer<typeof DesignOrigin>;
/** `next-app` is Next.js's App Router (`app/`), `next-pages` its Pages Router (`pages/`). */
export const Router = z.enum(["react-router", "tanstack", "next-app", "next-pages", "none"]);
export type Router = z.infer<typeof Router>;
export const Styling = z.enum(["tailwind", "css-modules", "inline", "stylex"]);
export type Styling = z.infer<typeof Styling>;

/** One row of `$FINITE_DATA_DIR/designs.json`. A connected root is a reference and is never deleted. */
export const DesignEntry = z.object({
  id: Id,
  name: z.string(),
  root: z.string(),
  origin: DesignOrigin,
  /** When anything in the design last changed: a canvas, a thread, its name. */
  updatedAt: z.number().default(0),
  /** Set while a new design's dependencies install. Never stored. */
  installing: z.boolean().optional(),
  /** The absolute folder holding the `finite.json` that lists this design's app. */
  workspace: z.string().optional(),
  /** The app's name in that `finite.json`. */
  app: z.string().optional(),
  /** A folder Finite couldn't run yet, waiting for its setup thread to write `finite.json`. */
  setup: z.boolean().optional(),
  /** A setup design whose `.finite/` Finite made when it connected; removing it deletes that folder. */
  madeFinite: z.boolean().optional(),
});
export type DesignEntry = z.infer<typeof DesignEntry>;

/** `<root>/.finite/design.json`. */
export const DesignConfig = z.object({
  version: z.literal(1),
  id: Id,
  router: Router,
  styling: Styling,
  /** Stylesheets every frame imports, relative to the root. */
  css: z.array(z.string()),
  /** Providers frames render inside, relative to the root (default `.finite/Wrapper.tsx` when present). */
  wrapper: z.string().optional(),
  brandDir: z.string(),
});
export type DesignConfig = z.infer<typeof DesignConfig>;

export const Design = DesignEntry.omit({ updatedAt: true, installing: true }).extend({
  router: Router,
  styling: Styling,
  css: z.array(z.string()),
  wrapper: z.string().optional(),
  brandDir: z.string(),
});
export type Design = z.infer<typeof Design>;

// Workspaces

/** An app or service name in `finite.json`. */
const WorkspaceName = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*$/, "a name is lowercase letters, digits and hyphens");
const Env = z.record(z.string(), z.string());
/** A route frame's values for its dynamic segments, like `{ "userId": "42" }`. */
const RouteParams = z.record(z.string(), z.string());

/** An app in `finite.json`: one design. `path` is relative to the workspace root (`"."` allowed). */
export const FiniteApp = z.strictObject({
  path: z.string().min(1),
  /** Commands run in the app folder after the workspace `setup`. */
  setup: z.array(z.string()).optional(),
  /** The services its dev server needs. */
  needs: z.array(z.string()).optional(),
  env: Env.optional(),
  /**
   * Values for the routes' dynamic segments, keyed by the route path as the router reports it
   * (`/users/:userId`): one params object, or an array for one frame each. A path the router
   * doesn't report is added as a custom route.
   */
  routes: z.record(z.string(), z.union([RouteParams, z.array(RouteParams)])).optional(),
});
export type FiniteApp = z.infer<typeof FiniteApp>;

/**
 * A long-running process an app needs. `ready` is a URL (ready when a GET answers below 500) or a
 * port (ready when a TCP connect to 127.0.0.1 succeeds); without it, ready once spawned.
 */
export const FiniteService = z.strictObject({
  run: z.string().min(1),
  /** Relative to the workspace root (default the root). */
  cwd: z.string().optional(),
  ready: z.union([z.string().min(1), z.number().int().min(1).max(65535)]).optional(),
  needs: z.array(z.string()).optional(),
  env: Env.optional(),
});
export type FiniteService = z.infer<typeof FiniteService>;

/** `<workspace>/finite.json`, committed with the project: commands and non-secret env only. */
export const FiniteJson = z.strictObject({
  $schema: z.string().optional(),
  /** Commands run in order in the workspace root before any app's dev server starts. */
  setup: z.array(z.string()).optional(),
  /** Added to every setup command, service and dev server. */
  env: Env.optional(),
  apps: z
    .record(WorkspaceName, FiniteApp)
    .refine((apps) => Object.keys(apps).length > 0, "list at least one app"),
  services: z.record(WorkspaceName, FiniteService).optional(),
});
export type FiniteJson = z.infer<typeof FiniteJson>;

// Canvases

export const FrameSource = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("route"),
    path: z.string(),
    params: z.record(z.string(), z.string()).optional(),
  }),
  z.object({ kind: z.literal("file"), file: z.string(), exportName: z.string().optional() }),
]);
export type FrameSource = z.infer<typeof FrameSource>;

export const Frame = z.object({
  id: Id,
  name: z.string(),
  x: z.number(),
  y: z.number(),
  width: z.number().positive(),
  height: z.number().positive(),
  /** Height follows the content. */
  hug: z.boolean().optional(),
  /** The route this frame shows is no longer in the app. The frame stays until someone removes it. */
  gone: z.boolean().optional(),
  source: FrameSource,
  /** The agent that placed it, so its thread may remove it again. */
  placedBy: Actor.optional(),
});
export type Frame = z.infer<typeof Frame>;

export const TextLabel = z.object({
  id: Id,
  x: z.number(),
  y: z.number(),
  width: z.number().positive(),
  title: z.string(),
  body: z.string(),
  author: Actor,
});
export type TextLabel = z.infer<typeof TextLabel>;

/** A pin on an element (`index` = which rendered instance of `loc`) or on the canvas. */
export const CommentAnchor = z.union([
  z.object({ frameId: Id, loc: Loc.optional(), index: z.number().int().min(0).optional() }),
  z.object({ x: z.number(), y: z.number() }),
]);
export type CommentAnchor = z.infer<typeof CommentAnchor>;

export const CommentReply = z.object({
  id: Id,
  author: Actor,
  text: z.string(),
  createdAt: z.number(),
});
export type CommentReply = z.infer<typeof CommentReply>;

export const Comment = z.object({
  id: Id,
  anchor: CommentAnchor,
  /** An annotation stays on the canvas as a note; absent means a comment. */
  kind: z.enum(["comment", "annotation"]).optional(),
  author: Actor,
  text: z.string(),
  replies: z.array(CommentReply),
  createdAt: z.number(),
  resolvedAt: z.number().optional(),
});
export type Comment = z.infer<typeof Comment>;

/** A named region of the canvas. Which frames it holds is geometry, read when it's dragged. */
export const Section = z.object({
  id: Id,
  name: z.string(),
  x: z.number(),
  y: z.number(),
  width: z.number().positive(),
  height: z.number().positive(),
  author: Actor,
});
export type Section = z.infer<typeof Section>;

/** A region of one frame marked for export. Its box is in the frame's own CSS pixels. */
export const Slice = z.object({
  id: Id,
  frameId: Id,
  name: z.string(),
  x: z.number(),
  y: z.number(),
  width: z.number().positive(),
  height: z.number().positive(),
});
export type Slice = z.infer<typeof Slice>;

export const CanvasKind = z.enum(["page", "prototype"]);
export type CanvasKind = z.infer<typeof CanvasKind>;

/**
 * `<root>/.finite/canvases/<id>.json`. A removed canvas keeps `removedAt` for 30 days, then goes.
 * Canvases list in `createdAt` order; files written before it existed have none and come first.
 */
export const Canvas = z.object({
  id: Id,
  kind: CanvasKind,
  name: z.string(),
  threadIds: z.array(Id),
  frames: z.array(Frame),
  texts: z.array(TextLabel),
  comments: z.array(Comment),
  sections: z.array(Section).default([]),
  slices: z.array(Slice).default([]),
  createdAt: z.number().optional(),
  updatedAt: z.number(),
  removedAt: z.number().optional(),
});
export type Canvas = z.infer<typeof Canvas>;

export const CanvasPatch = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("moveFrames"),
    frames: z.array(z.object({ id: Id, x: z.number(), y: z.number() })),
  }),
  z.object({
    op: z.literal("resizeFrames"),
    frames: z.array(
      z.object({
        id: Id,
        x: z.number(),
        y: z.number(),
        width: z.number().positive(),
        height: z.number().positive(),
        hug: z.boolean().optional(),
      }),
    ),
  }),
  z.object({ op: z.literal("addFrames"), frames: z.array(Frame) }),
  z.object({ op: z.literal("removeFrames"), frameIds: z.array(Id) }),
  z.object({ op: z.literal("renameFrame"), frameId: Id, name: z.string() }),
  z.object({ op: z.literal("moveFramesTo"), frameIds: z.array(Id), toCanvasId: Id }),
  /** Adds the text, or replaces the one with its id. */
  z.object({ op: z.literal("setText"), text: TextLabel }),
  z.object({ op: z.literal("removeText"), textId: Id }),
  /** Adds the section, or replaces the one with its id. */
  z.object({ op: z.literal("setSection"), section: Section }),
  z.object({ op: z.literal("removeSection"), sectionId: Id }),
  /** Moves a section with the frames and labels inside it, as one step. */
  z.object({
    op: z.literal("moveSection"),
    sectionId: Id,
    x: z.number(),
    y: z.number(),
    frames: z.array(z.object({ id: Id, x: z.number(), y: z.number() })),
    texts: z.array(z.object({ id: Id, x: z.number(), y: z.number() })),
  }),
  /** Adds the slice, or replaces the one with its id. */
  z.object({ op: z.literal("setSlice"), slice: Slice }),
  z.object({ op: z.literal("removeSlice"), sliceId: Id }),
]);
export type CanvasPatch = z.infer<typeof CanvasPatch>;

// Threads

/**
 * What a person picked: a whole frame (no `loc`), or one rendered element in it (`index` is which
 * instance of `loc` in the frame, default 0).
 */
export const Selection = z.object({
  frameId: Id,
  loc: Loc.optional(),
  index: z.number().int().min(0).optional(),
});
export type Selection = z.infer<typeof Selection>;

/** A message waiting to run after the current turn. People can edit or drop it. */
export const Queued = z.object({
  id: Id,
  text: z.string(),
  attachments: z.array(z.string()),
  selection: z.array(Selection).optional(),
  by: Actor,
});
export type Queued = z.infer<typeof Queued>;

/** `<root>/.finite/threads/<id>.json`. */
export const ThreadMeta = z.object({
  id: Id,
  title: z.string(),
  parentId: Id.optional(),
  canvasIds: z.array(Id),
  running: z.boolean(),
  /** When the agent last handed the turn back to people. */
  awaitingSince: z.number().optional(),
  snoozedUntil: z.number().optional(),
  settledAt: z.number().optional(),
  model: z.string(),
  effort: EffortLevel.optional(),
  fast: z.boolean(),
  queued: z.array(Queued),
  sessionId: z.string().optional(),
  /** A setup thread: it writes the workspace's `finite.json` and ends with `finish_setup`. */
  setup: z.boolean().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type ThreadMeta = z.infer<typeof ThreadMeta>;

export const Usage = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  costUsd: z.number().optional(),
});
export type Usage = z.infer<typeof Usage>;

/** One line of `<root>/.finite/threads/<id>.jsonl`. `text.delta` is streamed live and never stored. */
export const ThreadEvent = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("user"),
    text: z.string(),
    attachments: z.array(z.string()),
    selection: z.array(Selection).optional(),
    by: Actor,
    at: z.number(),
  }),
  z.object({ type: z.literal("text.delta"), text: z.string() }),
  z.object({ type: z.literal("text"), text: z.string(), at: z.number() }),
  z.object({
    type: z.literal("tool"),
    id: z.string(),
    name: z.string(),
    summary: z.string(),
    status: z.enum(["running", "done", "error"]),
    at: z.number(),
  }),
  z.object({ type: z.literal("result"), usage: Usage, at: z.number() }),
  z.object({ type: z.literal("error"), message: z.string(), at: z.number() }),
]);
export type ThreadEvent = z.infer<typeof ThreadEvent>;

export const SendMode = z.enum(["steer", "queue"]);
export type SendMode = z.infer<typeof SendMode>;

/** `$FINITE_DATA_DIR/settings.json`. */
export const Settings = z.object({
  model: z.string(),
  effort: EffortLevel,
  fast: z.boolean(),
  sendMode: SendMode,
  showWorkingSeparately: z.boolean(),
});
export type Settings = z.infer<typeof Settings>;

export const ThreadSection = z.enum(["working", "active", "snoozed", "settled"]);
export type ThreadSection = z.infer<typeof ThreadSection>;

/**
 * Where a thread sits in the prototypes list. With `showWorkingSeparately` off, running threads
 * stay in Active (with a spinner). Sending a message clears snooze and settle, which revives it.
 */
export function threadSection(
  meta: Pick<ThreadMeta, "running" | "snoozedUntil" | "settledAt">,
  now: number,
  showWorkingSeparately: boolean,
): ThreadSection {
  if (meta.running) return showWorkingSeparately ? "working" : "active";
  if (meta.snoozedUntil !== undefined && meta.snoozedUntil > now) return "snoozed";
  if (meta.settledAt !== undefined) return "settled";
  return "active";
}

// Claude

export const ModelInfo = z.object({
  value: z.string(),
  displayName: z.string(),
  description: z.string(),
  supportedEffortLevels: z.array(EffortLevel).optional(),
  supportsFastMode: z.boolean().optional(),
});
export type ModelInfo = z.infer<typeof ModelInfo>;

export const ClaudeStatus = z.object({
  installed: z.boolean(),
  loggedIn: z.boolean(),
  /** What the person should do before agents can run, when they can't. */
  reason: z.string().optional(),
  version: z.string().optional(),
  email: z.string().optional(),
  models: z.array(ModelInfo),
});
export type ClaudeStatus = z.infer<typeof ClaudeStatus>;

// Previews, source and tokens

export const Route = z.object({
  path: z.string(),
  /** The route module, relative to the root, when the router names one. */
  file: z.string().optional(),
  /** Dynamic segments (`:id`, `$id`, `[id]`) a frame must fill in. */
  params: z.array(z.string()),
});
export type Route = z.infer<typeof Route>;

/** `needs-setup`: a setup design, which has no preview until its `finite.json` is written. */
export const PreviewStatus = z.enum(["stopped", "starting", "ready", "error", "needs-setup"]);
export type PreviewStatus = z.infer<typeof PreviewStatus>;

export const PreviewState = z.object({
  status: PreviewStatus,
  url: z.string().optional(),
  /** The tail of the dev server's output, shown when it fails. */
  log: z.string().optional(),
});
export type PreviewState = z.infer<typeof PreviewState>;

/** A new design's dependency install. */
export const InstallState = z.object({
  status: z.enum(["running", "done", "error"]),
  /** The tail of the package manager's output. */
  log: z.string(),
});
export type InstallState = z.infer<typeof InstallState>;

export const FrameError = z.object({
  frameId: Id,
  kind: z.enum(["error", "rejection", "console"]),
  message: z.string(),
  stack: z.string().optional(),
  at: z.number(),
});
export type FrameError = z.infer<typeof FrameError>;

/** New JSX as data, never as code: nothing on the wire can become an expression. */
export type NewNode = {
  /** An intrinsic element's name. */
  tag: string;
  /** The client's name for this node, answered in `created` with its loc. */
  ref?: string | undefined;
  /** The layer name, written as `data-name`. */
  name?: string | undefined;
  /** Geometry and other non-CSS attributes: `d`, `viewBox`, `alt`. */
  attrs?: Record<string, string> | undefined;
  /** Applied through the same path as a style edit, so every styling convention works. */
  styles?: Record<string, string> | undefined;
  /** A file from `asset.add`, written as an ES import and `src={name}`. */
  src?: { asset: string } | undefined;
  text?: string | undefined;
  children?: NewNode[] | undefined;
};
export const NEW_TAG = /^[a-z][a-zA-Z0-9]*$/;
const newNodeFields = {
  tag: z.string().regex(NEW_TAG, "a new element's tag is an intrinsic name, like div"),
  ref: z.string().min(1).optional(),
  name: z.string().optional(),
  attrs: z.record(z.string(), z.string()).optional(),
  styles: z.record(z.string(), z.string()).optional(),
  src: z.object({ asset: z.string().min(1) }).optional(),
};
export const NewNode: z.ZodType<NewNode> = z.lazy(() =>
  z.object({
    ...newNodeFields,
    text: z.string().optional(),
    children: z.array(NewNode).optional(),
  }),
);

/** Inside the anchor element at its `start` or `end`, or beside it `before` or `after`. */
export const InsertPlace = z.enum(["start", "end", "before", "after"]);
export type InsertPlace = z.infer<typeof InsertPlace>;

/** One formatting wrapper on a run of inline text. `keep` reprints an existing wrapper verbatim. */
export const Mark = z.discriminatedUnion("m", [
  z.object({ m: z.enum(["strong", "b", "em", "i", "u", "s", "del"]) }),
  z.object({
    m: z.literal("span"),
    styles: z.record(z.string(), z.string()),
    ref: z.string().optional(),
  }),
  z.object({ m: z.literal("a"), href: z.string() }),
  z.object({ m: z.literal("keep"), id: z.number().int().min(0) }),
]);
export type Mark = z.infer<typeof Mark>;

/** Inline content as data. An `atom` is an expression, component or comment, kept verbatim. */
export const Inline = z.discriminatedUnion("t", [
  z.object({ t: z.literal("text"), text: z.string(), marks: z.array(Mark) }),
  z.object({ t: z.literal("br"), marks: z.array(Mark).optional() }),
  z.object({ t: z.literal("atom"), id: z.number().int().min(0), marks: z.array(Mark).optional() }),
]);
export type Inline = z.infer<typeof Inline>;

/** A hand edit. `revs` holds the rev of every file the edit's locs point into. */
const revs = z.record(z.string(), Rev);
export const SourceEdit = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("style"),
    locs: z.array(Loc).min(1),
    tag: z.string(),
    styles: z.record(z.string(), z.string().nullable()),
    revs,
  }),
  z.object({
    kind: z.literal("reorder"),
    loc: Loc,
    tag: z.string(),
    before: Loc.nullable(),
    revs,
  }),
  z.object({ kind: z.literal("remove"), locs: z.array(Loc).min(1), revs }),
  z.object({ kind: z.literal("duplicate"), locs: z.array(Loc).min(1), revs }),
  z.object({
    kind: z.literal("attr"),
    loc: Loc,
    name: z.string(),
    value: z.string().nullable(),
    revs,
  }),
  /** Adds `node` beside or inside the element at `loc`. */
  z.object({
    kind: z.literal("insert"),
    loc: Loc,
    tag: z.string(),
    place: InsertPlace,
    node: NewNode,
    revs,
  }),
  /** Puts the elements at `locs` inside a new `wrapper`. */
  z.object({
    kind: z.literal("wrap"),
    locs: z.array(Loc).min(1),
    wrapper: z.object(newNodeFields),
    revs,
  }),
  /** Replaces the element at `loc` with its children. */
  z.object({ kind: z.literal("unwrap"), loc: Loc, tag: z.string(), revs }),
  /** Replaces the children of the element at `loc` with `content`. */
  z.object({
    kind: z.literal("inline"),
    loc: Loc,
    tag: z.string(),
    content: z.array(Inline),
    revs,
  }),
]);
export type SourceEdit = z.infer<typeof SourceEdit>;

/** Where each edited loc moved to, so the selection follows the element. */
export const Remap = z.record(z.string(), Loc);
export type Remap = z.infer<typeof Remap>;

export const TokenMode = z.enum(["light", "dark"]);
export type TokenMode = z.infer<typeof TokenMode>;

/**
 * A CSS custom property from the design's `@theme` (light) and `.dark` (dark) blocks, a top-level
 * Sass `$name` or Less `@name` from its global sheets, which has a light value only, or a StyleX
 * design's `defineVars` key, named `<group>.<key>`.
 */
export const Token = z.object({
  name: z.string(),
  light: z.string().optional(),
  dark: z.string().optional(),
});
export type Token = z.infer<typeof Token>;

export const ComponentInfo = z.object({
  name: z.string(),
  file: z.string(),
  exportName: z.string(),
});
export type ComponentInfo = z.infer<typeof ComponentInfo>;

// Refusals

/** Machine-readable reasons the UI reacts to. Every refusal also has a human-readable reason. */
export const RefusalCode = z.enum([
  "invalid",
  "not-found",
  "stale",
  "outside-prototype",
  "unsupported-style",
  "unsupported-project",
  /** A `finite.json` that doesn't parse or validate; the reason lists every problem. */
  "invalid-config",
  "not-logged-in",
  "not-implemented",
]);
export type RefusalCode = z.infer<typeof RefusalCode>;

/** Thrown by server modules when a request can't be done; the hub replies with its message and code. */
export class Refused extends Error {
  readonly code: RefusalCode | undefined;
  constructor(reason: string, code?: RefusalCode) {
    super(reason);
    this.name = "Refused";
    this.code = code;
  }
}
