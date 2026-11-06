import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  McpSdkServerConfigWithInstance,
  Options,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { Design, Previews, SourceEditor, Store, Turn } from "@finite/protocol";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { openDesign, type OpenedDesign } from "../store/open.ts";
import { createEventMapper } from "./events.ts";
import { createAgents, type QueryFn, type QueryLike, shortTitle, startThread } from "./index.ts";
import { FINITE_INSTRUCTIONS } from "./instructions.ts";
import { policy } from "./policy.ts";
import { DEFAULT_SIZE, GAP, LABEL_OFFSET, layoutRow } from "./tools.ts";

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

  it("refuses dialogs nobody can answer", () => {
    expect(policy("AskUserQuestion", {}, ctx).behavior).toBe("deny");
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
      interrupt: vi.fn(async () => {
        fake.emit(result({ subtype: "error_during_execution", is_error: true, errors: ["x"] }));
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

const textOf = (m: SDKUserMessage) => {
  const content = m.message.content;
  if (typeof content === "string") return content;
  const first = content[0];
  return first?.type === "text" ? first.text : "";
};

describe("agents", () => {
  let root: string;
  let open: OpenedDesign;
  let sdk: ReturnType<typeof fakeSdk>;
  let agents: ReturnType<typeof createAgents>;
  const previews = { errors: () => [] } as unknown as Previews;
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

  it("interrupts without sending the queue", async () => {
    const thread = await newThread("first");
    const q = sdk.queries[0]!;
    await agents.send(open, thread.id, turn("later"), "queue");
    await agents.interrupt(open, thread.id);
    expect(q.interrupt).toHaveBeenCalled();
    expect((await meta(thread.id)).running).toBe(false);
    await new Promise((r) => setTimeout(r, 20));
    expect(q.sent).toHaveLength(1);
    expect((await meta(thread.id)).queued).toHaveLength(1);
    expect((await open.history(thread.id)).map((e) => e.type)).toEqual(["user", "result"]);
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
      selection: [{ frameId: "f1", loc: "src/Cart.tsx:4:2", index: 1 }],
    });
    const thread = await startThread(open, { canvasId: canvas.id }, t);
    await agents.send(open, thread.id, t, "steer");
    const q = sdk.queries[0]!;
    await vi.waitFor(() => expect(q.sent).toHaveLength(1));
    const text = textOf(q.sent[0]!);
    expect(text).toContain(path.join(root, ".finite/attachments/shot.png"));
    expect(text).toContain('"Cart" (frame f1): element src/Cart.tsx:4:2, instance 1');
    const content = q.sent[0]!.message.content as { type: string }[];
    expect(content.map((b) => b.type)).toEqual(["text", "image"]);
  });

  async function connectTools(q: Fake) {
    const server = (q.options.mcpServers as Record<string, McpSdkServerConfigWithInstance>).finite!;
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.instance.connect(a);
    const client = new Client({ name: "test", version: "1" });
    await client.connect(b);
    return async (name: string, args: object) => {
      const res = (await client.callTool({ name, arguments: args as Record<string, unknown> })) as {
        isError?: boolean;
        content: { type: string; text?: string }[];
      };
      const text = res.content[0]?.text ?? "";
      if (res.isError) throw new Error(text);
      return text.startsWith("{") || text.startsWith("[") ? JSON.parse(text) : text;
    };
  }

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

    await call("comment", { frameId: placed[0].id, loc: "src/A.tsx:1:1", text: "Look here" });
    const comments = (await open.canvases()).find((x) => x.id === canvas.id)!.comments;
    expect(comments[0]).toMatchObject({
      anchor: { frameId: placed[0].id, loc: "src/A.tsx:1:1" },
      author: { kind: "agent", id: thread.id },
      text: "Look here",
    });

    const read = await call("read_canvas", {});
    expect(read.frames).toHaveLength(2);
    expect(read.comments).toHaveLength(1);
    expect(await call("frame_errors", { frameId: placed[0].id })).toBe("No errors.");
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
