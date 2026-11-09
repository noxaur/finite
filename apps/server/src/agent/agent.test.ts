import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  McpSdkServerConfigWithInstance,
  Options,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  type Actor,
  type Design,
  type DesignEntry,
  type OpenDesign,
  type PreviewState,
  type Previews,
  Refused,
  type SourceEditor,
  type Store,
  type Turn,
} from "@finite/protocol";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createFileLocks } from "../source/files.ts";
import { openDesign, type OpenedDesign } from "../store/open.ts";
import { createEventMapper } from "./events.ts";
import { BRAND_BOARD } from "../store/brand.ts";
import {
  agentActor,
  BUILT_IN_TOOLS,
  carrySelection,
  createAgents,
  type QueryFn,
  type QueryLike,
  shortTitle,
  startSetup,
  startThread,
} from "./index.ts";
import { FINITE_INSTRUCTIONS, SETUP_INSTRUCTIONS } from "./instructions.ts";
import { policy } from "./policy.ts";
import { createStatus, NOT_INSTALLED, NOT_LOGGED_IN } from "./status.ts";
import { DEFAULT_SIZE, GAP, LABEL_OFFSET, layoutRow, rootRelative } from "./tools.ts";

const person = { kind: "person" as const, id: "u1", name: "Ada" };

describe("policy", () => {
  const ctx = { root: "/p", brandDir: "src/assets/brand", prodWrite: false };

  it("allows reading, searching, the web and Bash anywhere", () => {
    for (const name of ["Read", "Glob", "Grep", "WebFetch", "WebSearch", "Bash"]) {
      expect(policy(name, { file_path: "/etc/hosts" }, ctx).behavior).toBe("allow");
    }
  });

  it("allows writes under .finite/ and the brand folder only", () => {
    expect(policy("Write", { file_path: "/p/.finite/boards/c1/A.tsx" }, ctx).behavior).toBe(
      "allow",
    );
    expect(policy("Edit", { file_path: ".finite/boards/c1/A.tsx" }, ctx).behavior).toBe("allow");
    expect(policy("Write", { file_path: "/p/src/assets/brand/logo.svg" }, ctx).behavior).toBe(
      "allow",
    );
    const denied = policy("MultiEdit", { file_path: "/p/src/App.tsx" }, ctx);
    expect(denied).toMatchObject({ behavior: "deny" });
    expect(denied.behavior === "deny" && denied.message).toContain("move_to_prod");
    expect(policy("Write", { file_path: "/p/.finite/../src/App.tsx" }, ctx).behavior).toBe("deny");
    expect(policy("NotebookEdit", { notebook_path: "/p/n.ipynb" }, ctx).behavior).toBe("deny");
  });

  it("allows production writes during a move_to_prod turn, but never outside the project", () => {
    const prod = { ...ctx, prodWrite: true };
    expect(policy("Edit", { file_path: "/p/src/App.tsx" }, prod).behavior).toBe("allow");
    expect(policy("Write", { file_path: "/elsewhere/x.ts" }, prod).behavior).toBe("deny");
  });

  it("treats the root's realpath as the root", () => {
    const real = { ...ctx, root: "/var/p", realRoot: "/private/var/p" };
    expect(policy("Write", { file_path: "/private/var/p/.finite/A.tsx" }, real).behavior).toBe(
      "allow",
    );
    expect(policy("Write", { file_path: "/private/var/p/src/A.tsx" }, real).behavior).toBe("deny");
  });

  it("follows symlinks: a link under .finite/ to src/ or outside the project is still fenced", async () => {
    const project = await mkdtemp(path.join(os.tmpdir(), "finite-policy-"));
    const elsewhere = await mkdtemp(path.join(os.tmpdir(), "finite-elsewhere-"));
    try {
      await mkdir(path.join(project, ".finite/boards"), { recursive: true });
      await mkdir(path.join(project, "src"));
      await symlink(path.join(project, "src"), path.join(project, ".finite/boards/to-src"));
      await symlink(elsewhere, path.join(project, ".finite/out"));
      const real = { ...ctx, root: project };
      const write = (file: string) => policy("Write", { file_path: file }, real).behavior;
      expect(write(path.join(project, ".finite/boards/to-src/App.tsx"))).toBe("deny");
      expect(write(".finite/boards/to-src/new/Deep.tsx")).toBe("deny");
      expect(write(path.join(project, ".finite/out/x.ts"))).toBe("deny");
      expect(write(path.join(project, ".finite/boards/c1/New.tsx"))).toBe("allow");
      const prod = { ...real, prodWrite: true };
      expect(policy("Write", { file_path: ".finite/out/x.ts" }, prod).behavior).toBe("deny");
    } finally {
      await rm(project, { recursive: true, force: true });
      await rm(elsewhere, { recursive: true, force: true });
    }
  });

  it("refuses dialogs nobody can answer", () => {
    expect(policy("AskUserQuestion", {}, ctx).behavior).toBe("deny");
  });

  it("in a workspace, reads paths from its root and lets move_to_prod write shared packages", () => {
    const app = { ...ctx, root: "/w/apps/web", workspace: "/w" };
    const write = (file: string, c: typeof app = app) => policy("Write", { file_path: file }, c);
    expect(write("apps/web/.finite/boards/c1/A.tsx").behavior).toBe("allow");
    expect(write("/w/apps/web/src/assets/brand/logo.svg").behavior).toBe("allow");
    // The workspace's own .finite/ isn't this app's.
    expect(write(".finite/boards/c1/A.tsx").behavior).toBe("deny");
    const denied = write("packages/ui/src/Button.tsx");
    expect(denied.behavior === "deny" && denied.message).toContain(
      "apps/web/.finite/boards/<canvasId>/",
    );
    const prod = { ...app, prodWrite: true };
    expect(write("packages/ui/src/Button.tsx", prod).behavior).toBe("allow");
    expect(write("/elsewhere/x.ts", prod).behavior).toBe("deny");
  });

  it("lets a setup thread write finite.json and nothing else in production", () => {
    const setup = { ...ctx, configFile: "/p/finite.json" };
    expect(policy("Write", { file_path: "finite.json" }, setup).behavior).toBe("allow");
    expect(policy("Edit", { file_path: "/p/finite.json" }, setup).behavior).toBe("allow");
    const denied = policy("Write", { file_path: "/p/package.json" }, setup);
    expect(denied.behavior === "deny" && denied.message).toContain("writes only /p/finite.json");
    expect(policy("Write", { file_path: "/p/finite.json" }, ctx).behavior).toBe("deny");
    // A setup thread on an app in a repo writes the repo root's finite.json, outside the app.
    const repo = { ...ctx, root: "/r/apps/web", configFile: "/r/finite.json" };
    expect(policy("Write", { file_path: "/r/finite.json" }, repo).behavior).toBe("allow");
    expect(policy("Write", { file_path: "/r/other.json" }, repo).behavior).toBe("deny");
  });
});

describe("rootRelative", () => {
  it("takes a workspace-relative path into the app as relative to the app's root", () => {
    const design = { root: "/w/apps/web", workspace: "/w" };
    expect(rootRelative(design, "apps/web/src/App.tsx")).toBe("src/App.tsx");
    expect(rootRelative(design, "src/App.tsx")).toBe("src/App.tsx");
    expect(rootRelative(design, "packages/ui/x.tsx")).toBe("packages/ui/x.tsx");
    expect(rootRelative({ root: "/p" }, "apps/web/x.tsx")).toBe("apps/web/x.tsx");
  });
});

