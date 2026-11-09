import type { Canvas, ThreadMeta } from "@finite/protocol";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { Camera } from "@/design/camera";
import { finite } from "@/client/finite";
import { CanvasEditor } from "@/canvas/editor";
import { CommentLayer } from "./Comments";
import { Composer } from "./Composer";
import { toast } from "./Toast";

// The web app has no DOM to test in, so these run the real components with React's hooks kept in
// the array below. Each test presses what a person presses, on the elements a component returned.
const hooks = vi.hoisted(() => ({
  cells: new Map<unknown, unknown[]>(),
  current: [] as unknown[],
  cursor: 0,
}));

vi.mock("react", async (actual) => ({
  ...(await actual<typeof import("react")>()),
  useState: (initial: unknown) => {
    const cells = hooks.current;
    const i = hooks.cursor++;
    if (!(i in cells)) cells[i] = initial;
    return [
      cells[i],
      (next: unknown) => {
        cells[i] = typeof next === "function" ? next(cells[i]) : next;
      },
    ];
  },
  useRef: (initial: unknown = null) => {
    const cells = hooks.current;
    const i = hooks.cursor++;
    if (!(i in cells)) cells[i] = { current: initial };
    return cells[i];
  },
  useEffect: () => {},
}));
vi.mock("@stylexjs/stylex", () => ({
  create: () => new Proxy({}, { get: () => () => ({}) }),
  props: () => ({}),
}));
vi.mock("@/styles/tokens.stylex", () => ({
  colors: {},
  fonts: {},
  motion: {},
  radii: {},
  shadows: {},
  size: {},
  space: {},
}));
vi.mock("@/styles/raised", () => ({ raised: {} }));
vi.mock("@/client/finite", () => ({
  finite: { request: vi.fn() },
  useClaudeStatus: () => null,
  useSettings: () => ({ model: "sonnet", fast: false, sendMode: "steer" }),
}));
vi.mock("@/canvas", () => ({ useSelection: () => [], selectionStore: { set: vi.fn() } }));
vi.mock("@/canvas/bridge", () => ({ bridgeOf: () => undefined }));
vi.mock("@/canvas/tools/draw", () => ({ draw: vi.fn(async () => null) }));
vi.mock("./Toast", () => ({ toast: vi.fn() }));
vi.mock("./useDismiss", () => ({ useDismiss: () => {} }));

type Handler = (...args: unknown[]) => unknown;
interface Props {
  readonly children?: unknown;
  readonly value?: unknown;
  readonly label?: unknown;
  readonly queued?: unknown;
  readonly "aria-label"?: unknown;
  readonly onClick?: Handler;
  readonly onChange?: Handler;
  readonly onSubmit?: Handler;
}
type El = ReactElement<Props>;

function render<P>(component: (props: P) => unknown, props: P) {
  hooks.current = hooks.cells.get(component) ?? [];
  hooks.cells.set(component, hooks.current);
  hooks.cursor = 0;
  return component(props);
}

function find(node: unknown, match: (el: El) => boolean): El | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = find(child, match);
      if (hit) return hit;
    }
    return undefined;
  }
  if (typeof node !== "object" || node === null || !("props" in node)) return undefined;
  const el = node as El;
  return match(el) ? el : find(el.props.children, match);
}

function must(el: El | undefined): El {
  if (!el) throw new Error("not rendered");
  return el;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const request = vi.mocked(finite.request) as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  hooks.cells.clear();
  request.mockReset();
  vi.mocked(toast).mockReset();
});

describe("typing during a send", () => {
  const onSend = vi.fn<() => Promise<void>>();
  const composer = () =>
    render(Composer, { designId: "d1", thread: null, onSend: onSend as never });
  const box = () => must(find(composer(), (el) => el.type === "textarea"));
  const type = (value: string) => box().props.onChange!({ target: { value } });
  const pressSend = () =>
    must(find(composer(), (el) => el.props["aria-label"] === "Send")).props.onClick!({
      altKey: false,
    });

  beforeEach(() => onSend.mockReset());

  it("keeps text typed after Send was pressed", async () => {
    const answer = deferred<void>();
    onSend.mockReturnValue(answer.promise);
    type("first");
    void pressSend();
    type("something else");
    answer.resolve();
    await flush();
    expect(box().props.value).toBe("something else");
  });

  it("drops the sent part when the text typed during the send continues it", async () => {
    const answer = deferred<void>();
    onSend.mockReturnValue(answer.promise);
    type("first");
    void pressSend();
    type("first and more");
    answer.resolve();
    await flush();
    expect(box().props.value).toBe(" and more");
  });

  it("keeps a file attached during the send and clears the ones sent", async () => {
    const answer = deferred<void>();
    onSend.mockReturnValue(answer.promise);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ path: "/a" }) })),
    );
    const attach = async (name: string) => {
      must(find(composer(), (el) => el.type === "input")).props.onChange!({
        target: { files: [new File(["x"], name)], value: "" },
      });
      await flush();
    };
    const removeButton = (name: string) =>
      find(composer(), (el) => el.props["aria-label"] === `Remove ${name}`);
    await attach("sent.png");
    type("first");
    void pressSend();
    await attach("late.png");
    answer.resolve();
    await flush();
    expect(removeButton("sent.png")).toBeUndefined();
    expect(removeButton("late.png")).toBeDefined();
  });

  it("empties the box when nothing was typed during the send", async () => {
    onSend.mockResolvedValue(undefined);
    type("first");
    await pressSend();
    expect(box().props.value).toBe("");
  });
});

