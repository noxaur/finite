import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";
import {
  type HookCallbackMatcher,
  type Options,
  type Query,
  query as sdkQuery,
  type SDKMessage,
  type SDKResultMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  type Actor,
  type Agents,
  type Design,
  type Frame,
  type OpenDesign,
  type PreviewState,
  type Previews,
  Refused,
  type Selection,
  type SendMode,
  type SourceEditor,
  type Store,
  type ThreadMeta,
  type Turn,
} from "@finite/protocol";
import { createLocks, fileLocks, type Locked } from "../source/files.ts";
import { createEventMapper } from "./events.ts";
import { detectProject } from "../store/detect.ts";
import { configRoot, WORKSPACE_FILE } from "../store/workspace.ts";
import { FINITE_INSTRUCTIONS, SETUP_INSTRUCTIONS } from "./instructions.ts";
import { userMessage } from "./message.ts";
import { policy } from "./policy.ts";
import { createScreenshots, type Screenshots } from "./screenshot.ts";
import { createStatus, findClaude, NOT_INSTALLED } from "./status.ts";
import { boardDir, canvasServer, LABEL_OFFSET, layoutRow } from "./tools.ts";

/** The part of the SDK's `Query` the agents use; tests pass a fake. */
export type QueryLike = AsyncIterable<SDKMessage> &
  Pick<Query, "setModel" | "applyFlagSettings" | "supportedModels" | "close"> & {
    /** The SDK honors `cancelQueued` (CLI capability `interrupt_cancel_queued_v1`) but doesn't type it. */
    interrupt(options?: { cancelQueued?: boolean }): ReturnType<Query["interrupt"]>;
  };
export type QueryFn = (params: {
  prompt: AsyncIterable<SDKUserMessage>;
  options: Options;
}) => QueryLike;

export type AgentsOptions = {
  store: Store;
  previews: Previews;
  source: SourceEditor;
  /** The SDK's `query`, replaced in tests. */
  query?: QueryFn;
  /** Where `claude` is; default: looked up on PATH. */
  claudePath?: () => Promise<string | undefined>;
  /** Close a thread's session after this long without a turn (default 10 minutes). */
  idleMs?: number;
  screenshots?: Screenshots;
  /** The file locks the SourceEditor writes under (default: the process's `fileLocks`). */
  locks?: Locked;
  /** The longest a Write/Edit holds its file's lock when Claude Code never reports it done. */
  writeLockMs?: number;
  /** How long a result after a steer waits for the steer's own turn to start (default 3 s). */
  steerGraceMs?: number;
};

export const IDLE_MS = 10 * 60_000;
export const WRITE_LOCK_MS = 30_000;
export const STEER_GRACE_MS = 3_000;
const WRITE_TOOLS = "Write|Edit|MultiEdit|NotebookEdit";
export const DEFAULT_TITLE = "New prototype";
export const SETUP_TITLE = "Set up Finite";
/** Claude Code's built-in tools a Finite agent gets; the rest (subagents, plans, cron, worktrees) only cost tokens. */
export const BUILT_IN_TOOLS = [
  "Read",
  "Write",
  "Edit",
  "Bash",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
];

/** The actor for a thread's agent: its id is the thread id. */
export function agentActor(threadId: string): Actor {
  return { kind: "agent", id: threadId, name: "Claude" };
}

/**
 * Creates a thread for `turn`, titled from its text, and links it to `canvasId` both ways. With
 * `prototype` it makes a prototype canvas for it first, named like the thread. Call
 * `Agents.send` next to start it.
 */
export async function startThread(
  open: OpenDesign,
  where: {
    canvasId?: string | undefined;
    parentId?: string | undefined;
    prototype?: boolean | undefined;
  },
  turn: Pick<Turn, "text" | "model" | "effort" | "fast" | "by">,
): Promise<ThreadMeta> {
  const { parentId } = where;
  const title = shortTitle(turn.text);
  const canvasId =
    where.canvasId ??
    (where.prototype
      ? (await open.createCanvas({ kind: "prototype", name: title }, turn.by)).id
      : undefined);
  const meta = await open.createThread({
    title,
    model: turn.model,
    fast: turn.fast,
    ...(turn.effort === undefined ? {} : { effort: turn.effort }),
    ...(parentId === undefined ? {} : { parentId }),
    canvasIds: canvasId === undefined ? [] : [canvasId],
  });
  if (canvasId !== undefined) {
    await open.updateCanvas(
      canvasId,
      (c) => (c.threadIds.includes(meta.id) ? c : { ...c, threadIds: [...c.threadIds, meta.id] }),
      turn.by,
    );
  }
  return meta;
}