describe("event mapping", () => {
  const msg = (m: object) => m as unknown as SDKMessage;

  it("streams text, records tool calls and their results, and reports usage", () => {
    const map = createEventMapper("/p");
    expect(
      map(
        msg({
          type: "stream_event",
          parent_tool_use_id: null,
          event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hi" } },
        }),
        1,
      ),
    ).toEqual([{ type: "text.delta", text: "Hi" }]);
    expect(
      map(
        msg({
          type: "assistant",
          parent_tool_use_id: null,
          message: {
            content: [
              { type: "text", text: "Writing it." },
              {
                type: "tool_use",
                id: "t1",
                name: "Write",
                input: { file_path: "/p/.finite/A.tsx" },
              },
              {
                type: "tool_use",
                id: "t2",
                name: "mcp__finite__place_frames",
                input: { frames: [{}] },
              },
            ],
          },
        }),
        2,
      ),
    ).toEqual([
      { type: "text", text: "Writing it.", at: 2 },
      { type: "tool", id: "t1", name: "Write", summary: ".finite/A.tsx", status: "running", at: 2 },
      {
        type: "tool",
        id: "t2",
        name: "place_frames",
        summary: "1 frame",
        status: "running",
        at: 2,
      },
    ]);
    expect(
      map(
        msg({
          type: "user",
          parent_tool_use_id: null,
          message: {
            content: [
              { type: "tool_result", tool_use_id: "t1" },
              { type: "tool_result", tool_use_id: "t2", is_error: true },
            ],
          },
        }),
        3,
      ),
    ).toEqual([
      { type: "tool", id: "t1", name: "Write", summary: ".finite/A.tsx", status: "done", at: 3 },
      { type: "tool", id: "t2", name: "place_frames", summary: "1 frame", status: "error", at: 3 },
    ]);
    expect(
      map(result({ usage: { input_tokens: 5, cache_read_input_tokens: 10, output_tokens: 7 } }), 4),
    ).toEqual([{ type: "result", usage: { inputTokens: 15, outputTokens: 7 }, at: 4 }]);
  });

  it("reports a failed turn unless it was interrupted, and skips subagents", () => {
    const map = createEventMapper("/p");
    const failed = result({ subtype: "error_during_execution", is_error: true, errors: ["boom"] });
    expect(map(failed, 1).map((e) => e.type)).toEqual(["result", "error"]);
    expect(map(failed, 1, true).map((e) => e.type)).toEqual(["result"]);
    expect(
      map(
        msg({
          type: "assistant",
          parent_tool_use_id: "t9",
          message: { content: [{ type: "text", text: "sub" }] },
        }),
        1,
      ),
    ).toEqual([]);
  });
});

describe("layoutRow", () => {
  const size = DEFAULT_SIZE;

  it("starts at the origin on an empty canvas and keeps a gap", () => {
    expect(layoutRow([], [size, size])).toEqual([
      { x: 0, y: 0, ...size },
      { x: size.width + GAP, y: 0, ...size },
    ]);
  });

  it("goes right of the rightmost frame, or of rightOf, skipping frames in the way", () => {
    const a = { x: 0, y: 100, width: 400, height: 300 };
    const b = { x: 480, y: 100, width: 400, height: 300 };
    expect(layoutRow([a, b], [{ width: 200, height: 200 }])).toEqual([
      { x: 960, y: 100, width: 200, height: 200 },
    ]);
    expect(layoutRow([a, b], [{ width: 200, height: 200 }], a)).toEqual([
      { x: 960, y: 100, width: 200, height: 200 },
    ]);
  });
});

it("shortTitle keeps the first line short", () => {
  expect(shortTitle("Make the cart page friendlier")).toBe("Make the cart page friendlier");
  expect(shortTitle("\nExplore three layout directions for the checkout summary card please")).toBe(
    "Explore three layout directions for the…",
  );
  expect(shortTitle("   ")).toBe("New prototype");
});

// Agents, with a fake SDK query

type Fake = QueryLike & {
  options: Options;
  sent: SDKUserMessage[];
  emit(message: SDKMessage): void;
  closed: boolean;
  interrupt: ReturnType<typeof vi.fn>;
  setModel: ReturnType<typeof vi.fn>;
  applyFlagSettings: ReturnType<typeof vi.fn>;
};

function fakeSdk() {
  const queries: Fake[] = [];
  const query: QueryFn = ({ prompt, options }) => {
    const out: SDKMessage[] = [];
    let wake: (() => void) | undefined;
    const fake = {
      options,
      sent: [] as SDKUserMessage[],
      closed: false,
      emit(message: SDKMessage) {
        out.push(message);
        wake?.();
      },
      interrupt: vi.fn(async (_options?: { cancelQueued?: boolean }) => {
        fake.emit(
          result({
            subtype: "error_during_execution",
            is_error: true,
            errors: ["x"],
            user_message_uuid: fake.sent.at(-1)?.uuid,
          }),
        );
        return undefined;
      }),
      setModel: vi.fn(async () => {}),
      applyFlagSettings: vi.fn(async () => {}),
      supportedModels: async () => [],
      close() {
        fake.closed = true;
        wake?.();
      },
      async *[Symbol.asyncIterator]() {
        while (true) {
          const next = out.shift();
          if (next) yield next;
          else if (fake.closed) return;
          else await new Promise<void>((r) => (wake = r));
        }
      },
    };
    void (async () => {
      for await (const m of prompt) fake.sent.push(m);
    })();
    queries.push(fake as unknown as Fake);
    return fake as unknown as QueryLike;
  };
  return { query, queries };
}

function result(extra: object = {}): SDKMessage {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    result: "ok",
    errors: [],
    usage: { input_tokens: 1, output_tokens: 1 },
    session_id: "s1",
    queued_turn_count: 0,
    ...extra,
  } as unknown as SDKMessage;
}

/** Claude Code's record of a move_to_prod call; it's in the stream before the tool runs. */
const moveToProdCall = (id: string) =>
  ({
    type: "assistant",
    parent_tool_use_id: null,
    session_id: "s1",
    message: {
      content: [{ type: "tool_use", id, name: "mcp__finite__move_to_prod", input: {} }],
    },
  }) as unknown as SDKMessage;

/** The result of a turn Stop cancelled, answering the message that started it. */
const cancelled = (m: SDKUserMessage) =>
  result({
    subtype: "error_during_execution",
    is_error: true,
    errors: ["x"],
    user_message_uuid: m.uuid,
  });

const textOf = (m: SDKUserMessage) => {
  const content = m.message.content;
  if (typeof content === "string") return content;
  const first = content[0];
  return first?.type === "text" ? first.text : "";
};

async function connectTools(q: Fake) {
  const server = (q.options.mcpServers as Record<string, McpSdkServerConfigWithInstance>).finite!;
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(a);
  const client = new Client({ name: "test", version: "1" });
  await client.connect(b);
  return async (name: string, args: object, toolUseId?: string) => {
    const res = (await client.callTool({
      name,
      arguments: args as Record<string, unknown>,
      ...(toolUseId === undefined ? {} : { _meta: { "claudecode/toolUseId": toolUseId } }),
    })) as {
      isError?: boolean;
      content: { type: string; text?: string }[];
    };
    const text = res.content[0]?.text ?? "";
    if (res.isError) throw new Error(text);
    return text.startsWith("{") || text.startsWith("[") ? JSON.parse(text) : text;
  };
}

