import type {
  Actor,
  Canvas,
  CanvasKind,
  CanvasPatch,
  ClaudeStatus,
  ComponentInfo,
  Design,
  DesignEntry,
  Frame,
  FrameError,
  FrameSource,
  Inline,
  InstallState,
  Loc,
  NewNode,
  PreviewState,
  Rect,
  Remap,
  Rev,
  Route,
  Selection,
  SendMode,
  Settings,
  SourceEdit,
  EffortLevel,
  ThreadEvent,
  ThreadMeta,
  Token,
  TokenMode,
} from "./model.ts";

/**
 * The contracts between the server's modules. Each module throws `Refused` (with a reason a
 * person or agent can act on) when it can't do something; anything else is a bug.
 */

export type Unsubscribe = () => void;

export interface Store {
  designs(): Promise<DesignEntry[]>;
  create(input: { name: string; kind: "blank" | "import"; source?: string }): Promise<DesignEntry>;
  /**
   * Connects a folder. With a `finite.json` at or above it, its workspace root connects every app
   * it lists (returning the first) and an app folder connects that app; an invalid one is refused
   * (`invalid-config`). Else a folder detection refuses becomes a setup design (`setup: true`).
   */
  connect(path: string): Promise<DesignEntry>;
  /**
   * Reads the design's `finite.json` and connects every app in it, or refuses (`invalid-config`)
   * listing what to fix. A setup design whose folder is one of the apps becomes it; otherwise
   * `replaced` is set and the caller removes it. Emits `setup.done` with `next`.
   */
  finishSetup(id: string): Promise<{ apps: DesignEntry[]; next: DesignEntry; replaced: boolean }>;
  rename(id: string, name: string): Promise<DesignEntry>;
  /** Forgets the design. A connected root stays on disk; a setup design's `.finite/` is deleted. */
  remove(id: string): Promise<void>;
  open(id: string): Promise<OpenDesign>;
  /**
   * Looks the design's `finite.json` up again, giving it `workspace` and `app` when one lists it
   * and taking them away when none does. An invalid `finite.json` leaves the design as it is.
   */
  relink(id: string): Promise<DesignEntry>;
  settings(): Promise<Settings>;
  setSettings(patch: Partial<Settings>): Promise<Settings>;
  /** The design list changed. */
  on(fn: (list: DesignEntry[]) => void): Unsubscribe;
}

export type DesignChange =
  | { type: "canvas"; canvas: Canvas }
  | { type: "thread"; meta: ThreadMeta }
  | { type: "thread.event"; threadId: string; event: ThreadEvent }
  | { type: "install"; install: InstallState }
  | { type: "setup.done"; next: string };

/** One design's `.finite/` folder. Writes are serialized per design and atomic. */
export interface OpenDesign {
  readonly design: Design;
  canvases(): Promise<Canvas[]>;
  createCanvas(
    input: { kind: CanvasKind; name: string; threadId?: string },
    by: Actor,
  ): Promise<Canvas>;
  patchCanvas(canvasId: string, patch: CanvasPatch, by: Actor): Promise<Canvas>;
  /** Applies the inverse of `by`'s last patch on the canvas (`redo`: of their last undo). */
  undoCanvas(canvasId: string, by: Actor, redo?: boolean): Promise<Canvas>;
  /** Rename, remove (sets `removedAt`), restore, and comment changes. */
  updateCanvas(canvasId: string, fn: (canvas: Canvas) => Canvas, by: Actor): Promise<Canvas>;
  threads(): Promise<ThreadMeta[]>;
  createThread(
    init: Pick<ThreadMeta, "model" | "fast"> &
      Partial<Pick<ThreadMeta, "title" | "parentId" | "canvasIds" | "effort" | "setup">>,
  ): Promise<ThreadMeta>;
  updateThread(threadId: string, fn: (meta: ThreadMeta) => ThreadMeta): Promise<ThreadMeta>;
  /** Stores the event (except `text.delta`) and emits it. */
  appendEvent(threadId: string, event: ThreadEvent): Promise<void>;
  history(threadId: string): Promise<ThreadEvent[]>;
  /** Saves into `.finite/attachments/` and returns the path relative to the root. */
  saveAttachment(name: string, data: Uint8Array): Promise<{ path: string }>;
  on(fn: (change: DesignChange) => void): Unsubscribe;
}

