import type { Canvas } from "@finite/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { Camera } from "@/design/camera";
import { finite } from "@/client/finite";
import { CanvasEditor, type TextEdit } from "./editor";
import { keyOf, selectionStore } from "./selection";
import { draw } from "./tools/draw";
import type { Gesture } from "./tools/host";
import { penDraft } from "./tools/vectorState";

vi.mock("./tools/draw", () => ({ draw: vi.fn(async () => null) }));
vi.mock("@/client/finite", () => ({
  finite: { request: vi.fn(async () => ({ remap: {}, created: {} })) },
}));

const canvas = { id: "c1", frames: [], texts: [], comments: [] } as unknown as Canvas;

/** A real editor on a stand-in viewport, driven by the pointer events it listens for. */
function editorOnViewport(designId = "d1") {
  const viewport = new EventTarget() as EventTarget & Record<string, unknown>;
  Object.assign(viewport, {
    setPointerCapture: () => {},
    hasPointerCapture: () => true,
    releasePointerCapture: () => {},
    contains: () => true,
  });
  const camera = {
    view: { zoom: 1 },
    toWorld: (x: number, y: number) => ({ x, y }),
  } as unknown as Camera;
  const editor = new CanvasEditor(designId, canvas, "design", viewport as never, camera);
  const makeEvent = (type: string, clientX: number, clientY: number, pointerId: number) => {
    const event = new Event(type) as Event & Record<string, unknown>;
    Object.assign(event, {
      button: 0,
      pointerId,
      clientX,
      clientY,
      shiftKey: false,
      metaKey: false,
      ctrlKey: false,
      altKey: false,
    });
    return event;
  };
  const pointer = (type: string, clientX: number, clientY: number, pointerId = 1) => {
    viewport.dispatchEvent(makeEvent(type, clientX, clientY, pointerId));
  };
  /** Starts a press the way an overlay handle does: `begin` is whatever the test hands it. */
  const pressWith = (begin: () => Promise<Gesture | null>, pointerId = 1) =>
    editor.press(makeEvent("pointerdown", 10, 10, pointerId) as unknown as PointerEvent, {
      begin,
      click: () => {},
    });
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { editor, pointer, pressWith, flush };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const gestureSpy = () => ({ move: vi.fn(), end: vi.fn() });

function stubPage() {
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("document", { activeElement: null });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.stubGlobal("Element", class {});
  vi.stubGlobal("HTMLElement", class {});
}

describe("changing tool during a drag", () => {
  beforeEach(() => {
    vi.stubGlobal("window", new EventTarget());
    vi.stubGlobal("document", { activeElement: null });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    vi.stubGlobal("Element", class {});
    vi.stubGlobal("HTMLElement", class {});
    vi.mocked(draw).mockClear();
  });
  afterEach(() => vi.unstubAllGlobals());

  async function startRectangle() {
    const t = editorOnViewport();
    t.editor.setTool("rectangle");
    t.pointer("pointerdown", 10, 10);
    t.pointer("pointermove", 80, 60);
    await t.flush();
    expect(t.editor.state.ghost).not.toBeNull();
    return t;
  }

  it("cancels the press: the ghost stays gone and releasing draws nothing", async () => {
    const { editor, pointer, flush } = await startRectangle();
    editor.setTool("ellipse");
    expect(editor.state.tool).toBe("ellipse");
    expect(editor.state.ghost).toBeNull();
    pointer("pointermove", 120, 90);
    await flush();
    expect(editor.state.ghost).toBeNull();
    pointer("pointerup", 120, 90);
    await flush();
    expect(draw).not.toHaveBeenCalled();
    expect(editor.state.tool).toBe("ellipse");
    expect(editor.state.dragging).toBe(false);
    editor.dispose();
  });

  it("keeps the press when the same tool is set again, as a held key does", async () => {
    const { editor, pointer, flush } = await startRectangle();
    editor.setTool("rectangle");
    pointer("pointermove", 120, 90);
    await flush();
    pointer("pointerup", 120, 90);
    await flush();
    expect(draw).toHaveBeenCalledTimes(1);
    editor.dispose();
  });

  it("cancels on Esc the same way", async () => {
    const { editor, pointer, flush } = await startRectangle();
    editor.escape();
    expect(editor.state.ghost).toBeNull();
    pointer("pointerup", 120, 90);
    await flush();
    expect(draw).not.toHaveBeenCalled();
    editor.dispose();
  });
});

describe("presses that overlap", () => {
  beforeEach(() => {
    stubPage();
    vi.mocked(draw).mockClear();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("doesn't start dragging when the press was cancelled before its gesture began", async () => {
    const { editor, pointer, pressWith, flush } = editorOnViewport();
    const begin = deferred<Gesture | null>();
    const gesture = gestureSpy();
    pressWith(() => begin.promise);
    pointer("pointermove", 80, 60);
    editor.escape();
    begin.resolve(gesture);
    await flush();
    expect(editor.state.dragging).toBe(false);
    expect(gesture.end).toHaveBeenCalledWith(false);
    editor.dispose();
  });

  it("leaves a newer press alone when the shape before it lands", async () => {
    const { editor, pointer, flush } = editorOnViewport();
    const landing = deferred<null>();
    vi.mocked(draw).mockImplementationOnce(() => landing.promise);
    editor.setTool("rectangle");
    pointer("pointerdown", 10, 10);
    pointer("pointerup", 10, 10);
    await flush();
    expect(draw).toHaveBeenCalledTimes(1);
    pointer("pointerdown", 200, 200);
    landing.resolve(null);
    await flush();
    expect(editor.pressing).toBe(true);
    expect(editor.state.tool).toBe("rectangle");
    pointer("pointerup", 200, 200);
    await flush();
    expect(draw).toHaveBeenCalledTimes(2);
    expect(editor.state.tool).toBe("select");
    editor.dispose();
  });

  it("ignores a second pointer going down, so the first press's end still runs", async () => {
    const { editor, pointer, pressWith, flush } = editorOnViewport();
    const gesture = gestureSpy();
    pressWith(async () => gesture);
    pointer("pointermove", 80, 60);
    await flush();
    pointer("pointerdown", 300, 300, 2);
    pointer("pointerup", 80, 60);
    await flush();
    expect(gesture.end).toHaveBeenCalledTimes(1);
    expect(gesture.end).toHaveBeenCalledWith(true);
    expect(editor.pressing).toBe(false);
    editor.dispose();
  });

  it("ignores a second pointer on an overlay handle the same way", async () => {
    const { editor, pointer, pressWith, flush } = editorOnViewport();
    const gesture = gestureSpy();
    const second = vi.fn(async () => gestureSpy());
    pressWith(async () => gesture);
    pointer("pointermove", 80, 60);
    await flush();
    pressWith(second, 2);
    pointer("pointermove", 300, 300, 2);
    pointer("pointerup", 80, 60);
    await flush();
    expect(second).not.toHaveBeenCalled();
    expect(gesture.end).toHaveBeenCalledWith(true);
    editor.dispose();
  });

  it("ends a press whose release never arrived when its pointer goes down again", async () => {
    const { editor, pointer, pressWith, flush } = editorOnViewport();
    const gesture = gestureSpy();
    pressWith(async () => gesture);
    pointer("pointermove", 80, 60);
    await flush();
    pointer("pointerdown", 300, 300);
    await flush();
    expect(gesture.end).toHaveBeenCalledWith(false);
    expect(editor.pressing).toBe(true);
    editor.dispose();
  });
});

describe("the pen's draft on the canvas", () => {
  beforeEach(stubPage);
  afterEach(() => {
    penDraft.set(null);
    vi.unstubAllGlobals();
  });

  it("survives its own key mid-draft", () => {
    const { editor, pointer } = editorOnViewport();
    editor.setTool("pen");
    pointer("pointerdown", 10, 10);
    pointer("pointerup", 10, 10);
    const before = penDraft.get();
    expect(before?.anchors).toHaveLength(1);
    editor.setTool("pen");
    expect(penDraft.get()).toBe(before);
    editor.dispose();
  });
});

describe("one thing selected at a time", () => {
  beforeEach(stubPage);
  afterEach(() => {
    selectionStore.set([]);
    vi.unstubAllGlobals();
  });

  it("lets go of a text label when a layer is picked", () => {
    const { editor } = editorOnViewport();
    editor.selectText("t1");
    selectionStore.set([{ frameId: "f1" }]);
    expect(editor.state.selectedText).toBeNull();
    editor.dispose();
  });

  it("closes the open comment when a new one is placed on the empty canvas", async () => {
    const { editor, pointer, flush } = editorOnViewport();
    editor.openComment("c1");
    editor.setTool("comment");
    pointer("pointerdown", 10, 10);
    pointer("pointerup", 10, 10);
    await flush();
    expect(editor.state.commentDraft).not.toBeNull();
    expect(editor.state.openComment).toBeNull();
    editor.dispose();
  });
});

describe("typed text when the file changes under it", () => {
  const LOC = "src/a.tsx:3:4";
  const words = (text: string) => [{ t: "text" as const, text, marks: [] }];
  const edit: TextEdit = {
    rect: { x: 0, y: 0, width: 100, height: 20 },
    font: {},
    content: words("Before"),
    keeps: [],
    keepStyles: {},
    plain: false,
    target: {
      kind: "element",
      frameId: "f1",
      loc: LOC,
      tag: "p",
      rev: "old",
      identity: "the paragraph",
      chain: [],
    },
  };
  const stale = Object.assign(new Error("The file changed; try again"), { code: "stale" });

  beforeEach(() => {
    stubPage();
    vi.mocked(finite.request).mockReset();
  });
  afterEach(() => vi.unstubAllGlobals());

  /** Answers `source.inline` from `read`, and refuses `source.edit` the first `refusals` times. */
  function serverWith(read: () => unknown, refusals: number) {
    vi.mocked(finite.request).mockImplementation((async (name: string) => {
      if (name === "source.inline") return read();
      if (refusals-- > 0) throw stale;
      return { remap: {}, created: {} };
    }) as never);
    return () =>
      vi
        .mocked(finite.request)
        .mock.calls.filter(([name]) => name === "source.edit")
        .map(([, params]) => (params as { edits: { revs: unknown; content: unknown }[] }).edits[0]);
  }

  it("writes the words over the new rev when only the rest of the file changed", async () => {
    const edits = serverWith(
      () => ({ rev: "new", content: words("Before"), keeps: [], identity: "the paragraph" }),
      1,
    );
    const { editor } = editorOnViewport();
    editor.update({ editingText: edit });
    await editor.finishText(words("After"));
    expect(edits().map((e) => e.revs)).toEqual([{ "src/a.tsx": "old" }, { "src/a.tsx": "new" }]);
    expect(edits()[1]?.content).toEqual(words("After"));
    expect(editor.state.editingText).toBeNull();
    expect(editor.state.notice).toBeNull();
    editor.dispose();
  });

  it("puts the words back in the box when the text itself changed", async () => {
    const edits = serverWith(
      () => ({ rev: "new", content: words("Agent's"), keeps: [], identity: "the paragraph" }),
      1,
    );
    const { editor } = editorOnViewport();
    editor.update({ editingText: edit });
    await editor.finishText(words("After"));
    expect(editor.state.editingText?.content).toEqual(words("After"));
    expect(editor.state.notice).not.toBeNull();
    expect(edits()).toHaveLength(1);
    // Pressing Enter on the untouched box is the decision to write them over the new text.
    await editor.finishText(words("After"));
    expect(edits()[1]?.revs).toEqual({ "src/a.tsx": "new" });
    expect(editor.state.editingText).toBeNull();
    editor.dispose();
  });

  it("keeps the words without writing when the text's expressions changed", async () => {
    const keep = (label: string, id = 0) => ({ id, kind: "expression", label });
    const hello = [...words("Greetings "), { t: "atom" as const, id: 0 }];
    const edits = serverWith(
      () => ({
        rev: "new",
        content: [...words("Hello "), { t: "atom", id: 0 }, { t: "atom", id: 1 }],
        keeps: [keep("prefix"), keep("name", 1)],
        identity: "the paragraph",
      }),
      1,
    );
    const { editor } = editorOnViewport();
    editor.update({
      editingText: {
        ...edit,
        content: [...words("Hello "), { t: "atom", id: 0 }],
        keeps: [keep("name")],
      },
    });
    await editor.finishText(hello);
    expect(edits()).toHaveLength(1);
    expect(editor.state.editingText).toBeNull();
    expect(editor.state.notice?.text).toContain("Greetings");
    editor.dispose();
  });

  it("doesn't drop an expression written since, when the words deleted the old one", async () => {
    const keep = (label: string) => ({ id: 0, kind: "expression", label });
    const atom = [...words("Hello "), { t: "atom" as const, id: 0 }];
    const edits = serverWith(
      () => ({ rev: "new", content: atom, keeps: [keep("balance")], identity: "the paragraph" }),
      1,
    );
    const { editor } = editorOnViewport();
    editor.update({ editingText: { ...edit, content: atom, keeps: [keep("name")] } });
    await editor.finishText(words("Hello"));
    expect(edits()).toHaveLength(1);
    expect(editor.state.notice?.text).toContain("Hello");
    editor.dispose();
  });

  it("keeps the words without writing when another element took the same place", async () => {
    const edits = serverWith(
      () => ({ rev: "new", content: words("Agent's"), keeps: [], identity: "another paragraph" }),
      1,
    );
    const { editor } = editorOnViewport();
    editor.update({ editingText: edit });
    await editor.finishText(words("After"));
    expect(edits()).toHaveLength(1);
    expect(editor.state.editingText).toBeNull();
    expect(editor.state.notice?.text).toContain("After");
    editor.dispose();
  });

  it("doesn't write over a different element whose text happens to match", async () => {
    const edits = serverWith(
      () => ({ rev: "new", content: words("Before"), keeps: [], identity: "another paragraph" }),
      1,
    );
    const { editor } = editorOnViewport();
    editor.update({ editingText: edit });
    await editor.finishText(words("After"));
    expect(edits()).toHaveLength(1);
    expect(editor.state.notice?.text).toContain("After");
    editor.dispose();
  });

  it("puts the words back when the element can't be read any more", async () => {
    serverWith(() => Promise.reject(stale), 1);
    const { editor } = editorOnViewport();
    editor.update({ editingText: edit });
    await editor.finishText(words("After"));
    expect(editor.state.editingText?.content).toEqual(words("After"));
    editor.dispose();
  });

  it("shows the words when another box took the screen meanwhile", async () => {
    const landing = deferred<never>();
    vi.mocked(finite.request).mockImplementation((async (name: string) => {
      if (name === "source.inline")
        return { rev: "new", content: words("Agent's"), keeps: [], identity: "the paragraph" };
      await landing.promise.catch(() => {});
      throw stale;
    }) as never);
    const { editor, flush } = editorOnViewport();
    editor.update({ editingText: edit });
    const finished = editor.finishText(words("After"));
    const other = { ...edit, content: words("Other") };
    editor.update({ editingText: other });
    landing.resolve(undefined as never);
    await finished;
    await flush();
    expect(editor.state.editingText).toBe(other);
    expect(editor.state.notice?.text).toContain("After");
    editor.dispose();
  });

  it("still only says why for a refusal that isn't about the file changing", async () => {
    vi.mocked(finite.request).mockRejectedValue(new Error("nope"));
    const { editor } = editorOnViewport();
    editor.update({ editingText: edit });
    await editor.finishText(words("After"));
    expect(editor.state.editingText).toBeNull();
    expect(editor.state.notice?.text).toBe("nope");
    editor.dispose();
  });
});

describe("the inspector's style edits", () => {
  const FILE = "src/a.tsx";
  const svgWithPath = { frameId: "f", loc: `${FILE}:1:1`, index: 0 };
  const svgWithRect = { frameId: "f", loc: `${FILE}:5:1`, index: 0 };
  const pathLoc = `${FILE}:2:3`;

  beforeEach(() => {
    vi.stubGlobal("window", new EventTarget());
    vi.stubGlobal("document", { activeElement: null });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    vi.mocked(finite.request).mockClear();
  });
  afterEach(() => {
    selectionStore.set([]);
    vi.unstubAllGlobals();
  });

  function selectTwoSvgs() {
    const { editor } = editorOnViewport();
    selectionStore.set([svgWithPath, svgWithRect]);
    for (const item of [svgWithPath, svgWithRect]) {
      editor.facts.set(keyOf(item), { rev: "r1", tag: "svg", path: [] });
    }
    return editor;
  }

  const sent = () => vi.mocked(finite.request).mock.calls[0]?.[1] as { edits: unknown[] };

  it("gives each target its own tag, when a path stands in for one svg and not the other", async () => {
    const editor = selectTwoSvgs();
    await editor.styleEdits(
      [{ locs: [pathLoc, svgWithRect.loc], styles: { fill: "#123456" } }],
      [{ of: svgWithPath, loc: pathLoc, rev: "r1", tag: "path" }],
    );
    expect(sent().edits).toEqual([
      {
        kind: "style",
        locs: [svgWithRect.loc],
        tag: "svg",
        styles: { fill: "#123456" },
        revs: { [FILE]: "r1" },
      },
      {
        kind: "style",
        locs: [pathLoc],
        tag: "path",
        styles: { fill: "#123456" },
        revs: { [FILE]: "r1" },
      },
    ]);
    editor.dispose();
  });

  it("keeps targets with one tag in one edit", async () => {
    const editor = selectTwoSvgs();
    await editor.styleEdits([
      { locs: [svgWithPath.loc, svgWithRect.loc], styles: { stroke: "none" } },
    ]);
    expect(sent().edits).toEqual([
      {
        kind: "style",
        locs: [svgWithPath.loc, svgWithRect.loc],
        tag: "svg",
        styles: { stroke: "none" },
        revs: { [FILE]: "r1" },
      },
    ]);
    editor.dispose();
  });
});

describe("a refused edit on a production frame in a prototype", () => {
  const FILE = "src/routes/Home.tsx";
  const proto = {
    ...canvas,
    kind: "prototype",
    frames: [{ id: "f1", source: { kind: "route", path: "/" } }],
  } as unknown as Canvas;
  const edits = [
    { kind: "insert", loc: `${FILE}:3:2`, tag: "main", place: "end", node: {}, revs: {} },
  ] as never;
  const refusal = Object.assign(new Error(`${FILE} is production code.`), {
    code: "outside-prototype",
  });
  const request = vi.mocked(finite.request);

  function prototypeEditor(doc: Canvas = proto) {
    const camera = {
      view: { zoom: 1 },
      visibleWorld: () => ({ x: 0, y: 0, width: 800, height: 600 }),
    } as unknown as Camera;
    const viewport = new EventTarget() as EventTarget & Record<string, unknown>;
    Object.assign(viewport, { contains: () => true });
    const editor = new CanvasEditor("d1", doc, "prototype", viewport as never, camera);
    editor.routeFile = () => FILE;
    return editor;
  }

  beforeEach(() => {
    vi.stubGlobal("window", new EventTarget());
    vi.stubGlobal("document", { activeElement: null });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    request.mockReset();
    request.mockRejectedValueOnce(refusal);
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("offers to copy the frame's file, and keeps the offer until it's used", async () => {
    const editor = prototypeEditor();
    await editor.edit(edits);
    expect(editor.state.notice?.action?.label).toBe("Copy Home.tsx into this prototype");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(editor.state.notice?.action).toBeDefined();
    editor.dispose();
  });

  it("doesn't offer a copy of a route with params, and says to ask the agent", async () => {
    const withParams = {
      ...proto,
      frames: [{ id: "f1", source: { kind: "route", path: "/users/:id", params: { id: "42" } } }],
    } as unknown as Canvas;
    const editor = prototypeEditor(withParams);
    await editor.edit(edits);
    expect(editor.state.notice?.action).toBeUndefined();
    expect(editor.state.notice?.text).toContain(
      "Ask the agent to bring that page into the prototype",
    );
    editor.dispose();
  });

  it("copies the file and points the frame at the copy", async () => {
    const editor = prototypeEditor();
    await editor.edit(edits);
    request.mockImplementation(async (type: string) =>
      type === "source.detach"
        ? ({ file: ".finite/boards/c1/Home.tsx" } as never)
        : (proto as never),
    );
    await editor.state.notice!.action!.run();
    expect(request).toHaveBeenCalledWith("source.detach", {
      designId: "d1",
      canvasId: "c1",
      file: FILE,
    });
    expect(request).toHaveBeenCalledWith("canvas.patch", {
      designId: "d1",
      canvasId: "c1",
      patch: {
        op: "setFrameSources",
        frames: [{ id: "f1", source: { kind: "file", file: ".finite/boards/c1/Home.tsx" } }],
      },
    });
    expect(editor.state.notice).toBeNull();
    editor.dispose();
  });
});

describe("undo and redo against the server", () => {
  let design = 0;
  const request = vi.mocked(finite.request);
  const sent = () => request.mock.calls.map(([type]) => type as string);
  /** An answer the test gives by hand, for a request that has to wait. */
  function held() {
    let answer!: (value: never) => void;
    let refuse!: (error: unknown) => void;
    const promise = new Promise<never>((resolve, reject) => {
      answer = resolve;
      refuse = reject;
    });
    return { promise, answer, refuse };
  }
  const edit = (editor: CanvasEditor) => editor.edit([{ kind: "text" } as never]);
  const refusal = Object.assign(new Error("It changed since."), { code: "stale" });

  beforeEach(() => {
    vi.stubGlobal("window", new EventTarget());
    vi.stubGlobal("document", { activeElement: null });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    request.mockReset();
    request.mockImplementation(async () => ({ remap: {}, created: {} }) as never);
    design++;
  });
  afterEach(() => vi.unstubAllGlobals());

  it("forgets a refused canvas undo, so redo doesn't offer it", async () => {
    const { editor, flush } = editorOnViewport(`d-refused-${design}`);
    request.mockImplementationOnce(async () => canvas as never);
    await editor.patch({ op: "moveFrames", frames: [{ id: "a", x: 50, y: 0 }] });
    request.mockRejectedValueOnce(refusal);
    await editor.undo("undo");
    await flush();
    expect(editor.state.notice?.text).toBe("It changed since.");
    request.mockClear();
    await editor.undo("redo");
    expect(sent()).toEqual(["source.redo"]);
    editor.dispose();
  });

  /** An edit then a canvas move, with the move already taken back: the source undo is next. */
  async function sourceUndoIsNext(id: string) {
    const t = editorOnViewport(id);
    await edit(t.editor);
    request.mockImplementationOnce(async () => canvas as never);
    await t.editor.patch({ op: "moveFrames", frames: [{ id: "a", x: 50, y: 0 }] });
    request.mockImplementationOnce(async () => canvas as never);
    await t.editor.undo("undo");
    return t;
  }

  it("forgets a refused source undo the same way", async () => {
    const { editor, flush } = await sourceUndoIsNext(`d-refused-src-${design}`);
    request.mockRejectedValueOnce(refusal);
    await editor.undo("undo");
    await flush();
    request.mockClear();
    request.mockImplementationOnce(async () => canvas as never);
    await editor.undo("redo");
    expect(sent()).toEqual(["canvas.redo"]);
    editor.dispose();
  });

  it("keeps a step whose request never reached an answer", async () => {
    const { editor, flush } = await sourceUndoIsNext(`d-lost-${design}`);
    request.mockRejectedValueOnce(new Error("Lost the connection to Finite."));
    await editor.undo("undo");
    await flush();
    request.mockClear();
    request.mockImplementationOnce(async () => null as never);
    await editor.undo("redo");
    expect(sent()).toEqual(["source.redo"]);
    editor.dispose();
  });

  it("waits for the reply to an edit before ⌘Z picks what to take back", async () => {
    const { editor, flush } = editorOnViewport(`d-race-${design}`);
    request.mockImplementationOnce(async () => canvas as never);
    await editor.patch({ op: "moveFrames", frames: [{ id: "a", x: 50, y: 0 }] });
    const saving = held();
    request.mockImplementationOnce(() => saving.promise);
    const pending = edit(editor);
    await flush();
    const press = editor.undo("undo");
    await flush();
    expect(sent()).toEqual(["canvas.patch", "source.edit"]);
    saving.answer({ remap: {}, created: {} } as never);
    await pending;
    await press;
    // The edit is what ⌘Z takes, not the older canvas move it would have fallen back on.
    expect(sent()).toEqual(["canvas.patch", "source.edit", "source.undo"]);
    editor.dispose();
  });

  it("holds a new edit until an undo in flight has finished", async () => {
    const { editor, flush } = editorOnViewport(`d-order-${design}`);
    await edit(editor);
    const undoing = held();
    request.mockImplementationOnce(() => undoing.promise);
    const press = editor.undo("undo");
    await flush();
    const next = edit(editor);
    await flush();
    expect(sent()).toEqual(["source.edit", "source.undo"]);
    undoing.answer(null as never);
    await press;
    await next;
    expect(sent()).toEqual(["source.edit", "source.undo", "source.edit"]);
    editor.dispose();
  });

  it("carries on with the next request after one fails", async () => {
    const { editor, flush } = editorOnViewport(`d-fails-${design}`);
    const failing = held();
    request.mockImplementationOnce(() => failing.promise);
    const first = edit(editor);
    await flush();
    const second = edit(editor);
    failing.refuse(refusal);
    await first;
    await second;
    expect(sent()).toEqual(["source.edit", "source.edit"]);
    await flush();
    editor.dispose();
  });
});