/** Why Finite can't run the design yet, for a setup thread's first message. */
export async function setupReason(
  design: Design,
  preview: PreviewState,
): Promise<string | undefined> {
  if (design.setup) {
    return detectProject(design.root).then(
      () => undefined,
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
  }
  return preview.status === "error" ? preview.log : undefined;
}

/** Creates a setup thread, which writes `finite.json` and calls finish_setup. Send it its prompt next. */
export function startSetup(
  open: OpenDesign,
  turn: Pick<Turn, "model" | "effort" | "fast">,
): Promise<ThreadMeta> {
  return open.createThread({
    title: SETUP_TITLE,
    setup: true,
    model: turn.model,
    fast: turn.fast,
    ...(turn.effort === undefined ? {} : { effort: turn.effort }),
  });
}

/**
 * Puts a copy of each selected frame from another canvas (same source: a reference to the route or
 * file, not a copy of its code) on a new prototype's canvas, in a row from the origin with its
 * name above, so variants can sit to its right. Returns the selection pointing at the copies.
 */
export async function carrySelection(
  open: OpenDesign,
  canvasId: string,
  selection: Selection[],
  by: Actor,
): Promise<Selection[]> {
  const canvases = await open.canvases();
  const target = canvases.find((c) => c.id === canvasId);
  if (!target) return selection;
  const copies = new Map<string, Frame>();
  for (const { frameId } of selection) {
    if (copies.has(frameId) || target.frames.some((f) => f.id === frameId)) continue;
    const from = canvases.flatMap((c) => c.frames).find((f) => f.id === frameId);
    if (from) copies.set(frameId, from);
  }
  if (copies.size === 0) return selection;
  const originals = [...copies.values()];
  const boxes = layoutRow(
    target.frames,
    originals.map(({ width, height }) => ({ width, height })),
  );
  const placed = originals.map((f, i): Frame => {
    const { gone: _gone, placedBy: _by, ...rest } = f;
    return { ...rest, ...boxes[i]!, id: randomUUID() };
  });
  await open.patchCanvas(canvasId, { op: "addFrames", frames: placed }, by);
  for (const frame of placed) {
    const what = frame.source.kind === "route" ? `route ${frame.source.path}` : frame.source.file;
    await open.patchCanvas(
      canvasId,
      {
        op: "setText",
        text: {
          id: randomUUID(),
          x: frame.x,
          y: frame.y - LABEL_OFFSET,
          width: frame.width,
          title: frame.name,
          body: `The source: production ${what}.`,
          author: by,
        },
      },
      by,
    );
  }
  const ids = new Map(originals.map((f, i) => [f.id, placed[i]!.id]));
  return selection.map((s) => ({ ...s, frameId: ids.get(s.frameId) ?? s.frameId }));
}

/** The first line of a message, cut to about six words. */
export function shortTitle(text: string): string {
  const line = (text.split("\n").find((l) => l.trim()) ?? "").trim().replace(/\s+/g, " ");
  if (!line) return DEFAULT_TITLE;
  if (line.length <= 40) return line;
  const cut = line.slice(0, 40);
  return `${cut.slice(0, cut.lastIndexOf(" ") > 20 ? cut.lastIndexOf(" ") : 40)}…`;
}

/** One live Claude Code session. */
type Live = {
  threadId: string;
  open: OpenDesign;
  query: QueryLike;
  input: Inbox<SDKUserMessage>;
  model: string;
  effort: Turn["effort"];
  fast: boolean;
  /** A turn is in flight. */
  running: boolean;
  /** move_to_prod was called this turn. */
  prodWrite: boolean;
  /** The tool call that set `prodWrite`, when Claude Code said which. */
  prodWriteCall: string | undefined;
  /** The tool calls `consume` has read. */
  callsRead: Set<string>;
  /** finish_setup replaced this setup design with the apps: it's removed when the turn ends. */
  replaced: boolean;
  closing: boolean;
  /** The session reported its id (so resuming worked). */
  started: boolean;
  idle: NodeJS.Timeout | undefined;
  /** Settles when the session's messages have all been read. */
  done: Promise<void>;
  /** File locks held by Write/Edit calls in flight, by tool use id. */
  writing: Map<string, () => void>;
  /**
   * Steers pushed into a running turn whose own turn hasn't started yet. Claude Code ends the
   * running turn for a steer with a result that says `queued_turn_count: 0` (often an empty
   * `error_during_execution` one), then starts the steer's turn with a `system/init`.
   */
  steers: number;
  /** A result held back until the steer's turn starts, finished by this timer if it never does. */
  steerWait: NodeJS.Timeout | undefined;
  /** A result came and no turn has started since. */
  betweenTurns: boolean;
  /** The uuids of the messages sent since the last Stop. */
  sent: Set<string>;
  /** The uuids of the messages sent before a Stop: a result answering one changes nothing. */
  stopped: Set<string>;
};

export function createAgents(options: AgentsOptions): Agents {
  const query: QueryFn = options.query ?? ((p) => sdkQuery(p));
  let claudeBin: Promise<string | undefined> | undefined;
  const claudePath =
    options.claudePath ??
    (() => {
      claudeBin ??= findClaude();
      void claudeBin.then((bin) => bin ?? (claudeBin = undefined));
      return claudeBin;
    });
  const idleMs = options.idleMs ?? IDLE_MS;
  const screenshots = options.screenshots ?? createScreenshots();
  const status = createStatus(query, claudePath);
  const lives = new Map<string, Live>();
  /** Every session's read loop until it ends, including sessions already shut and gone from `lives`. */
  const reading = new Set<Promise<void>>();
  const locks = options.locks ?? fileLocks;
  const writeLockMs = options.writeLockMs ?? WRITE_LOCK_MS;
  const steerGraceMs = options.steerGraceMs ?? STEER_GRACE_MS;
  /**
   * One thread's sends, results and interrupts run one at a time, so two sends can't both start a
   * session and a send can't queue a message just after the turn decided the queue was empty.
   */
  const serial = createLocks();
  const inThread = <T>(threadId: string, fn: () => Promise<T>) => serial([threadId], fn);
  /** Sends not yet finished, by thread: their design and how many. A send may be starting a session. */
  const sending = new Map<string, { designId: string; count: number }>();
  /** Designs whose sessions `stopDesign` is ending; they take no new messages meanwhile. */
  const removing = new Map<string, number>();
  const refuseRemoving = (designId: string) => {
    if (removing.has(designId)) {
      throw new Refused("This design is being removed, so it takes no new messages.", "invalid");
    }
  };

  async function meta(open: OpenDesign, threadId: string): Promise<ThreadMeta> {
    const found = (await open.threads()).find((t) => t.id === threadId);
    if (!found) throw new Refused(`There's no thread ${threadId} in this design.`, "not-found");
    return found;
  }

  async function start(open: OpenDesign, thread: ThreadMeta, turn: Turn): Promise<Live> {
    const bin = await claudePath();
    if (!bin) throw new Refused(NOT_INSTALLED, "not-logged-in");
    const { root, brandDir } = open.design;
    const realRoot = realpath(root);
    const cwd = open.design.workspace ?? root;
    const configFile = thread.setup
      ? path.join(open.design.workspace ?? (await configRoot(root)), WORKSPACE_FILE)
      : undefined;
    const input = inbox<SDKUserMessage>();
    const live: Live = {
      threadId: thread.id,
      open,
      query: undefined as unknown as QueryLike,
      input,
      model: turn.model,
      effort: turn.effort,
      fast: turn.fast,
      running: false,
      prodWrite: false,
      prodWriteCall: undefined,
      callsRead: new Set(),
      replaced: false,
      closing: false,
      started: false,
      idle: undefined,
      done: Promise.resolve(),
      writing: new Map(),
      steers: 0,
      steerWait: undefined,
      betweenTurns: false,
      sent: new Set(),
      stopped: new Set(),
    };
    const fence = (name: string, toolInput: Record<string, unknown>) =>
      policy(name, toolInput, {
        root,
        realRoot,
        brandDir,
        prodWrite: live.prodWrite,
        ...(cwd === root ? {} : { workspace: cwd }),
        ...(configFile === undefined ? {} : { configFile }),
      });
    // A PreToolUse hook runs even when the person's own settings pre-approve a tool, so the
    // write fence holds whatever their allow rules say; canUseTool answers everything else.
    // An allowed write then holds the file's lock until PostToolUse, so a SourceEditor edit can't
    // land between Claude Code reading the file and saving it.
    const writeFence: HookCallbackMatcher = {
      matcher: WRITE_TOOLS,
      hooks: [
        async (hook, _id, { signal }) => {
          if (hook.hook_event_name !== "PreToolUse") return {};
          const toolInput = (hook.tool_input ?? {}) as Record<string, unknown>;
          const decision = fence(hook.tool_name, toolInput);
          if (decision.behavior === "allow") {
            const file = toolInput.file_path ?? toolInput.notebook_path;
            if (typeof file === "string") await holdLock(live, hook.tool_use_id, file, signal);
            return {};
          }
          return {
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "deny",
              permissionDecisionReason: decision.message,
            },
          };
        },
      ],
    };
    const writeDone: HookCallbackMatcher = {
      matcher: WRITE_TOOLS,
      hooks: [
        async (hook) => {
          if ("tool_use_id" in hook) live.writing.get(hook.tool_use_id)?.();
          return {};
        },
      ],
    };
    async function holdLock(
      live: Live,
      toolUseId: string,
      file: string,
      signal: AbortSignal,
    ): Promise<void> {
      const release = await locks.acquire([path.resolve(cwd, file)]);
      // The session shut (or the hook was cancelled) while this waited: nothing will report it done.
      if (live.closing || signal.aborted) return release();
      const timer = setTimeout(() => done(), writeLockMs);
      timer.unref?.();
      const done = () => {
        clearTimeout(timer);
        live.writing.delete(toolUseId);
        release();
      };
      live.writing.get(toolUseId)?.();
      live.writing.set(toolUseId, done);
    }
    const server = canvasServer({
      open,
      threadId: thread.id,
      actor: agentActor(thread.id),
      previews: options.previews,
      source: options.source,
      screenshots,
      grantProdWrite: (toolUseId) => {
        live.prodWrite = true;
        live.prodWriteCall = toolUseId;
      },
      spawn: (prompt, canvasId) => spawn(open, thread.id, prompt, canvasId),
      finishSetup: () => finishSetup(live),
    });
    live.query = query({
      prompt: input,
      options: {
        pathToClaudeCodeExecutable: bin,
        cwd,
        ...(thread.sessionId === undefined ? {} : { resume: thread.sessionId }),
        includePartialMessages: true,
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append: thread.setup
            ? `${SETUP_INSTRUCTIONS}\n## This thread\nWrite finite.json at ${configFile}.`
            : `${FINITE_INSTRUCTIONS}\n${context(open, thread)}`,
        },
        // Only the project's own settings and CLAUDE.md: the person's global ~/.claude config
        // (their CLAUDE.md, skills, plugins, hooks) is about their own work, not this design.
        settingSources: ["project"],
        tools: [...BUILT_IN_TOOLS],
        mcpServers: { finite: server },
        strictMcpConfig: true,
        permissionMode: "default",
        canUseTool: async (name, toolInput) => fence(name, toolInput),
        hooks: {
          PreToolUse: [writeFence],
          PostToolUse: [writeDone],
          PostToolUseFailure: [writeDone],
        },
        model: turn.model,
        ...(turn.effort === undefined ? {} : { effort: turn.effort }),
        settings: { fastMode: turn.fast },
      },
    });
    lives.set(thread.id, live);
    live.done = consume(live, thread.sessionId);
    reading.add(live.done);
    const forget = () => void reading.delete(live.done);
    live.done.then(forget, forget);
    return live;
  }

  /** Reads the session's messages until it ends, turning them into thread events. */
  async function consume(live: Live, resumed: string | undefined): Promise<void> {
    const { open, threadId } = live;
    const map = createEventMapper(open.design.root, realpath(open.design.root));
    try {
      for await (const message of live.query) {
        if (!live.started && "session_id" in message && message.session_id) {
          live.started = true;
          const sessionId = message.session_id;
          if (sessionId !== resumed)
            await open.updateThread(threadId, (m) => ({ ...m, sessionId }));
        }
        if (message.type === "system" && message.subtype === "init") {
          // A turn after a result started: a steer's own turn, if one is pending.
          if (live.betweenTurns && live.steers > 0) live.steers--;
          live.betweenTurns = false;
          clearTimeout(live.steerWait);
          live.steerWait = undefined;
        }
        if (message.type === "assistant") {
          for (const block of message.message.content) {
            if (block.type === "tool_use") live.callsRead.add(block.id);
          }
        }
        const now = Date.now();
        const stopped = message.type === "result" && answersStop(live, message);
        // A turn a steer cut short or Stop cancelled isn't a failure.
        for (const event of map(message, now, stopped || !live.running || live.steers > 0)) {
          await open.appendEvent(threadId, event);
        }
        if (message.type === "result") {
          const ok = message.subtype === "success" && !message.is_error;
          const queuedTurns = message.queued_turn_count ?? 0;
          const more = queuedTurns > 0;
          // A turn this result counted is not a steer's to count again when it starts.
          if (!stopped && !more) live.betweenTurns = true;
          await inThread(threadId, async () => {
            if (live.closing) return;
            // Stop already handed the thread back, and a message sent since has its own result.
            if (!live.running || answersStop(live, message)) {
              if (!grantIsLater(live)) live.prodWrite = false;
              return;
            }
            // Claude Code counted those steers itself.
            live.steers = Math.max(0, live.steers - queuedTurns);
            if (live.steers > 0 && !more) return holdForSteer(live, ok);
            return finishTurn(live, ok, { more });
          });
        }
      }
      if (!live.closing) throw new Error("Claude Code stopped.");
    } catch (error) {
      if (live.closing) return;
      await inThread(threadId, () => ended(live, resumed, error));
    } finally {
      releaseWrites(live);
    }
  }

  /** A session that stopped on its own: report it and hand the thread back. */
  async function ended(live: Live, resumed: string | undefined, error: unknown): Promise<void> {
    const { open, threadId } = live;
    if (lives.get(threadId) === live) lives.delete(threadId);
    clearTimeout(live.idle);
    clearTimeout(live.steerWait);
    live.steerWait = undefined;
    live.input.end();
    // A session that can't be resumed (moved project, deleted transcript) starts fresh next time.
    const fresh = resumed !== undefined && !live.started;
    const reason = error instanceof Error ? error.message : String(error);
    await open
      .appendEvent(threadId, {
        type: "error",
        message: fresh ? `${reason} The next message starts a new session.` : reason,
        at: Date.now(),
      })
      .catch(() => {});
    await open
      .updateThread(threadId, (m) => {
        const next = { ...m, running: false, awaitingSince: Date.now(), updatedAt: Date.now() };
        if (fresh) delete next.sessionId;
        return next;
      })
      .catch(() => {});
    if (live.replaced) await removeSetup(live);
  }

  function releaseWrites(live: Live): void {
    for (const release of live.writing.values()) release();
  }

  /** Waits for a steer's turn to start; if it doesn't in time, the result was the end after all. */
  function holdForSteer(live: Live, ok: boolean, granted = live.prodWrite): void {
    // The grant ends with this turn, and the steer's may start before the timer decides.
    live.prodWrite = false;
    clearTimeout(live.steerWait);
    const steers = live.steers;
    const timer = setTimeout(() => {
      void inThread(live.threadId, async () => {
        if (live.steerWait !== timer) return;
        // Another steer came during the wait: it gets its own time to start.
        if (live.steers > steers) return holdForSteer(live, ok, granted);
        live.steerWait = undefined;
        live.steers = 0;
        await finishTurn(live, ok, { more: false, granted });
      });
    }, steerGraceMs);
    timer.unref?.();
    live.steerWait = timer;
  }

  /** After a turn's result: revoke prod writes, settle, send the next queued message or hand back. */
  async function finishTurn(
    live: Live,
    ok: boolean,
    { more, granted = false }: { more: boolean; granted?: boolean },
  ): Promise<void> {
    const { open, threadId } = live;
    const settle = ok && (live.prodWrite || granted);
    live.prodWrite = false;
    if (more) return;
    const thread = await meta(open, threadId);
    const next = thread.queued[0];
    if (next) {
      // The thread isn't done while queued messages remain, so it doesn't settle yet.
      await open.updateThread(threadId, (m) => ({
        ...m,
        queued: m.queued.filter((q) => q.id !== next.id),
      }));
      await deliver(live, {
        text: next.text,
        attachments: next.attachments,
        ...(next.selection ? { selection: next.selection } : {}),
        by: next.by,
        // What the thread was last asked to run with, queued messages included.
        model: thread.model,
        fast: thread.fast,
        ...effort(thread.effort),
      });
      return;
    }
    live.running = false;
    await open.updateThread(threadId, (m) => ({
      ...m,
      running: false,
      awaitingSince: Date.now(),
      updatedAt: Date.now(),
      ...(settle ? { settledAt: Date.now() } : {}),
    }));
    if (live.replaced) return removeSetup(live);
    armIdle(live);
  }

  /** The apps took over: the setup design, this thread with it, goes once its turn is done. */
  async function removeSetup(live: Live): Promise<void> {
    const { open } = live;
    shut(live);
    await options.previews.remove(open.design.id).catch(() => {});
    await options.store.remove(open.design.id).catch((error: unknown) => {
      console.error(`removing setup design ${open.design.id} failed:`, error);
    });
  }

  /**
   * finish_setup: connects finite.json's apps (or says what to fix), then starts the preview of
   * the design to show next, so the agent sees whether setup, services and the dev server run.
   */
  async function finishSetup(live: Live): Promise<object> {
    const { apps, next, replaced } = await options.store.finishSetup(live.open.design.id);
    if (replaced) live.replaced = true;
    const design = (await options.store.open(next.id)).design;
    const connected = apps.map((a) => ({ designId: a.id, app: a.app, root: a.root }));
    const after = replaced
      ? `The page now shows ${next.name}. This setup thread closes when your turn ends.`
      : "finite.json is in use.";
    await options.previews.stop(next.id);
    try {
      const { url } = await options.previews.ensure(design);
      return {
        connected,
        preview: `${next.name} runs at ${url}.`,
        next: `${after} Say what you set up.`,
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const log = options.previews.state(next.id).log?.trim().split("\n").slice(-30).join("\n");
      return {
        connected,
        preview: `${next.name} didn't start: ${reason}`,
        ...(log ? { log } : {}),
        next: `${after} Fix finite.json (or say what the person must do) and call finish_setup again.`,
      };
    }
  }

  function armIdle(live: Live): void {
    clearTimeout(live.idle);
    live.idle = setTimeout(() => {
      void inThread(live.threadId, async () => {
        if (!live.running && lives.get(live.threadId) === live) shut(live);
      });
    }, idleMs);
    live.idle.unref?.();
  }

  function shut(live: Live): void {
    live.closing = true;
    clearTimeout(live.idle);
    clearTimeout(live.steerWait);
    live.steerWait = undefined;
    if (lives.get(live.threadId) === live) lives.delete(live.threadId);
    live.input.end();
    live.query.close();
    releaseWrites(live);
  }

  /** Pushes a message into the session and records it. */
  async function deliver(live: Live, turn: Turn, priority?: "now"): Promise<void> {
    const { open, threadId } = live;
    clearTimeout(live.idle);
    let message: SDKUserMessage;
    try {
      if (turn.model !== live.model) {
        await live.query.setModel(turn.model);
        live.model = turn.model;
      }
      if (turn.effort !== live.effort || turn.fast !== live.fast) {
        await live.query.applyFlagSettings({
          effortLevel: turn.effort ?? null,
          fastMode: turn.fast,
        });
        live.effort = turn.effort;
        live.fast = turn.fast;
      }
      message = await userMessage(open.design.root, turn, await open.canvases());
    } catch (error) {
      if (!live.running) armIdle(live);
      throw error;
    }
    live.running = true;
    await open.updateThread(threadId, (m) => {
      const next: ThreadMeta = {
        ...withRunSettings(m, turn),
        running: true,
        updatedAt: Date.now(),
      };
      // Messaging a snoozed or settled thread revives it.
      delete next.snoozedUntil;
      delete next.settledAt;
      return next;
    });
    await open.appendEvent(threadId, {
      type: "user",
      text: turn.text,
      attachments: turn.attachments,
      ...(turn.selection ? { selection: turn.selection } : {}),
      by: turn.by,
      at: Date.now(),
    });
    // Without a uuid Claude Code can't take the message back on Stop or say which result answers it.
    const uuid = randomUUID();
    live.sent.add(uuid);
    // The next turn to start is this message's, so it can't be a waiting steer's.
    if (!priority) live.betweenTurns = false;
    live.input.push({ ...message, uuid, ...(priority ? { priority } : {}) });
  }

  /** One send, inside the thread's turn: queue it, steer it in, or start a session for it. */
  async function sendNow(open: OpenDesign, threadId: string, turn: Turn, mode: SendMode) {
    refuseRemoving(open.design.id);
    const thread = await meta(open, threadId);
    const live = lives.get(threadId);
    if (live?.running && mode === "queue") {
      // A model picked for a queued message is the thread's from its next turn on.
      await open.updateThread(threadId, (m) => ({
        ...withRunSettings(m, turn),
        queued: [
          ...m.queued,
          {
            id: randomUUID(),
            text: turn.text,
            attachments: turn.attachments,
            ...(turn.selection ? { selection: turn.selection } : {}),
            by: turn.by,
          },
        ],
        updatedAt: Date.now(),
      }));
      return;
    }
    if (live?.running) {
      live.steers++;
      return deliver(live, turn, "now");
    }
    if (live) return deliver(live, turn);
    return deliver(await start(open, thread, turn), turn);
  }

  async function spawn(
    open: OpenDesign,
    parentId: string,
    prompt: string,
    canvasId: string | undefined,
  ): Promise<ThreadMeta> {
    const parent = await meta(open, parentId);
    const turn: Turn = {
      text: prompt,
      attachments: [],
      model: parent.model,
      fast: parent.fast,
      ...effort(parent.effort),
      by: agentActor(parentId),
    };
    const child = await startThread(open, { canvasId, parentId }, turn);
    await agents.send(open, child.id, turn, "queue");
    return child;
  }

  const agents: Agents = {
    async send(open, threadId, turn, mode) {
      const designId = open.design.id;
      refuseRemoving(designId);
      const entry = sending.get(threadId) ?? { designId, count: 0 };
      entry.count++;
      sending.set(threadId, entry);
      try {
        return await inThread(threadId, () => sendNow(open, threadId, turn, mode));
      } finally {
        if (--entry.count === 0 && sending.get(threadId) === entry) sending.delete(threadId);
      }
    },

    interrupt: (open, threadId) =>
      inThread(threadId, async () => {
        const live = lives.get(threadId);
        if (live?.running) {
          live.running = false;
          live.prodWrite = false;
          live.steers = 0;
          clearTimeout(live.steerWait);
          live.steerWait = undefined;
          for (const uuid of live.sent) live.stopped.add(uuid);
          live.sent.clear();
          // A steer still waiting behind a tool call would otherwise run after Stop.
          await live.query.interrupt({ cancelQueued: true });
          armIdle(live);
        } else {
          await meta(open, threadId);
        }
        await open.updateThread(threadId, (m) => ({
          ...m,
          running: false,
          awaitingSince: Date.now(),
          updatedAt: Date.now(),
        }));
        if (live?.replaced) await removeSetup(live);
      }),

    editQueued: (open, threadId, queuedId, text) =>
      inThread(threadId, async () => {
        const thread = await meta(open, threadId);
        if (!thread.queued.some((q) => q.id === queuedId)) {
          throw new Refused("That queued message was already sent or removed.", "not-found");
        }
        return open.updateThread(threadId, (m) => ({
          ...m,
          queued:
            text === null
              ? m.queued.filter((q) => q.id !== queuedId)
              : m.queued.map((q) => (q.id === queuedId ? { ...q, text } : q)),
          updatedAt: Date.now(),
        }));
      }),

    async stopDesign(designId) {
      removing.set(designId, (removing.get(designId) ?? 0) + 1);
      try {
        // Sessions running, and sends that may be starting one (they finish before our turn).
        const threadIds = new Set([
          ...[...lives.values()]
            .filter((l) => l.open.design.id === designId)
            .map((l) => l.threadId),
          ...[...sending].filter(([, s]) => s.designId === designId).map(([id]) => id),
        ]);
        const stopped = await Promise.all(
          [...threadIds].map((threadId) =>
            inThread(threadId, async () => {
              const live = lives.get(threadId);
              if (!live || live.open.design.id !== designId) return undefined;
              shut(live);
              // Waited on outside the thread's turn: the session's last result takes it to finish.
              return { done: live.done };
            }),
          ),
        );
        await Promise.all(stopped.flatMap((s) => (s ? [s.done] : [])));
      } finally {
        const n = removing.get(designId)! - 1;
        if (n === 0) removing.delete(designId);
        else removing.set(designId, n);
      }
    },

    status,

    async close() {
      for (const live of lives.values()) shut(live);
      // A result still being recorded finishes its writes before the design's folder can go.
      await Promise.allSettled(reading);
      await screenshots.close();
    },
  };
  return agents;
}