export type PreviewEvent =
  | ({ type: "preview" } & PreviewState)
  | { type: "routes"; routes: Route[] };

/** One Vite dev server per open design, run in a child process with `@finite/vite-plugin`. */
export interface Previews {
  /** Starts the design's dev server if it isn't running. */
  ensure(design: Design): Promise<{ url: string }>;
  state(designId: string): PreviewState;
  routes(designId: string): Promise<Route[]>;
  /** Where an iframe loads a frame from. */
  frameUrl(designId: string, source: FrameSource): string;
  stop(designId: string): Promise<void>;
  /** Nobody views the design any more: stops its dev server after a grace period. */
  idle(designId: string): void;
  on(designId: string, fn: (event: PreviewEvent) => void): Unsubscribe;
  reportError(designId: string, error: FrameError): void;
  errors(designId: string, frameId: string): FrameError[];
  close(): Promise<void>;
}

export type SourceResult = { ok: true; remap: Remap; created: Record<string, Loc> };

/** Hand edits to TSX, tokens, and copying files between production and prototypes. */
export interface SourceEditor {
  /** Refuses with `stale`, `outside-prototype` or `unsupported-style`. */
  apply(open: OpenDesign, edits: SourceEdit[], by: Actor, canvas: Canvas): Promise<SourceResult>;
  undo(open: OpenDesign, by: Actor): Promise<void>;
  redo(open: OpenDesign, by: Actor): Promise<void>;
  /** Copies `file` into `.finite/boards/<canvasId>/` and rewrites `importer`'s import of it. */
  detach(
    open: OpenDesign,
    input: { canvasId: string; file: string; importer: string },
    by: Actor,
  ): Promise<{ file: string }>;
  /** The element's children as editable runs. */
  inline(
    open: OpenDesign,
    loc: Loc,
  ): Promise<{
    rev: Rev;
    content: Inline[];
    keeps: { id: number; kind: string; label: string; loc?: Loc | undefined }[];
  }>;
  /** Writes a board file that renders `node`; the caller adds its frame. */
  draw(
    open: OpenDesign,
    input: { canvasId: string; box: Rect; name: string; node: NewNode },
    by: Actor,
  ): Promise<{ canvas: Canvas; frameId: string; file: string; created: Record<string, Loc> }>;
  /** Copies an attachment into the design's brand folder. */
  addAsset(open: OpenDesign, attachment: string): Promise<{ asset: string; url: string }>;
  /** Renders a slice to a file and says where it is. */
  exportSlice(
    open: OpenDesign,
    input: { canvasId: string; sliceId: string },
  ): Promise<{ url: string }>;
  tokens(design: Design): Promise<Token[]>;
  setToken(
    design: Design,
    input: { name: string; mode: TokenMode; value: string | null },
  ): Promise<Token[]>;
  components(design: Design): Promise<ComponentInfo[]>;
  /** Copies one production component or route file to `toFile`, imports pointing at production. */
  copyComponent(
    design: Design,
    from: { name: string } | { route: string },
    toFile: string,
  ): Promise<{ file: string }>;
  /**
   * The files a zip of these frames holds, at their paths relative to the design root (so the
   * zip unpacks into the same layout): `package.json`, the design's stylesheets, each frame's
   * file (a route frame's route file), and every file inside the root those import, transitively
   * — modules, CSS (`@import`, `url()`) and assets such as `mark.svg`, production files included.
   */
  exportFrames(
    open: OpenDesign,
    canvasId: string,
    frames: Frame[],
  ): Promise<{ path: string; data: Uint8Array }[]>;
}

export type Turn = {
  text: string;
  attachments: string[];
  selection?: Selection[];
  model: string;
  effort?: EffortLevel;
  fast: boolean;
  by: Actor;
};

/** Claude Agent SDK sessions, one per live thread. */
export interface Agents {
  /** `steer` folds the message into a running turn; `queue` holds it until the turn ends. */
  send(open: OpenDesign, threadId: string, turn: Turn, mode: SendMode): Promise<void>;
  interrupt(open: OpenDesign, threadId: string): Promise<void>;
  editQueued(
    open: OpenDesign,
    threadId: string,
    queuedId: string,
    text: string | null,
  ): Promise<ThreadMeta>;
  /** Ends every session working in the design and waits for them to stop, before it's removed. */
  stopDesign(designId: string): Promise<void>;
  status(): Promise<ClaudeStatus>;
  close(): Promise<void>;
}
