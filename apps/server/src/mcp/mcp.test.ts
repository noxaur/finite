import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type {
  Actor,
  Agents,
  Design,
  DesignEntry,
  FrameError,
  PreviewState,
  Previews,
  Store,
} from "@finite/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import WebSocket from "ws";
import type { LoadError, RenderedElement, Screenshots } from "../agent/screenshot.ts";
import { type RunningServer, startServer } from "../app.ts";
import { allowedHosts } from "../guard.ts";
import type { Modules } from "../hub.ts";
import { rev } from "../source/files.ts";
import { createSourceEditor } from "../source/index.ts";
import { openDesign, type OpenedDesign } from "../store/open.ts";

type ToolResult = { content: { type: string; text?: string }[]; isError?: boolean };

const person: Actor = { kind: "person", id: "u1", name: "Per" };
const CARD = `export default function Card() {\n  return <h1 style={{ color: "red" }}>Hi</h1>;\n}\n`;
const LOC_LINE = 2;
const LOC_COL = 9;

let root: string;
let open: OpenedDesign;
let running: RunningServer | undefined;
let clients: Client[] = [];
let preview: PreviewState;
let elements: Screenshots["elements"];
let loadErrors: LoadError[];
let bridgeErrors: FrameError[];
/** The arguments of each headless load. */
let loads: unknown[][];
const idle = vi.fn();
let canvasId: string;
const apply = vi.fn();
let modules: Modules;

async function start(overrides: { idleMs?: number; styling?: Design["styling"] } = {}) {
  const design: Design = {
    id: "d1",
    name: "Shop",
    root,
    origin: "blank",
    router: "none",
    styling: overrides.styling ?? "inline",
    css: [],
    brandDir: "src/assets/brand",
  };
  open = await openDesign(design);
  const entry: DesignEntry = { id: "d1", name: "Shop", root, origin: "blank", updatedAt: 1 };
  const store = {
    designs: async () => [entry],
    open: async () => open,
    on: () => () => {},
    settings: async () => ({ model: "haiku", effort: "low", fast: false }),
  } as unknown as Store;
  const previews = {
    ensure: async () => ({ url: "http://frame" }),
    state: () => preview,
    frameUrl: () => "http://frame/x",
    errors: () => bridgeErrors,
    routes: async () => [],
    on: () => () => {},
    idle,
    stop: async () => {},
    reportError: () => {},
    close: async () => {},
  } as unknown as Previews;
  const source = createSourceEditor();
  const realApply = source.apply.bind(source);
  source.apply = async (...args) => {
    apply(args[1]);
    return realApply(...args);
  };
  modules = {
    store,
    previews,
    source,
    agents: { close: async () => {}, stopDesign: async () => {} } as unknown as Agents,
  };
  const screenshots: Screenshots = {
    capture: async () => new Uint8Array([1, 2, 3]),
    captureWithErrors: async (...args) => {
      loads.push(args);
      return { png: new Uint8Array([1, 2, 3]), errors: loadErrors };
    },
    measure: async () => ({ width: 300, height: 200 }),
    elements: (...args) => elements(...args),
    close: async () => {},
  };
  running = await startServer({
    port: 0,
    host: "127.0.0.1",
    allowedHosts: allowedHosts(undefined),
    modules,
    screenshots,
    ...(overrides.idleMs === undefined ? {} : { mcpIdleMs: overrides.idleMs }),
  });
  canvasId = (await open.createCanvas({ kind: "prototype", name: "Board" }, person)).id;
  return running.url;
}

async function connect(url: string, name = "test-client", headers: Record<string, string> = {}) {
  const client = new Client({ name, version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
      requestInit: { headers },
    }) as Transport,
  );
  clients.push(client);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  return (await client.callTool({ name, arguments: args })) as ToolResult;
}

function value(result: ToolResult) {
  return JSON.parse(result.content[0]!.text!);
}