describe("agents", () => {
  let root: string;
  let open: OpenedDesign;
  let sdk: ReturnType<typeof fakeSdk>;
  let agents: ReturnType<typeof createAgents>;
  let preview: PreviewState = { status: "ready", url: "http://127.0.0.1:1" };
  const previews = { errors: () => [], state: () => preview } as unknown as Previews;
  const source = {} as SourceEditor;

  const turn = (text: string, extra: Partial<Turn> = {}): Turn => ({
    text,
    attachments: [],
    model: "haiku",
    fast: false,
    by: person,
    ...extra,
  });
  const meta = async (id: string) => (await open.threads()).find((t) => t.id === id)!;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "finite-agent-"));
    const design: Design = {
      id: "d1",
      name: "Shop",
      root,
      origin: "blank",
      router: "react-router",
      styling: "tailwind",
      css: [],
      brandDir: "src/assets/brand",
    };
    open = await openDesign(design);
    sdk = fakeSdk();
    agents = createAgents({
      store: {} as Store,
      previews,
      source,
      query: sdk.query,
      claudePath: async () => "/bin/claude",
      idleMs: 50,
    });
  });

  afterEach(async () => {
    await agents.close();
    open.close();
    await rm(root, { recursive: true, force: true });
  });

  async function newThread(text: string, canvasId?: string) {
    const t = turn(text);
    const thread = await startThread(open, { canvasId }, t);
    await agents.send(open, thread.id, t, "steer");
    return thread;
  }

  it("starts a session with Finite's options and hands the turn back on result", async () => {
    const canvas = await open.createCanvas({ kind: "prototype", name: "New prototype" }, person);
    const thread = await newThread("Make a pricing page", canvas.id);
    expect(thread.title).toBe("Make a pricing page");
    expect((await open.canvases())[0]!.threadIds).toEqual([thread.id]);

    const q = sdk.queries[0]!;
    expect(q.options).toMatchObject({
      pathToClaudeCodeExecutable: "/bin/claude",
      cwd: root,
      includePartialMessages: true,
      model: "haiku",
      permissionMode: "default",
      systemPrompt: { type: "preset", preset: "claude_code" },
      // Not the person's ~/.claude: their CLAUDE.md, skills and plugins cost tokens and don't apply.
      settingSources: ["project"],
      tools: BUILT_IN_TOOLS,
      strictMcpConfig: true,
    });
    expect(q.options.resume).toBeUndefined();
    const append = (q.options.systemPrompt as { append: string }).append;
    expect(append.startsWith(FINITE_INSTRUCTIONS)).toBe(true);
    expect(append).toContain(`.finite/boards/${canvas.id}/`);
    expect(FINITE_INSTRUCTIONS.length).toBeLessThan(2500);
    expect(Object.keys(q.options.mcpServers ?? {})).toEqual(["finite"]);

    await vi.waitFor(() => expect(q.sent).toHaveLength(1));
    expect(textOf(q.sent[0]!)).toBe("Make a pricing page");
    expect((await meta(thread.id)).running).toBe(true);

    q.emit({ type: "system", subtype: "init", session_id: "s1" } as unknown as SDKMessage);
    q.emit(result());
    await vi.waitFor(async () => expect((await meta(thread.id)).running).toBe(false));
    const after = await meta(thread.id);
    expect(after.sessionId).toBe("s1");
    expect(after.awaitingSince).toBeGreaterThan(0);
    const history = await open.history(thread.id);
    expect(history.map((e) => e.type)).toEqual(["user", "result"]);
  });

  it("queues while a turn runs and sends the queue after the result", async () => {
    const thread = await newThread("first");
    const q = sdk.queries[0]!;
    await agents.send(open, thread.id, turn("second"), "queue");
    let queued = (await meta(thread.id)).queued;
    expect(queued.map((m) => m.text)).toEqual(["second"]);

    const edited = await agents.editQueued(open, thread.id, queued[0]!.id, "second, edited");
    expect(edited.queued[0]!.text).toBe("second, edited");
    await agents.send(open, thread.id, turn("third"), "queue");
    queued = (await meta(thread.id)).queued;
    await agents.editQueued(open, thread.id, queued[1]!.id, null);
    await expect(agents.editQueued(open, thread.id, "nope", "x")).rejects.toThrow(/already sent/);

    q.emit(result());
    await vi.waitFor(() => expect(q.sent).toHaveLength(2));
    expect(textOf(q.sent[1]!)).toBe("second, edited");
    const m = await meta(thread.id);
    expect(m.queued).toEqual([]);
    expect(m.running).toBe(true);
  });

  it("runs the queue's next turn with the model the queued message was sent with", async () => {
    const thread = await newThread("first");
    const q = sdk.queries[0]!;
    await agents.send(
      open,
      thread.id,
      turn("second", { model: "sonnet", effort: "high" }),
      "queue",
    );
    expect(await meta(thread.id)).toMatchObject({ model: "sonnet", effort: "high" });
    expect(q.setModel).not.toHaveBeenCalled();
    q.emit(result());
    await vi.waitFor(() => expect(q.sent).toHaveLength(2));
    expect(q.setModel).toHaveBeenCalledWith("sonnet");
    expect(q.applyFlagSettings).toHaveBeenCalledWith({ effortLevel: "high", fastMode: false });
  });

  it("steers into the running turn right away", async () => {
    const thread = await newThread("first");
    const q = sdk.queries[0]!;
    await agents.send(open, thread.id, turn("actually, blue", { model: "sonnet" }), "steer");
    await vi.waitFor(() => expect(q.sent).toHaveLength(2));
    expect(q.sent[1]!.priority).toBe("now");
    expect(q.setModel).toHaveBeenCalledWith("sonnet");
    // The steer started its own turn: the first result says one more follows.
    q.emit(result({ queued_turn_count: 1 }));
    await new Promise((r) => setTimeout(r, 10));
    expect((await meta(thread.id)).running).toBe(true);
    q.emit(result());
    await vi.waitFor(async () => expect((await meta(thread.id)).running).toBe(false));
  });

  it("keeps a steered turn running through the result that ends the turn it cut short", async () => {
    const thread = await newThread("first");
    const q = sdk.queries[0]!;
    q.emit({ type: "system", subtype: "init", session_id: "s1" } as unknown as SDKMessage);
    await agents.send(open, thread.id, turn("steer: blue"), "steer");
    await vi.waitFor(() => expect(q.sent).toHaveLength(2));
    // Claude Code ends the cut-short turn with an empty result that counts no queued turns.
    q.emit(
      result({
        subtype: "error_during_execution",
        is_error: true,
        errors: [],
        usage: { input_tokens: 0, output_tokens: 0 },
      }),
    );
    await new Promise((r) => setTimeout(r, 20));
    expect((await meta(thread.id)).running).toBe(true);
    // ⌥⏎ right after the steer still queues.
    await agents.send(open, thread.id, turn("after that, labels"), "queue");
    expect((await meta(thread.id)).queued.map((m) => m.text)).toEqual(["after that, labels"]);
    expect(q.sent).toHaveLength(2);
    q.emit({ type: "system", subtype: "init", session_id: "s1" } as unknown as SDKMessage);
    q.emit(result());
    // The steer's own result ends it, and the queue goes next.
    await vi.waitFor(() =>
      expect(q.sent.map(textOf)).toEqual(["first", "steer: blue", "after that, labels"]),
    );
    expect((await meta(thread.id)).running).toBe(true);
    expect((await open.history(thread.id)).filter((e) => e.type === "error")).toEqual([]);
    q.emit({ type: "system", subtype: "init", session_id: "s1" } as unknown as SDKMessage);
    q.emit(result());
    await vi.waitFor(async () => expect((await meta(thread.id)).running).toBe(false));
  });

  it("ends a steered turn when the steer's own turn never starts", async () => {
    await agents.close();
    agents = createAgents({
      store: {} as Store,
      previews,
      source,
      query: sdk.query,
      claudePath: async () => "/bin/claude",
      idleMs: 50,
      steerGraceMs: 30,
    });
    const thread = await newThread("first");
    const q = sdk.queries[0]!;
    await agents.send(open, thread.id, turn("steer"), "steer");
    q.emit(result());
    await new Promise((r) => setTimeout(r, 5));
    expect((await meta(thread.id)).running).toBe(true);
    await vi.waitFor(async () => expect((await meta(thread.id)).running).toBe(false));
  });

  it("interrupts without sending the queue", async () => {
    const thread = await newThread("first");
    const q = sdk.queries[0]!;
    await agents.send(open, thread.id, turn("later"), "queue");
    await agents.interrupt(open, thread.id);
    expect(q.interrupt).toHaveBeenCalled();
    expect((await meta(thread.id)).running).toBe(false);
    await vi.waitFor(async () =>
      expect((await open.history(thread.id)).map((e) => e.type)).toEqual(["user", "result"]),
    );
    expect(q.sent).toHaveLength(1);
    expect((await meta(thread.id)).queued).toHaveLength(1);
  });

  it("counts a steer once when the result already counted its turn", async () => {
    const thread = await newThread("first");
    const q = sdk.queries[0]!;
    await agents.send(open, thread.id, turn("steer one"), "steer");
    await agents.send(open, thread.id, turn("steer two"), "steer");
    // One of the two steers was in the CLI's queue when the result was written.
    q.emit(result({ queued_turn_count: 1 }));
    q.emit({ type: "system", subtype: "init", session_id: "s1" } as unknown as SDKMessage);
    q.emit(result());
    await new Promise((r) => setTimeout(r, 20));
    // The last steer's turn hasn't started: its result holds the thread open.
    expect((await meta(thread.id)).running).toBe(true);
  });

  it("doesn't take a queued message's turn for a steer's", async () => {
    const thread = await newThread("first");
    const q = sdk.queries[0]!;
    await agents.send(open, thread.id, turn("queued"), "queue");
    q.emit(result());
    await vi.waitFor(() => expect(q.sent).toHaveLength(2));
    // A steer lands before the queued message's turn starts, then cuts it.
    await agents.send(open, thread.id, turn("steer"), "steer");
    q.emit({ type: "system", subtype: "init", session_id: "s1" } as unknown as SDKMessage);
    q.emit(result());
    await new Promise((r) => setTimeout(r, 20));
    expect((await meta(thread.id)).running).toBe(true);
  });

  it("keeps waiting when another steer arrives during a steer's wait", async () => {
    await agents.close();
    agents = createAgents({
      store: {} as Store,
      previews,
      source,
      query: sdk.query,
      claudePath: async () => "/bin/claude",
      idleMs: 50,
      steerGraceMs: 80,
    });
    const thread = await newThread("first");
    const q = sdk.queries[0]!;
    await agents.send(open, thread.id, turn("steer one"), "steer");
    q.emit(result());
    await new Promise((r) => setTimeout(r, 50));
    await agents.send(open, thread.id, turn("steer two"), "steer");
    await new Promise((r) => setTimeout(r, 50));
    expect((await meta(thread.id)).running).toBe(true);
    q.emit({ type: "system", subtype: "init", session_id: "s1" } as unknown as SDKMessage);
    q.emit(result());
    await vi.waitFor(async () => expect((await meta(thread.id)).running).toBe(false));
  });

  it("takes a queued steer back on Stop, so it doesn't run after the thread says stopped", async () => {
    const thread = await newThread("first");
    const q = sdk.queries[0]!;
    await agents.send(open, thread.id, turn("steer"), "steer");
    await vi.waitFor(() => expect(q.sent).toHaveLength(2));
    expect(q.sent[1]!.uuid).toBeDefined();
    await agents.interrupt(open, thread.id);
    expect(q.interrupt).toHaveBeenCalledWith({ cancelQueued: true });
  });

  it("keeps a message sent right after Stop running through the cancelled turn's result", async () => {
    const thread = await newThread("first");
    const q = sdk.queries[0]!;
    await vi.waitFor(() => expect(q.sent).toHaveLength(1));
    // The receipt comes before the cancelled result, as it does from the real CLI.
    q.interrupt.mockImplementationOnce(async () => undefined);
    await agents.interrupt(open, thread.id);
    await agents.send(open, thread.id, turn("again"), "steer");
    await vi.waitFor(() => expect(q.sent).toHaveLength(2));
    q.emit(cancelled(q.sent[0]!));
    await new Promise((r) => setTimeout(r, 20));
    expect((await meta(thread.id)).running).toBe(true);
    q.emit(result({ user_message_uuid: q.sent[1]!.uuid }));
    await vi.waitFor(async () => expect((await meta(thread.id)).running).toBe(false));
  });

  it("doesn't send the queue when the results of a cut and a cancelled turn follow Stop", async () => {
    const thread = await newThread("first");
    const q = sdk.queries[0]!;
    await agents.send(open, thread.id, turn("steer"), "steer");
    await agents.send(open, thread.id, turn("later"), "queue");
    await vi.waitFor(() => expect(q.sent).toHaveLength(2));
    let receipt!: () => void;
    q.interrupt.mockImplementationOnce(
      () => new Promise<undefined>((r) => (receipt = () => r(undefined))),
    );
    const stopping = agents.interrupt(open, thread.id);
    await vi.waitFor(() => expect(q.interrupt).toHaveBeenCalled());
    // The steer cut the first turn just before Stop: that result waits behind Stop.
    q.emit(result({ user_message_uuid: q.sent[0]!.uuid }));
    await new Promise((r) => setTimeout(r, 10));
    receipt();
    await stopping;
    q.emit(cancelled(q.sent[1]!));
    await new Promise((r) => setTimeout(r, 20));
    expect(q.sent).toHaveLength(2);
    const after = await meta(thread.id);
    expect(after.queued.map((m) => m.text)).toEqual(["later"]);
    expect(after.running).toBe(false);
  });

  it("sends the queue normally after a Stop during a steer's wait", async () => {
    const thread = await newThread("first");
    const q = sdk.queries[0]!;
    await agents.send(open, thread.id, turn("steer"), "steer");
    await vi.waitFor(() => expect(q.sent).toHaveLength(2));
    q.emit(result({ user_message_uuid: q.sent[0]!.uuid }));
    await new Promise((r) => setTimeout(r, 10));
    // The turn is over and the steer's never starts, so this Stop has no cancelled result.
    q.interrupt.mockImplementationOnce(async () => undefined);
    await agents.interrupt(open, thread.id);
    await agents.send(open, thread.id, turn("again"), "steer");
    await agents.send(open, thread.id, turn("queued"), "queue");
    await vi.waitFor(() => expect(q.sent).toHaveLength(3));
    q.emit(result({ user_message_uuid: q.sent[2]!.uuid }));
    await vi.waitFor(() => expect(q.sent.at(-1) && textOf(q.sent.at(-1)!)).toBe("queued"));
    expect((await meta(thread.id)).queued).toEqual([]);
  });

  it("keeps a queued message when the session dies during a steer's wait", async () => {
    await agents.close();
    agents = createAgents({
      store: {} as Store,
      previews,
      source,
      query: sdk.query,
      claudePath: async () => "/bin/claude",
      idleMs: 50,
      steerGraceMs: 20,
    });
    const thread = await newThread("first");
    const q = sdk.queries[0]!;
    await agents.send(open, thread.id, turn("steer"), "steer");
    await agents.send(open, thread.id, turn("later"), "queue");
    q.emit(result());
    await new Promise((r) => setTimeout(r, 5));
    q.close();
    await vi.waitFor(async () => expect((await meta(thread.id)).running).toBe(false));
    await new Promise((r) => setTimeout(r, 40));
    const after = await meta(thread.id);
    expect(after.queued.map((m) => m.text)).toEqual(["later"]);
    expect(after.running).toBe(false);
  });

  it("closes an idle session whose next message was refused", async () => {
    await agents.close();
    agents = createAgents({
      store: {} as Store,
      previews,
      source,
      query: sdk.query,
      claudePath: async () => "/bin/claude",
      idleMs: 100,
    });
    const thread = await newThread("first");
    const q = sdk.queries[0]!;
    q.emit(result());
    await vi.waitFor(async () => expect((await meta(thread.id)).running).toBe(false));
    q.setModel.mockRejectedValueOnce(new Error("no such model"));
    await expect(
      agents.send(open, thread.id, turn("again", { model: "nope" }), "steer"),
    ).rejects.toThrow("no such model");
    await vi.waitFor(() => expect(q.closed).toBe(true), { timeout: 1000 });
  });

  it("closes a new session whose first message couldn't be built", async () => {
    const t = turn("first");
    const thread = await startThread(open, {}, t);
    const broken: OpenDesign = {
      ...open,
      canvases: async () => {
        throw new Error("the design's files are gone");
      },
    };
    await expect(agents.send(broken, thread.id, t, "steer")).rejects.toThrow("files are gone");
    await vi.waitFor(() => expect(sdk.queries[0]!.closed).toBe(true), { timeout: 1000 });
  });

  it("closes an idle session and resumes it on the next message", async () => {
    const thread = await newThread("first");
    const q = sdk.queries[0]!;
    q.emit(result({ session_id: "s9" }));
    await vi.waitFor(() => expect(q.closed).toBe(true));
    await agents.send(open, thread.id, turn("again", { effort: "high" }), "steer");
    const next = sdk.queries[1]!;
    expect(next.options.resume).toBe("s9");
    expect(next.options.effort).toBe("high");
    await vi.waitFor(() => expect(next.sent).toHaveLength(1));
  });

  it("starts one session when two messages arrive while Claude Code is being found", async () => {
    await agents.close();
    agents = createAgents({
      store: {} as Store,
      previews,
      source,
      query: sdk.query,
      claudePath: () => new Promise((r) => setTimeout(() => r("/bin/claude"), 20)),
      idleMs: 50,
    });
    const thread = await startThread(open, {}, turn("first"));
    await Promise.all([
      agents.send(open, thread.id, turn("first"), "steer"),
      agents.send(open, thread.id, turn("second"), "steer"),
    ]);
    expect(sdk.queries).toHaveLength(1);
    await vi.waitFor(() => expect(sdk.queries[0]!.sent.map(textOf)).toEqual(["first", "second"]));
  });

  it("delivers a message queued while the finishing turn reads the queue", async () => {
    // The turn's own view of the design pauses right after it reads the (empty) queue.
    let gate!: () => void;
    let reading!: () => void;
    const read = new Promise<void>((r) => (reading = r));
    let armed = false;
    const slow: OpenDesign = {
      ...open,
      async threads() {
        const threads = await open.threads();
        if (armed) {
          reading();
          await new Promise<void>((r) => (gate = r));
        }
        return threads;
      },
    };
    const t = turn("first");
    const thread = await startThread(open, {}, t);
    await agents.send(slow, thread.id, t, "steer");
    const q = sdk.queries[0]!;
    armed = true;
    q.emit(result());
    await read;
    armed = false;
    const sending = agents.send(open, thread.id, turn("second"), "queue");
    await new Promise((r) => setTimeout(r, 10));
    gate();
    await sending;
    await vi.waitFor(() => expect(q.sent.map(textOf)).toEqual(["first", "second"]));
    expect((await meta(thread.id)).queued).toEqual([]);
  });

  it("holds a file's lock from a write's PreToolUse hook to its PostToolUse hook", async () => {
    await agents.close();
    const locks = createFileLocks();
    agents = createAgents({
      store: {} as Store,
      previews,
      source,
      query: sdk.query,
      claudePath: async () => "/bin/claude",
      locks,
      writeLockMs: 200,
    });
    await newThread("write a board");
    const hooks = sdk.queries[0]!.options.hooks!;
    const call = (event: "PreToolUse" | "PostToolUse", id: string, file: string) =>
      hooks[event]![0]!.hooks[0]!(
        {
          hook_event_name: event,
          tool_name: "Write",
          tool_input: { file_path: file },
          tool_use_id: id,
          tool_response: {},
        } as never,
        id,
        { signal: new AbortController().signal },
      );
    const file = path.join(root, ".finite/boards/c1/A.tsx");
    /** Tries the lock for 20ms; `got` turns true whenever it's taken. */
    const isFree = async () => {
      const state = { got: false, taking: Promise.resolve() };
      state.taking = locks.acquire([file]).then((release) => {
        state.got = true;
        release();
      });
      await new Promise((r) => setTimeout(r, 20));
      return state;
    };

    await call("PreToolUse", "t1", ".finite/boards/c1/A.tsx");
    const held = await isFree();
    expect(held.got).toBe(false);
    await call("PostToolUse", "t1", ".finite/boards/c1/A.tsx");
    await held.taking;
    expect(held.got).toBe(true);

    // A write Claude Code never reports back on lets go after writeLockMs.
    await call("PreToolUse", "t2", file);
    expect((await isFree()).got).toBe(false);
    await new Promise((r) => setTimeout(r, 200));
    expect((await isFree()).got).toBe(true);

    // A denied write takes no lock.
    const denied = await call("PreToolUse", "t3", path.join(root, "src/App.tsx"));
    expect(denied).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
    expect((await isFree()).got).toBe(true);
  });

  it("stops a design's sessions and waits for them before the design is removed", async () => {
    const thread = await newThread("first");
    const q = sdk.queries[0]!;
    await agents.stopDesign("d1");
    expect(q.closed).toBe(true);
    await agents.send(open, thread.id, turn("again"), "steer");
    expect(sdk.queries).toHaveLength(2);
    await agents.stopDesign("other");
    expect(sdk.queries[1]!.closed).toBe(false);
  });

  it("stops a design while its session is recording a result, without deadlocking", async () => {
    // The session's result pauses in appendEvent; its turn then needs the thread's mutex.
    let gate!: () => void;
    let appending!: () => void;
    const paused = new Promise<void>((r) => (appending = r));
    const slow: OpenDesign = {
      ...open,
      async appendEvent(threadId, event) {
        if (event.type === "result") {
          appending();
          await new Promise<void>((r) => (gate = r));
        }
        return open.appendEvent(threadId, event);
      },
    };
    const t = turn("first");
    const thread = await startThread(open, {}, t);
    await agents.send(slow, thread.id, t, "steer");
    const q = sdk.queries[0]!;
    q.emit(result());
    await paused;
    let stopped = false;
    const stopping = agents.stopDesign("d1").then(() => (stopped = true));
    await new Promise((r) => setTimeout(r, 10));
    expect(q.closed).toBe(true);
    gate();
    await vi.waitFor(() => expect(stopped).toBe(true), { timeout: 500 });
    await stopping;
  });

  it("stops a session that was starting when the design's removal began", async () => {
    await agents.close();
    let found!: (bin: string) => void;
    agents = createAgents({
      store: {} as Store,
      previews,
      source,
      query: sdk.query,
      claudePath: () => new Promise((r) => (found = r)),
      idleMs: 50,
    });
    const thread = await startThread(open, {}, turn("first"));
    const sending = agents.send(open, thread.id, turn("first"), "steer");
    await vi.waitFor(() => expect(found).toBeDefined());
    let stopped = false;
    const stopping = agents.stopDesign("d1").then(() => (stopped = true));
    // A message sent while the design is going is refused.
    const other = await startThread(open, {}, turn("late"));
    await expect(agents.send(open, other.id, turn("late"), "steer")).rejects.toThrow(
      /being removed/,
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(stopped).toBe(false);
    found("/bin/claude");
    await sending;
    await stopping;
    expect(sdk.queries).toHaveLength(1);
    expect(sdk.queries[0]!.closed).toBe(true);
    // Once it's over, the design takes messages again (a reconnected folder keeps its id).
    const first = found;
    const again = agents.send(open, thread.id, turn("again"), "steer");
    await vi.waitFor(() => expect(found).not.toBe(first));
    found("/bin/claude");
    await again;
    expect(sdk.queries).toHaveLength(2);
  });

  it("locks a write through a symlink under the real file's lock", async () => {
    await agents.close();
    const locks = createFileLocks();
    agents = createAgents({
      store: {} as Store,
      previews,
      source,
      query: sdk.query,
      claudePath: async () => "/bin/claude",
      locks,
    });
    await mkdir(path.join(root, ".finite/real"), { recursive: true });
    await writeFile(path.join(root, ".finite/real/A.tsx"), "x");
    await symlink(path.join(root, ".finite/real"), path.join(root, ".finite/alias"));
    await newThread("write");
    const pre = sdk.queries[0]!.options.hooks!.PreToolUse![0]!.hooks[0]!;
    await pre(
      {
        hook_event_name: "PreToolUse",
        tool_name: "Write",
        tool_input: { file_path: ".finite/alias/A.tsx" },
        tool_use_id: "t1",
      } as never,
      "t1",
      { signal: new AbortController().signal },
    );
    let got = false;
    void locks.acquire([path.join(root, ".finite/real/A.tsx")]).then((release) => {
      got = true;
      release();
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(got).toBe(false);
    await agents.close();
    await vi.waitFor(() => expect(got).toBe(true));
  });

  it("lets go of a lock a write's hook was still waiting for when the session shut", async () => {
    await agents.close();
    const locks = createFileLocks();
    agents = createAgents({
      store: {} as Store,
      previews,
      source,
      query: sdk.query,
      claudePath: async () => "/bin/claude",
      locks,
      writeLockMs: 60_000,
    });
    await newThread("write");
    const file = path.join(root, ".finite/boards/c1/A.tsx");
    const editor = await locks.acquire([file]);
    const pre = sdk.queries[0]!.options.hooks!.PreToolUse![0]!.hooks[0]!;
    const waiting = pre(
      {
        hook_event_name: "PreToolUse",
        tool_name: "Write",
        tool_input: { file_path: file },
        tool_use_id: "t1",
      } as never,
      "t1",
      { signal: new AbortController().signal },
    );
    await agents.stopDesign("d1");
    editor();
    await waiting;
    let got = false;
    void locks.acquire([file]).then((release) => {
      got = true;
      release();
    });
    await vi.waitFor(() => expect(got).toBe(true), { timeout: 200 });
  });

  it("revives a snoozed or settled thread when messaged", async () => {
    const thread = await newThread("first");
    sdk.queries[0]!.emit(result());
    await vi.waitFor(async () => expect((await meta(thread.id)).running).toBe(false));
    await open.updateThread(thread.id, (m) => ({
      ...m,
      snoozedUntil: Date.now() + 1e6,
      settledAt: 1,
    }));
    await agents.send(open, thread.id, turn("back"), "queue");
    const m = await meta(thread.id);
    expect(m.snoozedUntil).toBeUndefined();
    expect(m.settledAt).toBeUndefined();
  });

  it("starts a prototype: a thread and its canvas, linked and named alike", async () => {
    const thread = await startThread(open, { prototype: true }, turn("Make a small pricing card"));
    const [canvas] = (await open.canvases()).filter((c) => c.kind === "prototype");
    expect(canvas).toMatchObject({ name: "Make a small pricing card", threadIds: [thread.id] });
    expect(thread.canvasIds).toEqual([canvas!.id]);
  });

  it("starts a prototype from a selection with a copy of the selected frame", async () => {
    const routes = await open.createCanvas({ kind: "page", name: "Routes" }, person);
    const home = {
      id: "home",
      name: "Home",
      x: 500,
      y: 300,
      width: 1440,
      height: 900,
      gone: true,
      source: { kind: "route" as const, path: "/" },
    };
    await open.patchCanvas(routes.id, { op: "addFrames", frames: [home] }, person);
    const thread = await startThread(
      open,
      { prototype: true },
      turn("Explore 2 color directions for Home"),
    );
    const canvasId = thread.canvasIds[0]!;
    const selection = await carrySelection(
      open,
      canvasId,
      [{ frameId: "home", loc: "src/Home.tsx:3:4" }, { frameId: "home" }],
      person,
    );
    const proto = (await open.canvases()).find((c) => c.id === canvasId)!;
    expect(proto.frames).toHaveLength(1);
    const copy = proto.frames[0]!;
    expect(copy).toMatchObject({ name: "Home", x: 0, y: 0, width: 1440, source: home.source });
    expect(copy.id).not.toBe("home");
    expect(copy.gone).toBeUndefined();
    expect(selection).toEqual([
      { frameId: copy.id, loc: "src/Home.tsx:3:4" },
      { frameId: copy.id },
    ]);
    expect(proto.texts.map((t) => [t.title, t.body, t.y])).toEqual([
      ["Home", "The source: production route /.", -LABEL_OFFSET],
    ]);
    // Variants then go to its right.
    expect(layoutRow(proto.frames, [{ width: 400, height: 300 }], copy)[0]!.x).toBe(1440 + GAP);
  });

  it("sends attachments and the selection in the message", async () => {
    await mkdir(path.join(root, ".finite/attachments"), { recursive: true });
    await writeFile(path.join(root, ".finite/attachments/shot.png"), new Uint8Array([1, 2, 3]));
    const canvas = await open.createCanvas({ kind: "prototype", name: "P" }, person);
    await open.patchCanvas(
      canvas.id,
      {
        op: "addFrames",
        frames: [
          {
            id: "f1",
            name: "Cart",
            x: 0,
            y: 0,
            width: 100,
            height: 100,
            source: { kind: "file", file: ".finite/boards/x/Cart.tsx" },
          },
        ],
      },
      person,
    );
    const t = turn("Fix this", {
      attachments: [".finite/attachments/shot.png"],
      selection: [{ frameId: "f1", loc: "src/Cart.tsx:4:2", index: 1 }, { frameId: "f1" }],
    });
    const thread = await startThread(open, { canvasId: canvas.id }, t);
    await agents.send(open, thread.id, t, "steer");
    const q = sdk.queries[0]!;
    await vi.waitFor(() => expect(q.sent).toHaveLength(1));
    const text = textOf(q.sent[0]!);
    expect(text).toContain(path.join(root, ".finite/attachments/shot.png"));
    expect(text).toContain('"Cart" (frame f1): element src/Cart.tsx:4:2, instance 1');
    expect(text).toContain('"Cart" (frame f1, file .finite/boards/x/Cart.tsx): the whole frame');
    const content = q.sent[0]!.message.content as { type: string }[];
    expect(content.map((b) => b.type)).toEqual(["text", "image"]);
  });

  it("places frames with labels, names the thread and comments through the canvas tools", async () => {
    const canvas = await open.createCanvas({ kind: "prototype", name: "P" }, person);
    const thread = await newThread("Pricing", canvas.id);
    const call = await connectTools(sdk.queries[0]!);
    const board = path.join(root, ".finite/boards", canvas.id);
    await mkdir(board, { recursive: true });
    await writeFile(path.join(board, "A.tsx"), "export default () => null;");
    await writeFile(path.join(board, "B.tsx"), "export default () => null;");

    await expect(
      call("place_frames", {
        canvasId: canvas.id,
        frames: [{ file: "Missing.tsx", name: "M", title: "t", why: "w" }],
      }),
    ).rejects.toThrow(/doesn't exist/);

    const { placed } = await call("place_frames", {
      canvasId: canvas.id,
      frames: [
        { file: "A.tsx", name: "Plans A", title: "Calm", why: "Fewer choices" },
        {
          file: `.finite/boards/${canvas.id}/B.tsx`,
          name: "Plans B",
          title: "Bold",
          why: "Big CTA",
          width: 800,
          height: 600,
        },
      ],
    });
    expect(placed.map((f: { x: number }) => f.x)).toEqual([0, DEFAULT_SIZE.width + GAP]);
    const c = (await open.canvases()).find((x) => x.id === canvas.id)!;
    expect(c.frames.map((f) => f.source)).toEqual([
      { kind: "file", file: `.finite/boards/${canvas.id}/A.tsx` },
      { kind: "file", file: `.finite/boards/${canvas.id}/B.tsx` },
    ]);
    expect(c.texts.map((t) => [t.title, t.body, t.y, t.author.kind])).toEqual([
      ["Calm", "Fewer choices", -LABEL_OFFSET, "agent"],
      ["Bold", "Big CTA", -LABEL_OFFSET, "agent"],
    ]);

    await call("name_thread", { title: "Pricing page" });
    expect((await meta(thread.id)).title).toBe("Pricing page");
    // The thread's prototype canvas takes its name.
    expect((await open.canvases()).find((x) => x.id === canvas.id)!.name).toBe("Pricing page");

    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(
      path.join(root, "src/A.tsx"),
      "export default () => (\n  <main>\n    <h1>Hi</h1>\n  </main>\n);\n",
    );
    // A 1-based column lands on the element whose tag holds it.
    const pinned = await call("comment", {
      frameId: placed[0].id,
      loc: "src/A.tsx:3:5",
      index: 2,
      text: "Look here",
    });
    expect(pinned.loc).toBe("src/A.tsx:3:4");
    await call("comment", { frameId: placed[0].id, loc: "src/A.tsx", match: "hi", text: "Hi" });
    await expect(
      call("comment", { frameId: placed[0].id, loc: "src/A.tsx:1:0", text: "Nope" }),
    ).rejects.toThrow(
      /no HTML element at line 1, column 0 in src\/A.tsx. Elements near there: <main> src\/A.tsx:2:2/,
    );
    await expect(
      call("comment", { frameId: placed[0].id, loc: "src/Missing.tsx:1:0", text: "Nope" }),
    ).rejects.toThrow(/isn't a file in the design/);
    const comments = (await open.canvases()).find((x) => x.id === canvas.id)!.comments;
    expect(comments.map((m) => m.anchor)).toEqual([
      { frameId: placed[0].id, loc: "src/A.tsx:3:4", index: 2 },
      { frameId: placed[0].id, loc: "src/A.tsx:3:4" },
    ]);
    expect(comments[0]).toMatchObject({
      author: { kind: "agent", id: thread.id },
      text: "Look here",
    });

    const read = await call("read_canvas", {});
    expect(read.frames).toHaveLength(2);
    expect(read.comments).toHaveLength(2);
    expect(await call("frame_errors", { frameId: placed[0].id })).toBe("No errors.");
    preview = { status: "error", log: 'Service "api" exited (code 1) after it was ready.' };
    await expect(call("frame_errors", { frameId: placed[0].id })).rejects.toThrow(
      /preview is down, so no frame runs:\n\nService "api" exited/,
    );
    preview = { status: "ready", url: "http://127.0.0.1:1" };

    // A prototype's frames can be removed, with the labels above them.
    await call("remove_frames", { canvasId: canvas.id, frameIds: [placed[1].id] });
    const after = (await open.canvases()).find((x) => x.id === canvas.id)!;
    expect(after.frames.map((f) => f.id)).toEqual([placed[0].id]);
    expect(after.texts.map((t) => t.title)).toEqual(["Calm"]);
  });

  it("removes only its own frames from a page", async () => {
    const page = await open.createCanvas({ kind: "page", name: "Brand" }, person);
    const frame = (id: string, by?: Actor) => ({
      id,
      name: id,
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      source: { kind: "file" as const, file: "a.tsx" },
      ...(by ? { placedBy: by } : {}),
    });
    const thread = await newThread("Tidy", page.id);
    await open.patchCanvas(
      page.id,
      { op: "addFrames", frames: [frame("mine", agentActor(thread.id)), frame("theirs")] },
      person,
    );
    const call = await connectTools(sdk.queries[0]!);
    await expect(
      call("remove_frames", { canvasId: page.id, frameIds: ["theirs"] }),
    ).rejects.toThrow(/wasn't placed by this thread/);
    await call("remove_frames", { canvasId: page.id, frameIds: ["mine"] });
    const after = (await open.canvases()).find((c) => c.id === page.id)!;
    expect(after.frames.map((f) => f.id)).toEqual(["theirs"]);
  });

  it("add_brand_asset copies the file into the brand folder and shows the board", async () => {
    const thread = await newThread("Logo");
    await writeFile(path.join(root, "logo.svg"), "<svg/>");
    const call = await connectTools(sdk.queries[0]!);
    const out = await call("add_brand_asset", { path: "logo.svg" });
    expect(out.file).toBe("src/assets/brand/logo.svg");
    expect(await readFile(path.join(root, "src/assets/brand/logo.svg"), "utf8")).toBe("<svg/>");
    const brand = (await open.canvases()).find((c) => c.id === out.brandCanvasId)!;
    expect(brand.name).toBe("Brand");
    expect(brand.texts).toEqual([]);
    expect(brand.frames.map((f) => [f.source, f.hug])).toEqual([
      [{ kind: "file", file: BRAND_BOARD }, true],
    ]);
    expect(thread.id).toBeTruthy();
  });

  it("move_to_prod allows production writes for the rest of the turn and settles it", async () => {
    const canvas = await open.createCanvas({ kind: "prototype", name: "P" }, person);
    await open.patchCanvas(
      canvas.id,
      {
        op: "addFrames",
        frames: [
          {
            id: "f1",
            name: "Cart",
            x: 0,
            y: 0,
            width: 100,
            height: 100,
            source: { kind: "file", file: "a.tsx" },
          },
        ],
      },
      person,
    );
    const thread = await newThread("Ship it", canvas.id);
    const q = sdk.queries[0]!;
    const canUse = q.options.canUseTool!;
    const opts = { signal: new AbortController().signal, toolUseID: "t", requestId: "r" };
    const write = { file_path: path.join(root, "src/App.tsx") };
    expect((await canUse("Edit", write, opts))?.behavior).toBe("deny");

    const call = await connectTools(q);
    await call("move_to_prod", { frameIds: ["f1"] });
    expect((await canUse("Edit", write, opts))?.behavior).toBe("allow");

    q.emit(result());
    await vi.waitFor(async () => expect((await meta(thread.id)).settledAt).toBeGreaterThan(0));
    expect((await canUse("Edit", write, opts))?.behavior).toBe("deny");
  });

  it("revokes move_to_prod when a steer cuts the turn, and still settles if its turn never starts", async () => {
    await agents.close();
    agents = createAgents({
      store: {} as Store,
      previews,
      source,
      query: sdk.query,
      claudePath: async () => "/bin/claude",
      idleMs: 50,
      steerGraceMs: 150,
    });
    const canvas = await open.createCanvas({ kind: "prototype", name: "P" }, person);
    await open.patchCanvas(
      canvas.id,
      {
        op: "addFrames",
        frames: [
          {
            id: "f1",
            name: "Cart",
            x: 0,
            y: 0,
            width: 100,
            height: 100,
            source: { kind: "file", file: "a.tsx" },
          },
        ],
      },
      person,
    );
    const thread = await newThread("Ship it", canvas.id);
    const q = sdk.queries[0]!;
    const canUse = q.options.canUseTool!;
    const opts = { signal: new AbortController().signal, toolUseID: "t", requestId: "r" };
    const write = { file_path: path.join(root, "src/App.tsx") };
    await (
      await connectTools(q)
    )("move_to_prod", { frameIds: ["f1"] });
    expect((await canUse("Edit", write, opts))?.behavior).toBe("allow");

    await agents.send(open, thread.id, turn("also do this"), "steer");
    q.emit(result());
    await new Promise((r) => setTimeout(r, 20));
    expect((await meta(thread.id)).running).toBe(true);
    expect((await canUse("Edit", write, opts))?.behavior).toBe("deny");
    await vi.waitFor(async () => expect((await meta(thread.id)).settledAt).toBeGreaterThan(0));
  });

  it("revokes a move_to_prod that lands while Stop winds the turn down", async () => {
    const canvas = await open.createCanvas({ kind: "prototype", name: "P" }, person);
    await open.patchCanvas(
      canvas.id,
      {
        op: "addFrames",
        frames: [
          {
            id: "f1",
            name: "Cart",
            x: 0,
            y: 0,
            width: 100,
            height: 100,
            source: { kind: "file", file: "a.tsx" },
          },
        ],
      },
      person,
    );
    const thread = await newThread("Ship it", canvas.id);
    const q = sdk.queries[0]!;
    await vi.waitFor(() => expect(q.sent).toHaveLength(1));
    const canUse = q.options.canUseTool!;
    const opts = { signal: new AbortController().signal, toolUseID: "t", requestId: "r" };
    const write = { file_path: path.join(root, "src/App.tsx") };
    q.interrupt.mockImplementationOnce(async () => undefined);
    await agents.interrupt(open, thread.id);
    await (
      await connectTools(q)
    )("move_to_prod", { frameIds: ["f1"] });
    q.emit(cancelled(q.sent[0]!));
    await vi.waitFor(async () =>
      expect((await canUse("Edit", write, opts))?.behavior).toBe("deny"),
    );
  });

  describe("a Stop racing the next turn's move_to_prod", () => {
    const opts = { signal: new AbortController().signal, toolUseID: "t", requestId: "r" };

    /** Stops the first turn, with its cancelled result still unread, and sends a second. */
    async function stoppedThenSent() {
      const canvas = await open.createCanvas({ kind: "prototype", name: "P" }, person);
      await open.patchCanvas(
        canvas.id,
        {
          op: "addFrames",
          frames: [
            {
              id: "f1",
              name: "Cart",
              x: 0,
              y: 0,
              width: 100,
              height: 100,
              source: { kind: "file", file: "a.tsx" },
            },
          ],
        },
        person,
      );
      const thread = await newThread("Ship it", canvas.id);
      const q = sdk.queries[0]!;
      await vi.waitFor(() => expect(q.sent).toHaveLength(1));
      q.interrupt.mockImplementationOnce(async () => undefined);
      await agents.interrupt(open, thread.id);
      await agents.send(open, thread.id, turn("Ship it again"), "steer");
      await vi.waitFor(() => expect(q.sent).toHaveLength(2));
      const edit = async () =>
        (await q.options.canUseTool!("Edit", { file_path: path.join(root, "src/App.tsx") }, opts))
          ?.behavior;
      return { thread, q, edit, call: await connectTools(q) };
    }

    it("keeps the new turn's grant when the stopped turn's result is read after it", async () => {
      const { thread, q, edit, call } = await stoppedThenSent();
      await call("move_to_prod", { frameIds: ["f1"] }, "toolu_second");
      expect(await edit()).toBe("allow");

      q.emit(cancelled(q.sent[0]!));
      await new Promise((r) => setTimeout(r, 20));
      expect(await edit()).toBe("allow");

      q.emit(moveToProdCall("toolu_second"));
      q.emit(result({ user_message_uuid: q.sent[1]!.uuid }));
      await vi.waitFor(async () => expect((await meta(thread.id)).settledAt).toBeGreaterThan(0));
      expect(await edit()).toBe("deny");
    });

    it("revokes the stopped turn's own late grant, even with the next turn already sent", async () => {
      const { q, edit, call } = await stoppedThenSent();
      q.emit(moveToProdCall("toolu_first"));
      await call("move_to_prod", { frameIds: ["f1"] }, "toolu_first");
      expect(await edit()).toBe("allow");

      q.emit(cancelled(q.sent[0]!));
      await vi.waitFor(async () => expect(await edit()).toBe("deny"));
    });
  });

  it("spawns a child thread that starts on its prompt", async () => {
    const thread = await newThread("Parent");
    const call = await connectTools(sdk.queries[0]!);
    const { threadId } = await call("spawn_thread", { prompt: "Import the brand logo" });
    const child = await meta(threadId);
    expect(child.parentId).toBe(thread.id);
    expect(child.running).toBe(true);
    await vi.waitFor(() => expect(sdk.queries[1]?.sent).toHaveLength(1));
    expect(textOf(sdk.queries[1]!.sent[0]!)).toBe("Import the brand logo");
  });
});

describe("setup threads", () => {
  let workspace: string;
  let sdk: ReturnType<typeof fakeSdk>;
  const opens: OpenedDesign[] = [];
  const turn = { model: "haiku", fast: false };

  beforeEach(async () => {
    workspace = await mkdtemp(path.join(os.tmpdir(), "finite-setup-"));
    sdk = fakeSdk();
  });
  afterEach(async () => {
    for (const o of opens.splice(0)) o.close();
    await rm(workspace, { recursive: true, force: true });
  });

  async function openAt(root: string, extra: Partial<Design>): Promise<OpenedDesign> {
    const o = await openDesign({
      id: extra.id ?? "d1",
      name: "Shop",
      root,
      origin: "connected",
      router: "react-router",
      styling: "tailwind",
      css: [],
      brandDir: "src/assets/brand",
      ...extra,
    });
    opens.push(o);
    return o;
  }

  function agentsWith(store: Partial<Store>, previews: Partial<Previews>) {
    const agents = createAgents({
      store: store as Store,
      previews: { errors: () => [], ...previews } as Previews,
      source: {} as SourceEditor,
      query: sdk.query,
      claudePath: async () => "/bin/claude",
      idleMs: 50,
    });
    return agents;
  }

  async function startIn(open: OpenDesign, agents: ReturnType<typeof createAgents>) {
    const thread = await startSetup(open, turn);
    expect(thread).toMatchObject({ setup: true, title: "Set up Finite", canvasIds: [] });
    await agents.send(
      open,
      thread.id,
      { ...turn, text: "Set up", attachments: [], by: person },
      "steer",
    );
    return thread;
  }

  it("works from the workspace, may write finite.json, and gives way to the apps it connects", async () => {
    const open = await openAt(workspace, {
      id: "setup",
      router: "none",
      styling: "inline",
      brandDir: "assets/brand",
      workspace,
      setup: true,
    });
    const web: DesignEntry = {
      id: "web",
      name: "@acme/web",
      root: path.join(workspace, "apps/web"),
      origin: "connected",
      updatedAt: 1,
      workspace,
      app: "web",
    };
    const finishSetup = vi
      .fn()
      .mockRejectedValueOnce(
        new Refused(
          "finite.json isn't valid. Fix this problem:\n- apps.web.path: …",
          "invalid-config",
        ),
      )
      .mockResolvedValueOnce({ apps: [web], next: web, replaced: true });
    const remove = vi.fn(async () => {});
    const stop = vi.fn(async () => {});
    const ensure = vi.fn(async () => ({ url: "http://127.0.0.1:5555" }));
    const agents = agentsWith(
      { finishSetup, remove, open: async () => ({ design: { ...web } }) as unknown as OpenDesign },
      { stop, ensure, remove: async () => {} },
    );
    await startIn(open, agents);
    const q = sdk.queries[0]!;
    expect(q.options.cwd).toBe(workspace);
    const append = (q.options.systemPrompt as { append: string }).append;
    expect(append.startsWith(SETUP_INSTRUCTIONS)).toBe(true);
    expect(append).toContain(`Write finite.json at ${path.join(workspace, "finite.json")}.`);
    expect(SETUP_INSTRUCTIONS.length).toBeLessThan(2500);

    const canUse = q.options.canUseTool!;
    const opts = { signal: new AbortController().signal, toolUseID: "t", requestId: "r" };
    expect((await canUse("Write", { file_path: "finite.json" }, opts))?.behavior).toBe("allow");
    expect((await canUse("Edit", { file_path: "package.json" }, opts))?.behavior).toBe("deny");

    const call = await connectTools(q);
    await expect(call("finish_setup", {})).rejects.toThrow(/apps\.web\.path/);
    const out = await call("finish_setup", {});
    expect(out).toMatchObject({
      connected: [{ designId: "web", app: "web" }],
      preview: "@acme/web runs at http://127.0.0.1:5555.",
    });
    expect(stop).toHaveBeenCalledWith("web");
    expect(ensure).toHaveBeenCalledWith(expect.objectContaining({ id: "web" }));
    expect(remove).not.toHaveBeenCalled();

    // The setup design goes when the turn that replaced it ends.
    q.emit(result());
    await vi.waitFor(() => expect(remove).toHaveBeenCalledWith("setup"));
    expect(q.closed).toBe(true);
    await agents.close();
  });

  it.each(["the session dies", "the person presses Stop"])(
    "removes a replaced setup design when %s",
    async (how) => {
      const open = await openAt(workspace, {
        id: "setup",
        router: "none",
        styling: "inline",
        brandDir: "assets/brand",
        workspace,
        setup: true,
      });
      const web: DesignEntry = {
        id: "web",
        name: "@acme/web",
        root: path.join(workspace, "apps/web"),
        origin: "connected",
        updatedAt: 1,
        workspace,
        app: "web",
      };
      const remove = vi.fn(async () => {});
      const agents = agentsWith(
        {
          finishSetup: async () => ({ apps: [web], next: web, replaced: true }) as never,
          remove,
          open: async () => ({ design: { ...web } }) as unknown as OpenDesign,
        },
        {
          stop: async () => {},
          remove: async () => {},
          ensure: async () => ({ url: "http://127.0.0.1:5555" }) as never,
        },
      );
      const thread = await startIn(open, agents);
      const q = sdk.queries[0]!;
      await (
        await connectTools(q)
      )("finish_setup", {});
      if (how === "the session dies") q.close();
      else await agents.interrupt(open, thread.id);
      await vi.waitFor(() => expect(remove).toHaveBeenCalledWith("setup"));
      await agents.close();
    },
  );

  it("restarts a connected design's preview and reports why it still fails", async () => {
    const open = await openAt(workspace, {});
    const self = { id: "d1", name: "Shop", root: workspace, origin: "connected", updatedAt: 1 };
    const stop = vi.fn(async () => {});
    const ensure = vi.fn(async () => {
      throw new Error("pnpm -F api build exited with code 1");
    });
    const remove = vi.fn(async () => {});
    const agents = agentsWith(
      {
        finishSetup: async () => ({ apps: [self], next: self, replaced: false }) as never,
        open: async () => open,
        remove,
      },
      { stop, ensure, state: () => ({ status: "error", log: "line 1\nboom" }) },
    );
    await startIn(open, agents);
    const q = sdk.queries[0]!;
    // No finite.json above it and no repository: it goes in the design's own folder.
    expect((q.options.systemPrompt as { append: string }).append).toContain(
      `Write finite.json at ${path.join(workspace, "finite.json")}.`,
    );
    const out = await (await connectTools(q))("finish_setup", {});
    expect(out).toMatchObject({
      preview: "Shop didn't start: pnpm -F api build exited with code 1",
      log: "line 1\nboom",
    });
    expect(stop).toHaveBeenCalledWith("d1");
    expect(ensure).toHaveBeenCalledWith(open.design);
    q.emit(result());
    await vi.waitFor(async () => expect((await open.threads())[0]!.running).toBe(false));
    expect(remove).not.toHaveBeenCalled();
    expect(q.closed).toBe(false);
    await agents.close();
  });

  it("runs a workspace app's threads from the workspace, taking workspace paths", async () => {
    const root = path.join(workspace, "apps/web");
    const open = await openAt(root, { workspace, app: "web" });
    const agents = agentsWith({}, {});
    const canvas = await open.createCanvas({ kind: "prototype", name: "P" }, person);
    const t = { ...turn, text: "Pricing", attachments: [], by: person };
    const thread = await startThread(open, { canvasId: canvas.id }, t);
    await agents.send(open, thread.id, t, "steer");
    const q = sdk.queries[0]!;
    expect(q.options.cwd).toBe(workspace);
    const append = (q.options.systemPrompt as { append: string }).append;
    expect(append.startsWith(FINITE_INSTRUCTIONS)).toBe(true);
    expect(append).toContain(`apps/web/.finite/boards/${canvas.id}/`);
    const board = path.join(root, ".finite/boards", canvas.id);
    await mkdir(board, { recursive: true });
    await writeFile(path.join(board, "A.tsx"), "export default () => null;");
    const { placed } = await (
      await connectTools(q)
    )("place_frames", {
      canvasId: canvas.id,
      frames: [
        {
          file: `apps/web/.finite/boards/${canvas.id}/A.tsx`,
          name: "A",
          title: "t",
          why: "w",
          width: 10,
          height: 10,
        },
      ],
    });
    expect(placed[0].source).toEqual({ kind: "file", file: `.finite/boards/${canvas.id}/A.tsx` });
    await agents.close();
  });
});

describe("status", () => {
  it("says what to do when Claude Code is missing or logged out", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "finite-claude-"));
    const bin = path.join(dir, "claude");
    await writeFile(
      bin,
      `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "2.1.0 (Claude Code)"; exit 0; fi\necho '{"loggedIn":false}'; exit 1\n`,
      { mode: 0o755 },
    );
    const query = (() => {
      throw new Error("no query while logged out");
    }) as unknown as QueryFn;
    try {
      expect(await createStatus(query, async () => undefined)()).toEqual({
        installed: false,
        loggedIn: false,
        reason: NOT_INSTALLED,
        models: [],
      });
      expect(await createStatus(query, async () => bin)()).toEqual({
        installed: true,
        loggedIn: false,
        version: "2.1.0",
        reason: NOT_LOGGED_IN,
        models: [],
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