describe("Send now on a queued message", () => {
  const thread = {
    id: "t1",
    model: "sonnet",
    fast: false,
    running: true,
    queued: [{ id: "q1", text: "later", attachments: [] }],
  } as unknown as ThreadMeta;
  const chip = () => {
    const tree = render(Composer, { designId: "d1", thread, onSend: vi.fn() });
    const el = must(find(tree, (e) => e.props.queued !== undefined));
    return render(el.type as (props: Props) => unknown, el.props);
  };
  const pressSendNow = () =>
    must(find(chip(), (e) => e.props.label === "Send now")).props.onClick!();
  const sends = () => request.mock.calls.filter(([type]) => type === "thread.send");

  it("steers the message in once it's off the queue", async () => {
    request.mockResolvedValue(thread);
    await pressSendNow();
    expect(sends()).toHaveLength(1);
    expect(sends()[0]![1]).toMatchObject({ text: "later", mode: "steer" });
  });

  it("doesn't send a message it couldn't take off the queue", async () => {
    request.mockRejectedValue(new Error("That queued message was already sent or removed."));
    await pressSendNow();
    expect(sends()).toEqual([]);
    expect(toast).toHaveBeenCalledWith("That queued message was already sent or removed.");
  });

  it("puts the message back on the queue when the steer fails", async () => {
    request.mockImplementation(async (type: string, params: { mode?: string }) => {
      if (type === "thread.send" && params.mode === "steer") throw new Error("Design removed.");
      return thread;
    });
    await pressSendNow();
    expect(sends().map(([, params]) => (params as { mode: string }).mode)).toEqual([
      "steer",
      "queue",
    ]);
    expect(sends()[1]![1]).toMatchObject({ text: "later", attachments: [] });
    expect(toast).toHaveBeenCalledWith("Design removed.");
  });

  it("sends once when it's pressed twice", async () => {
    request.mockResolvedValueOnce(thread);
    request.mockRejectedValueOnce(new Error("That queued message was already sent or removed."));
    request.mockResolvedValue({ threadId: "t1" });
    await Promise.all([pressSendNow(), pressSendNow()]);
    expect(sends()).toHaveLength(1);
  });
});

describe("placing a comment draft while another posts", () => {
  const draft = (x: number) => ({ anchor: { x, y: 0 }, at: { x, y: 0 } });
  const canvas = { id: "c1", frames: [], texts: [], comments: [] } as unknown as Canvas;

  function setup() {
    vi.stubGlobal("window", new EventTarget());
    const viewport = new EventTarget();
    const camera = { view: { zoom: 1 } } as unknown as Camera;
    const editor = new CanvasEditor("d1", canvas, "design", viewport as never, camera);
    const form = () => {
      const tree = render(CommentLayer, {
        designId: "d1",
        canvasId: "c1",
        comments: [],
        editor,
        state: editor.state,
      });
      const el = must(find(tree, (e) => e.props.onSubmit !== undefined));
      return render(el.type as (props: Props) => unknown, el.props);
    };
    const box = () => must(find(form(), (e) => e.type === "textarea"));
    const type = (value: string) => box().props.onChange!({ target: { value } });
    const post = () =>
      must(find(form(), (e) => e.type === "form")).props.onSubmit!({ preventDefault() {} });
    return { editor, box, type, post };
  }

  it("clears the draft it posted", async () => {
    const { editor, type, post } = setup();
    editor.update({ commentDraft: draft(10) });
    request.mockResolvedValue({});
    type("first");
    post();
    await flush();
    expect(editor.state.commentDraft).toBeNull();
  });

  it("keeps the newer draft and what's typed in it", async () => {
    const { editor, box, type, post } = setup();
    editor.update({ commentDraft: draft(10) });
    const answer = deferred<unknown>();
    request.mockReturnValue(answer.promise);
    type("first");
    post();
    const newer = draft(20);
    editor.update({ commentDraft: newer });
    type("second");
    answer.resolve({});
    await flush();
    expect(editor.state.commentDraft).toBe(newer);
    expect(box().props.value).toBe("second");
  });
});
