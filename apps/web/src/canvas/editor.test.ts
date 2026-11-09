import type { Canvas } from "@finite/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { Camera } from "@/design/camera";
import { finite } from "@/client/finite";
import { CanvasEditor } from "./editor";
import { keyOf, selectionStore } from "./selection";
import { draw } from "./tools/draw";

vi.mock("./tools/draw", () => ({ draw: vi.fn(async () => null) }));
vi.mock("@/client/finite", () => ({
  finite: { request: vi.fn(async () => ({ remap: {}, created: {} })) },
}));

const canvas = { id: "c1", frames: [], texts: [], comments: [] } as unknown as Canvas;

/** A real editor on a stand-in viewport, driven by the pointer events it listens for. */
function editorOnViewport() {
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
  const editor = new CanvasEditor("d1", canvas, "design", viewport as never, camera);
  const pointer = (type: string, clientX: number, clientY: number) => {
    const event = new Event(type) as Event & Record<string, unknown>;
    Object.assign(event, {
      button: 0,
      pointerId: 1,
      clientX,
      clientY,
      shiftKey: false,
      metaKey: false,
      ctrlKey: false,
      altKey: false,
    });
    viewport.dispatchEvent(event);
  };
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { editor, pointer, flush };
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
