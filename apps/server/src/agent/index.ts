import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import {
  type HookCallbackMatcher,
  type Options,
  type Query,
  query as sdkQuery,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  type Actor,
  type Agents,
  type OpenDesign,
  type Previews,
  Refused,
  type SourceEditor,
  type Store,
  type ThreadMeta,
  type Turn,
} from "@finite/protocol";
import { createEventMapper } from "./events.ts";
import { FINITE_INSTRUCTIONS } from "./instructions.ts";
import { userMessage } from "./message.ts";
import { policy } from "./policy.ts";
import { createScreenshots, type Screenshots } from "./screenshot.ts";
import { createStatus, findClaude } from "./status.ts";
import { boardDir, canvasServer } from "./tools.ts";

/** The part of the SDK's `Query` the agents use; tests pass a fake. */
export type QueryLike = AsyncIterable<SDKMessage> &
  Pick<Query, "interrupt" | "setModel" | "applyFlagSettings" | "supportedModels" | "close">;
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
};

export const IDLE_MS = 10 * 60_000;
export const DEFAULT_TITLE = "New prototype";
const NOT_INSTALLED = "Install Claude Code and run `claude` to log in.";

/** The actor for a thread's agent: its id is the thread id. */
export function agentActor(threadId: string): Actor {
  return { kind: "agent", id: threadId, name: "Claude" };
}

/**
 * Creates a thread for `turn`, titled from its text, and links it to `canvasId` both ways.
 * Call `Agents.send` next to start it.
 */