/** What this session's agent should know about where it is. */
function context(open: OpenDesign, thread: ThreadMeta): string {
  const { root, workspace, brandDir, styling } = open.design;
  // The agent works from the workspace root, so the app's own folders are under its path.
  const app = workspace === undefined ? "" : path.relative(workspace, root);
  const at = (dir: string) => (app ? `${app}/${dir}` : dir);
  const lines = [
    `## This thread`,
    `Thread id: ${thread.id}. Brand folder: ${at(brandDir)}/. Styling: ${styling}.`,
  ];
  if (app) {
    lines.push(
      `You're in the workspace ${workspace}; this design is the app in ${app}/. Canvas tools take paths relative to either.`,
    );
  }
  const canvasId = thread.canvasIds.at(-1);
  if (canvasId) {
    lines.push(`Your canvas: ${canvasId}. Write its frames in ${at(boardDir(canvasId))}/.`);
  } else {
    lines.push("This thread has no canvas. open_canvas makes or opens one when you need it.");
  }
  return lines.join("\n");
}

/** Whether a result answers a message sent before a Stop: the turn was cancelled or already over. */
function answersStop(live: Live, result: SDKResultMessage): boolean {
  return result.user_message_uuid !== undefined && live.stopped.has(result.user_message_uuid);
}