/** A board file, with a frame showing it, whose element the fake browser reports as `loc`. */
async function boardFrame(code = CARD) {
  const file = `.finite/boards/${canvasId}/Card.tsx`;
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), code);
  const frame = {
    id: "f1",
    name: "Card",
    x: 0,
    y: 0,
    width: 300,
    height: 200,
    source: { kind: "file" as const, file },
  };
  await open.patchCanvas(canvasId, { op: "addFrames", frames: [frame] }, person);
  const element: RenderedElement = {
    tag: "h1",
    loc: `${file}:${LOC_LINE}:${LOC_COL}`,
    rev: rev(code),
    text: "Hi",
    depth: 0,
  };
  return { file, frame, element };
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "finite-mcp-"));
  preview = { status: "ready", url: "http://frame" };
  elements = async (_url, _w, _h, selects) => selects.map(() => []);
  loadErrors = [];
  loads = [];
  bridgeErrors = [];
  idle.mockClear();
  apply.mockClear();
});

afterEach(async () => {
  await Promise.all(clients.map((c) => c.close().catch(() => {})));
  clients = [];
  await running?.close();
  running = undefined;
  open.close();
  await rm(root, { recursive: true, force: true });
});

describe("/mcp sessions", () => {
  it("refuses a call with no session, and a session it doesn't know", async () => {
    const url = await start();
    const post = (headers: Record<string, string>) =>
      fetch(`${url}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...headers,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
    expect((await post({})).status).toBe(400);
    expect((await post({ "mcp-session-id": "nope" })).status).toBe(404);
  });

  it("refuses another website's Origin", async () => {
    const url = await start();
    const res = await fetch(`${url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: "{}",
    });
    expect(res.status).toBe(403);
  });

  it("forgets a session nobody has used", async () => {
    const url = await start({ idleMs: 400 });
    const client = await connect(url);
    const id = (client.transport as StreamableHTTPClientTransport).sessionId!;
    // One request after the sweep: every request counts as use, so polling would keep it alive.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const res = await fetch(`${url}/mcp`, {
      method: "GET",
      headers: { accept: "text/event-stream", "mcp-session-id": id },
    });
    expect(res.status).toBe(404);
  });

  it("serves the six tools with their instructions", async () => {
    const client = await connect(await start());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ["comments", "designs", "edit", "read", "render", "undo"].sort(),
    );
    expect(client.getInstructions()).toContain("six tools");
  });
});