export async function startThread(
  open: OpenDesign,
  where: { canvasId?: string | undefined; parentId?: string | undefined },
  turn: Pick<Turn, "text" | "model" | "effort" | "fast" | "by">,
): Promise<ThreadMeta> {
  const { canvasId, parentId } = where;
  const meta = await open.createThread({
    title: shortTitle(turn.text),
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
  interrupted: boolean;
  closing: boolean;
  /** The session reported its id (so resuming worked). */
  started: boolean;
  idle: NodeJS.Timeout | undefined;
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
      interrupted: false,
      closing: false,
      started: false,
      idle: undefined,
    };
    const fence = (name: string, toolInput: Record<string, unknown>) =>
      policy(name, toolInput, { root, realRoot, brandDir, prodWrite: live.prodWrite });
    // A PreToolUse hook runs even when the person's own settings pre-approve a tool, so the
    // write fence holds whatever their allow rules say; canUseTool answers everything else.
    const writeFence: HookCallbackMatcher = {
      matcher: "Write|Edit|MultiEdit|NotebookEdit",
      hooks: [
        async (hook) => {
          if (hook.hook_event_name !== "PreToolUse") return {};
          const decision = fence(
            hook.tool_name,
            (hook.tool_input ?? {}) as Record<string, unknown>,
          );
          if (decision.behavior === "allow") return {};
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
    const server = canvasServer({
      open,
      threadId: thread.id,
      actor: agentActor(thread.id),
      previews: options.previews,
      source: options.source,
      screenshots,
      grantProdWrite: () => (live.prodWrite = true),
      spawn: (prompt, canvasId) => spawn(open, thread.id, prompt, canvasId),
    });
    live.query = query({
      prompt: input,
      options: {
        pathToClaudeCodeExecutable: bin,
        cwd: root,
        ...(thread.sessionId === undefined ? {} : { resume: thread.sessionId }),
        includePartialMessages: true,
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append: `${FINITE_INSTRUCTIONS}\n${context(open, thread)}`,
        },
        mcpServers: { finite: server },
        strictMcpConfig: true,
        permissionMode: "default",
        canUseTool: async (name, toolInput) => fence(name, toolInput),
        hooks: { PreToolUse: [writeFence] },
        model: turn.model,
        ...(turn.effort === undefined ? {} : { effort: turn.effort }),
        settings: { fastMode: turn.fast },
      },
    });
    lives.set(thread.id, live);
    void consume(live, thread.sessionId);
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
        const now = Date.now();
        for (const event of map(message, now, live.interrupted)) {
          await open.appendEvent(threadId, event);
        }
        if (message.type === "result") {
          await finishTurn(live, message.subtype === "success" && !message.is_error, {
            more: (message.queued_turn_count ?? 0) > 0,
          });
        }
      }
      if (!live.closing) throw new Error("Claude Code stopped.");
    } catch (error) {
      if (live.closing) return;
      lives.delete(threadId);
      clearTimeout(live.idle);
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
    }
  }

  /** After a turn's result: revoke prod writes, settle, send the next queued message or hand back. */
  async function finishTurn(live: Live, ok: boolean, { more }: { more: boolean }): Promise<void> {
    const { open, threadId } = live;
    const settle = ok && live.prodWrite;
    const interrupted = live.interrupted;
    live.prodWrite = false;
    live.interrupted = false;
    if (more) return;
    const next = interrupted ? undefined : (await meta(open, threadId)).queued[0];
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
        model: live.model,
        fast: live.fast,
        ...effort(live.effort),
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
    armIdle(live);
  }

  function armIdle(live: Live): void {
    clearTimeout(live.idle);
    live.idle = setTimeout(() => {
      if (live.running) return;
      shut(live);
    }, idleMs);
    live.idle.unref?.();
  }

  function shut(live: Live): void {
    live.closing = true;
    clearTimeout(live.idle);
    lives.delete(live.threadId);
    live.input.end();
    live.query.close();
  }

  /** Pushes a message into the session and records it. */
  async function deliver(live: Live, turn: Turn, priority?: "now"): Promise<void> {
    const { open, threadId } = live;
    clearTimeout(live.idle);
    if (turn.model !== live.model) {
      await live.query.setModel(turn.model);
      live.model = turn.model;
    }
    if (turn.effort !== live.effort || turn.fast !== live.fast) {
      await live.query.applyFlagSettings({ effortLevel: turn.effort ?? null, fastMode: turn.fast });
      live.effort = turn.effort;
      live.fast = turn.fast;
    }
    const message = await userMessage(open.design.root, turn, await open.canvases());
    live.running = true;
    await open.updateThread(threadId, (m) => {
      const next: ThreadMeta = {
        ...m,
        running: true,
        model: turn.model,
        fast: turn.fast,
        updatedAt: Date.now(),
      };
      if (turn.effort === undefined) delete next.effort;
      else next.effort = turn.effort;
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
    live.input.push(priority ? { ...message, priority } : message);
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
      const thread = await meta(open, threadId);
      const live = lives.get(threadId);
      if (live?.running && mode === "queue") {
        await open.updateThread(threadId, (m) => ({
          ...m,
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
      if (live) return deliver(live, turn, live.running ? "now" : undefined);
      return deliver(await start(open, thread, turn), turn);
    },

    async interrupt(open, threadId) {
      const live = lives.get(threadId);
      if (live?.running) {
        live.interrupted = true;
        live.running = false;
        live.prodWrite = false;
        await live.query.interrupt();
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
    },

    async editQueued(open, threadId, queuedId, text) {
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
    },

    status,

    async close() {
      for (const live of lives.values()) shut(live);
      await screenshots.close();
    },
  };
  return agents;
}

/** What this session's agent should know about where it is. */
function context(open: OpenDesign, thread: ThreadMeta): string {
  const lines = [
    `## This thread`,
    `Thread id: ${thread.id}. Brand folder: ${open.design.brandDir}/. Styling: ${open.design.styling}.`,
  ];
  const canvasId = thread.canvasIds.at(-1);
  if (canvasId) {
    lines.push(`Your canvas: ${canvasId}. Write its frames in ${boardDir(canvasId)}/.`);
  } else {
    lines.push("This thread has no canvas. open_canvas makes or opens one when you need it.");
  }
  return lines.join("\n");
}

function realpath(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    return dir;
  }
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