/**
 * Whether the grant belongs to a later turn than the result being handled. A tool call comes before
 * its turn's result in the stream, so a call not read yet is a later turn's, though its tool can
 * run first when this loop falls behind. A grant with no call id counts as the result's turn.
 */
function grantIsLater(live: Live): boolean {
  return live.prodWriteCall !== undefined && !live.callsRead.has(live.prodWriteCall);
}

function realpath(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    return dir;
  }
}

/** The thread, set to run with the turn's model, effort and fast mode. */
function withRunSettings(m: ThreadMeta, turn: Turn): ThreadMeta {
  const next: ThreadMeta = { ...m, model: turn.model, fast: turn.fast };
  if (turn.effort === undefined) delete next.effort;
  else next.effort = turn.effort;
  return next;
}

function effort(level: Turn["effort"]): Pick<Turn, "effort"> {
  return level === undefined ? {} : { effort: level };
}

type Inbox<T> = AsyncIterable<T> & { push(item: T): void; end(): void };

/** An async queue: the prompt stream a session reads its messages from. */
function inbox<T>(): Inbox<T> {
  const items: T[] = [];
  let wake: (() => void) | undefined;
  let ended = false;
  return {
    push(item) {
      if (ended) return;
      items.push(item);
      wake?.();
    },
    end() {
      ended = true;
      wake?.();
    },
    async *[Symbol.asyncIterator]() {
      while (true) {
        const item = items.shift();
        if (item !== undefined) {
          yield item;
          continue;
        }
        if (ended) return;
        await new Promise<void>((resolve) => (wake = resolve));
        wake = undefined;
      }
    },
  };
}