describe("/mcp tools", () => {
  it("takes a design's name and lists the choices when there's no such design", async () => {
    const client = await connect(await start());
    const overview = value(await call(client, "read", { designId: "Shop" }));
    expect(overview).toMatchObject({ id: "d1", styling: "inline" });
    expect(overview.canvases).toHaveLength(1);
    const missing = await call(client, "read", { designId: "Nope" });
    expect(missing.isError).toBe(true);
    expect(missing.content[0]!.text).toContain("Shop (d1)");
  });

  it("fences a write outside the design's own files unless production is set", async () => {
    const client = await connect(await start());
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src/App.tsx"), "old");
    const write = { op: "write", file: path.join(root, "src/App.tsx"), content: "new" };

    const refused = await call(client, "edit", { designId: "d1", ops: [write] });
    expect(refused.isError).toBe(true);
    const { reason } = value(refused).refused;
    expect(reason).toContain("Production code is read-only");
    expect(reason).toContain("pass production: true");
    expect(reason).not.toContain("move_to_prod");
    expect(await readFile(path.join(root, "src/App.tsx"), "utf8")).toBe("old");

    const allowed = await call(client, "edit", {
      designId: "d1",
      production: true,
      ops: [write],
    });
    expect(allowed.isError).toBeUndefined();
    expect(await readFile(path.join(root, "src/App.tsx"), "utf8")).toBe("new");
  });

  it("writes into the current canvas's board, and undo deletes a file it made", async () => {
    const client = await connect(await start());
    const result = value(
      await call(client, "edit", {
        designId: "d1",
        canvasId,
        ops: [{ op: "write", file: "New.tsx", content: CARD }],
      }),
    );
    const file = path.join(root, `.finite/boards/${canvasId}/New.tsx`);
    expect(result.applied[0].file).toBe(`.finite/boards/${canvasId}/New.tsx`);
    expect(existsSync(file)).toBe(true);
    await call(client, "undo", { designId: "d1" });
    expect(existsSync(file)).toBe(false);
    await call(client, "undo", { designId: "d1", redo: true });
    expect(await readFile(file, "utf8")).toBe(CARD);
  });

  it("makes a new prototype with a thread, so the prototype list shows it", async () => {
    const client = await connect(await start());
    const result = value(
      await call(client, "edit", {
        designId: "d1",
        ops: [{ op: "canvas", name: "Checkout" }],
      }),
    );
    const { canvasId: made, boardDir } = result.applied[0];
    expect(boardDir).toBe(`.finite/boards/${made}`);
    const threads = await open.threads();
    expect(threads.find((t) => t.canvasIds.includes(made))).toBeDefined();
  });

  it("applies consecutive element ops as one source.apply from one load of the frame", async () => {
    const client = await connect(await start());
    const { frame, element, file } = await boardFrame();
    elements = vi.fn(async (_url, _w, _h, selects) => selects.map(() => [element]));
    const result = await call(client, "edit", {
      designId: "d1",
      ops: [
        { op: "style", frameId: frame.id, select: "h1", styles: { color: "blue" } },
        { op: "content", frameId: frame.id, select: "h1", text: "Hello" },
      ],
    });
    expect(result.isError).toBeUndefined();
    expect(elements).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply.mock.calls[0]![0]).toMatchObject([
      { kind: "style", tag: "h1", locs: [element.loc], revs: { [file]: element.rev } },
      { kind: "text", tag: "h1", text: "Hello" },
    ]);
    const code = await readFile(path.join(root, file), "utf8");
    expect(code).toContain("blue");
    expect(code).toContain("Hello");

    await call(client, "undo", { designId: "d1" });
    expect(await readFile(path.join(root, file), "utf8")).toBe(CARD);
  });

  it("refuses a page frame's element op that would change a production CSS module", async () => {
    const client = await connect(await start({ styling: "css-modules" }));
    const css = ".title { color: red; }\n";
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src/Card.module.css"), css);
    const code =
      'import s from "../src/Card.module.css";\nexport default function P() {\n  return <h1 className={s.title}>Hi</h1>;\n}\n';
    const file = ".finite/P.tsx";
    await mkdir(path.join(root, ".finite"), { recursive: true });
    await writeFile(path.join(root, file), code);
    const page = await open.createCanvas({ kind: "page", name: "Page" }, person);
    const frame = {
      id: "p1",
      name: "P",
      x: 0,
      y: 0,
      width: 300,
      height: 200,
      source: { kind: "file" as const, file },
    };
    await open.patchCanvas(page.id, { op: "addFrames", frames: [frame] }, person);
    const element: RenderedElement = {
      tag: "h1",
      loc: `${file}:3:9`,
      rev: rev(code),
      text: "Hi",
      depth: 0,
    };
    elements = async (_url, _w, _h, selects) => selects.map(() => [element]);
    const result = await call(client, "edit", {
      designId: "d1",
      ops: [{ op: "style", frameId: frame.id, select: "h1", styles: { color: "blue" } }],
    });
    expect(result.isError).toBe(true);
    expect(value(result).refused.reason).toContain("production code");
    expect(await readFile(path.join(root, "src/Card.module.css"), "utf8")).toBe(css);
  });

  it("refuses to redo making a file someone else has since made", async () => {
    const url = await start();
    const [a, b] = [await connect(url, "a"), await connect(url, "b")];
    const write = (client: Client, content: string) =>
      call(client, "edit", {
        designId: "d1",
        canvasId,
        ops: [{ op: "write", file: "Same.tsx", content }],
      });
    await write(a, "A content\n");
    await call(a, "undo", { designId: "d1" });
    await write(b, "B content\n");
    const redo = await call(a, "undo", { designId: "d1", redo: true });
    expect(redo.isError).toBe(true);
    const file = path.join(root, `.finite/boards/${canvasId}/Same.tsx`);
    expect(await readFile(file, "utf8")).toBe("B content\n");
  });

  it("says when one JSX element renders several instances", async () => {
    const client = await connect(await start());
    const { frame, element } = await boardFrame();
    elements = async (_url, _w, _h, selects) => selects.map(() => [element, element]);
    const { applied } = value(
      await call(client, "edit", {
        designId: "d1",
        ops: [{ op: "style", frameId: frame.id, select: "h1", styles: { color: "blue" } }],
      }),
    );
    expect(applied[0].note).toContain("every instance");
  });

  it("refuses an element op on production without production: true", async () => {
    const client = await connect(await start());
    const { frame, element } = await boardFrame();
    elements = async (_url, _w, _h, selects) =>
      selects.map(() => [{ ...element, loc: "src/App.tsx:2:9" }]);
    const result = await call(client, "edit", {
      designId: "d1",
      ops: [{ op: "remove", frameId: frame.id, select: "h1" }],
    });
    expect(result.isError).toBe(true);
    expect(value(result).refused.reason).toContain("production code");
    expect(apply).not.toHaveBeenCalled();
  });

  it("refuses a selector that matches nothing, or nothing with a loc", async () => {
    const client = await connect(await start());
    const { frame, element } = await boardFrame();
    const edit = () =>
      call(client, "edit", {
        designId: "d1",
        ops: [{ op: "remove", frameId: frame.id, select: ".gone" }],
      });
    expect(value(await edit()).refused.reason).toContain("matches nothing");
    elements = async (_url, _w, _h, selects) =>
      selects.map(() => [{ tag: element.tag, text: "", depth: 0 }]);
    expect(value(await edit()).refused.reason).toContain("no loc");
  });

  it("stops at the first failure and reports what was applied", async () => {
    const client = await connect(await start());
    const result = await call(client, "edit", {
      designId: "d1",
      canvasId,
      ops: [
        { op: "text", title: "Note", body: "Kept" },
        { op: "remove_frames", frameIds: ["ghost"] },
        { op: "text", title: "Never", body: "Runs" },
      ],
    });
    expect(result.isError).toBe(true);
    const body = value(result);
    expect(body.applied).toHaveLength(1);
    expect(body.refused).toMatchObject({ index: 1, op: "remove_frames" });
    expect(body.refused.reason).toContain("Call read.");
    const canvas = (await open.canvases()).find((c) => c.id === canvasId)!;
    expect(canvas.texts.map((t) => t.title)).toEqual(["Note"]);
  });

  it("refuses to load a frame when the preview is down, with its log", async () => {
    const client = await connect(await start());
    const { frame } = await boardFrame();
    preview = { status: "error", log: "vite exploded" };
    const result = await call(client, "render", { designId: "d1", frameIds: [frame.id] });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("vite exploded");
  });

  it("renders a frame as a PNG followed by its errors", async () => {
    const client = await connect(await start());
    const { frame } = await boardFrame();
    const result = await call(client, "render", { designId: "d1", canvasId });
    expect(result.content.map((c) => c.type)).toEqual(["text", "image", "text"]);
    expect(result.content[0]!.text).toContain(frame.id);
    expect(result.content[2]!.text).toBe("No errors.");
  });

  it("reports a headless load's errors, merged with the bridge's and without repeats", async () => {
    const client = await connect(await start());
    const { frame } = await boardFrame();
    loadErrors = [{ kind: "error", message: "boom" }];
    bridgeErrors = [
      { frameId: frame.id, kind: "error", message: "boom", at: 1 },
      { frameId: frame.id, kind: "console", message: "from the page", at: 2 },
    ];
    const result = await call(client, "render", { designId: "d1", canvasId });
    expect(JSON.parse(result.content[2]!.text!)).toEqual([
      { kind: "error", message: "boom" },
      { kind: "console", message: "from the page" },
    ]);
  });

  it("lets the preview idle after a frame load, unless a page is subscribed", async () => {
    const url = await start();
    const client = await connect(url);
    await boardFrame();
    await call(client, "render", { designId: "d1", canvasId });
    expect(idle).toHaveBeenCalledTimes(1);
    expect(idle).toHaveBeenCalledWith("d1");

    idle.mockClear();
    const page = new WebSocket(`${url.replace("http", "ws")}/api/ws`, {
      origin: "http://localhost:5310",
    });
    const replies: { rid?: string }[] = [];
    page.on("message", (data) => replies.push(JSON.parse((data as Buffer).toString("utf8"))));
    await new Promise((resolve) => page.once("open", resolve));
    page.send(JSON.stringify({ type: "hello", rid: "1", user: { id: "u1", name: "Per" } }));
    page.send(JSON.stringify({ type: "subscribe", rid: "2", designId: "d1" }));
    await vi.waitFor(() => expect(replies.some((m) => m.rid === "2")).toBe(true));

    await call(client, "render", { designId: "d1", canvasId });
    expect(idle).not.toHaveBeenCalled();
    page.close();
  });

  it("routes undo to the canvas stack with canvasId, and the file stack without", async () => {
    const client = await connect(await start());
    await call(client, "edit", {
      designId: "d1",
      canvasId,
      ops: [
        { op: "text", title: "Note", body: "x" },
        { op: "write", file: "A.tsx", content: CARD },
      ],
    });
    const file = path.join(root, `.finite/boards/${canvasId}/A.tsx`);
    const texts = async () => (await open.canvases()).find((c) => c.id === canvasId)!.texts.length;

    const files = await call(client, "undo", { designId: "d1" });
    expect(files.content[0]!.text).toContain("file change");
    expect(existsSync(file)).toBe(false);
    expect(await texts()).toBe(1);

    const canvas = await call(client, "undo", { designId: "d1", canvasId });
    expect(canvas.content[0]!.text).toContain("canvas");
    expect(await texts()).toBe(0);
  });

  it("keeps each session's undo to its own changes", async () => {
    const url = await start();
    const [a, b] = [await connect(url, "a"), await connect(url, "b")];
    await call(a, "edit", {
      designId: "d1",
      canvasId,
      ops: [{ op: "write", file: "A.tsx", content: CARD }],
    });
    const other = await call(b, "undo", { designId: "d1" });
    expect(other.isError).toBe(true);
    expect(other.content[0]!.text).toContain("Nothing to undo");
  });

  it("adds, replies to, resolves and reopens comments as the client", async () => {
    const client = await connect(await start(), "cursor");
    const { frame } = await boardFrame();
    const { added } = value(
      await call(client, "comments", {
        designId: "d1",
        add: { frameId: frame.id, text: "Look here" },
      }),
    );
    const list = async () => value(await call(client, "comments", { designId: "d1" }));
    expect(await list()).toMatchObject([{ id: added.commentId, author: "cursor", waiting: false }]);

    await call(client, "comments", {
      designId: "d1",
      reply: [{ commentId: added.commentId, text: "Done", resolve: true }],
    });
    expect(await list()).toEqual([]);

    await call(client, "comments", { designId: "d1", reopen: [added.commentId] });
    const [reopened] = await list();
    expect(reopened.messages.map((m: { text: string }) => m.text)).toEqual(["Look here", "Done"]);

    await call(client, "comments", { designId: "d1", resolve: [added.commentId] });
    expect(await list()).toEqual([]);
  });

  it("never asks an agent to answer an annotation, but lists it", async () => {
    const client = await connect(await start(), "cursor");
    const { frame } = await boardFrame();
    await call(client, "comments", {
      designId: "d1",
      add: { frameId: frame.id, text: "Spacing follows the 8pt grid", annotation: true },
    });
    const [note] = value(await call(client, "comments", { designId: "d1" }));
    expect(note).toMatchObject({ kind: "annotation", waiting: false });
    // A person's annotation is a note, not a request.
    await open.updateCanvas(
      canvasId,
      (c) => ({
        ...c,
        comments: [
          ...c.comments,
          {
            id: "n1",
            kind: "annotation",
            anchor: { frameId: frame.id },
            author: person,
            text: "Brand blue only",
            replies: [],
            createdAt: Date.now(),
          },
        ],
      }),
      person,
    );
    const all = value(await call(client, "comments", { designId: "d1" }));
    expect(all.map((c: { waiting: boolean }) => c.waiting)).toEqual([false, false]);
    const waiting = await call(client, "comments", { designId: "d1", wait: 0.05 });
    expect(waiting.content[0]!.text).toContain("wait again");
  });

  it("makes, resizes and removes a section, and canvas undo takes each back", async () => {
    const client = await connect(await start());
    const { frame } = await boardFrame();
    const sections = async () => (await open.canvases()).find((c) => c.id === canvasId)!.sections;

    const made = value(
      await call(client, "edit", {
        designId: "d1",
        canvasId,
        ops: [{ op: "section", name: "Onboarding", frameIds: [frame.id] }],
      }),
    ).applied[0];
    expect(made).toMatchObject({ x: -40, y: -160, width: 380, height: 400 });
    expect(await sections()).toMatchObject([{ id: made.sectionId, name: "Onboarding" }]);

    await call(client, "edit", {
      designId: "d1",
      canvasId,
      ops: [{ op: "section", sectionId: made.sectionId, name: "Sign-up", width: 900 }],
    });
    expect(await sections()).toMatchObject([{ name: "Sign-up", width: 900 }]);
    expect(value(await call(client, "read", { designId: "d1", canvasId })).sections).toMatchObject([
      { id: made.sectionId, name: "Sign-up", width: 900 },
    ]);

    await call(client, "edit", {
      designId: "d1",
      canvasId,
      ops: [{ op: "section", sectionId: made.sectionId, remove: true }],
    });
    expect(await sections()).toEqual([]);
    await call(client, "undo", { designId: "d1", canvasId });
    expect(await sections()).toMatchObject([{ name: "Sign-up" }]);
    await call(client, "undo", { designId: "d1", canvasId });
    await call(client, "undo", { designId: "d1", canvasId });
    expect(await sections()).toEqual([]);

    const bad = await call(client, "edit", {
      designId: "d1",
      canvasId,
      ops: [{ op: "section", name: "No box" }],
    });
    expect(bad.isError).toBe(true);
    expect(bad.content[0]!.text).toContain("frameIds");
  });

  it("renders a region of one frame, cut to the frame's width", async () => {
    const client = await connect(await start());
    const { frame } = await boardFrame();
    const region = { x: 250, y: 10, width: 200, height: 50 };
    const result = await call(client, "render", { designId: "d1", frameIds: [frame.id], region });
    expect(result.content.map((c) => c.type)).toEqual(["text", "image", "text"]);
    expect(loads.at(-1)).toEqual([
      "http://frame/x",
      frame.width,
      frame.height,
      { x: 250, y: 10, width: 50, height: 50 },
    ]);

    const many = await call(client, "render", { designId: "d1", canvasId, region });
    expect(many.isError).toBe(true);
    expect(many.content[0]!.text).toContain("single frame");
    const outside = await call(client, "render", {
      designId: "d1",
      frameIds: [frame.id],
      region: { ...region, x: 400 },
    });
    expect(outside.content[0]!.text).toContain("past the right edge");
  });

  it("wakes a waiting comments call when a person writes", async () => {
    const client = await connect(await start());
    const { frame } = await boardFrame();
    const waiting = call(client, "comments", { designId: "d1", wait: 10 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await open.updateCanvas(
      canvasId,
      (c) => ({
        ...c,
        comments: [
          ...c.comments,
          {
            id: "c1",
            anchor: { frameId: frame.id },
            author: person,
            text: "Make it blue",
            replies: [],
            createdAt: Date.now(),
          },
        ],
      }),
      person,
    );
    const { comments } = value(await waiting);
    expect(comments).toMatchObject([{ id: "c1", waiting: true }]);
  });

  it("says to call again when nobody comments in time", async () => {
    const client = await connect(await start());
    const result = await call(client, "comments", { designId: "d1", wait: 0.05 });
    expect(result.content[0]!.text).toContain("wait again");
  });

  it("pages a long file and says how to get the rest", async () => {
    const client = await connect(await start());
    await writeFile(path.join(root, "big.txt"), "x".repeat(50_000));
    const first = await call(client, "read", { designId: "d1", file: "big.txt" });
    expect(first.content[0]!.text).toContain("Pass offset 40000 for the rest.");
    const rest = await call(client, "read", { designId: "d1", file: "big.txt", offset: 40_000 });
    expect(rest.content[0]!.text).toHaveLength(10_000);
  });
});
