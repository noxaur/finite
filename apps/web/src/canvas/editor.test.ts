import type { Canvas, Measurement } from "@finite/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { Camera } from "@/design/camera";
import type { CanvasEditor as Editor } from "./editor";

const measure = vi.fn<(targets: unknown[]) => Promise<(Measurement | null)[]>>();

vi.mock("@/client/finite", () => ({ finite: {} }));
vi.mock("./bridge", () => ({
  bridgeOf: () => ({ measure, rects: async () => ({}), inspect: async () => null }),
  mountedBridges: () => new Map(),
}));

const { CanvasEditor } = await import("./editor");

const measured = (over: Partial<Measurement> = {}) =>
  ({ tag: "div", name: "div", loc: "a.tsx:1:1", index: 0, count: 1, ...over }) as Measurement;

const canvas = {
  id: "c",
  kind: "design",
  name: "",
  threadIds: [],
  frames: [{ id: "f", name: "", x: 0, y: 0, width: 500, height: 500, source: { kind: "route" } }],
  texts: [],
  comments: [],
  updatedAt: 0,
} as unknown as Canvas;

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("the measure tool", () => {
  let editor: Editor;
  let viewport: EventTarget;
  const key = (k: string) =>
    editor.key({
      key: k,
      code: "",
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
    });

  const move = async (x: number, y: number) => {
    viewport.dispatchEvent(
      Object.assign(new Event("pointermove"), { clientX: x, clientY: y, pointerId: 1 }),
    );
    await settle();
  };
  const click = async (x: number, y: number) => {
    const at = { clientX: x, clientY: y, pointerId: 1, button: 0 };
    viewport.dispatchEvent(Object.assign(new Event("pointerdown"), at));
    viewport.dispatchEvent(Object.assign(new Event("pointerup"), at));
    await settle();
  };

  beforeEach(() => {
    vi.stubGlobal("window", new EventTarget());
    vi.stubGlobal("document", { activeElement: null });
    vi.stubGlobal("Element", class {});
    vi.stubGlobal("HTMLElement", class {});
    vi.stubGlobal("performance", { now: () => 0 });
    vi.stubGlobal("requestAnimationFrame", (fn: () => void) => (fn(), 1));
    vi.stubGlobal("cancelAnimationFrame", () => {});
    measure.mockReset();
    measure.mockResolvedValue([measured()]);
    viewport = Object.assign(new EventTarget(), {
      contains: () => true,
      setPointerCapture() {},
      hasPointerCapture: () => false,
      releasePointerCapture() {},
    });
    const camera = {
      view: { x: 0, y: 0, zoom: 1 },
      toWorld: (x: number, y: number) => ({ x, y }),
    } as unknown as Camera;
    editor = new CanvasEditor("d", canvas, "design", viewport as HTMLElement, camera);
    editor.setTool("measure");
  });

  afterEach(() => {
    editor.dispose();
    vi.unstubAllGlobals();
  });

  it("M enters from anywhere and turns Interact off", () => {
    editor.setTool("select");
    editor.setInteract(true);
    expect(key("m")).toBe(true);
    expect(editor.state.tool).toBe("measure");
    expect(editor.state.interact).toBe(false);
  });

  it("Interact, V and C leave and clear what was measured", async () => {
    for (const leave of [() => editor.setInteract(true), () => key("v"), () => key("c")]) {
      editor.setInteract(false);
      editor.setTool("measure");
      await move(10, 10);
      await click(10, 10);
      expect(editor.state.measure.pin).not.toBeNull();
      leave();
      expect(editor.state.tool).not.toBe("measure");
      expect(editor.state.measure).toEqual({ hover: null, pin: null, up: 0 });
    }
  });

  it("drops a probe that answers after the tool changed", async () => {
    let answer: (found: (Measurement | null)[]) => void = () => {};
    measure.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    const moved = move(10, 10);
    key("v");
    answer([measured()]);
    await moved;
    expect(editor.state.measure.hover).toBeNull();
  });

  it("Esc unpins first, then returns to Select", async () => {
    await move(10, 10);
    await click(10, 10);
    expect(editor.state.measure.pin?.target).toEqual({ loc: "a.tsx:1:1", index: 0 });
    expect(key("Escape")).toBe(true);
    expect(editor.state.measure.pin).toBeNull();
    expect(editor.state.tool).toBe("measure");
    expect(key("Escape")).toBe(true);
    expect(editor.state.tool).toBe("select");
  });

  it("clicking the pin or the empty canvas unpins; clicking another element moves it", async () => {
    await click(10, 10);
    measure.mockResolvedValue([measured({ loc: "b.tsx:1:1" })]);
    await click(20, 20);
    expect(editor.state.measure.pin?.m.loc).toBe("b.tsx:1:1");
    await click(20, 20);
    expect(editor.state.measure.pin).toBeNull();
    await click(20, 20);
    expect(editor.state.measure.pin).not.toBeNull();
    await click(900, 900);
    expect(editor.state.measure.pin).toBeNull();
  });

  it("↑ walks up and stops at the topmost element; ↓ comes back", async () => {
    const leaf = measured();
    const parent = measured({ loc: "a.tsx:0:0" });
    await move(10, 10);
    measure.mockResolvedValue([leaf, parent]);
    expect(key("ArrowUp")).toBe(true);
    await settle();
    expect(editor.state.measure).toMatchObject({ up: 1, hover: { m: parent } });
    key("ArrowUp");
    await settle();
    expect(editor.state.measure.up).toBe(1);
    measure.mockResolvedValue([leaf]);
    key("ArrowDown");
    await settle();
    expect(editor.state.measure).toMatchObject({ up: 0, hover: { m: leaf } });
    expect(key("ArrowDown")).toBe(true);
  });

  it("starts the walk over on a different element", async () => {
    await move(10, 10);
    measure.mockResolvedValue([measured(), measured({ loc: "a.tsx:0:0" })]);
    key("ArrowUp");
    await settle();
    const next = measured({ loc: "z.tsx:5:5" });
    measure.mockResolvedValue([next, measured({ loc: "a.tsx:0:0" })]);
    await move(40, 40);
    expect(editor.state.measure).toMatchObject({ up: 0, hover: { m: next } });
  });

  it("leaves arrow keys alone in the other tools", () => {
    editor.setTool("select");
    expect(key("ArrowUp")).toBe(false);
    expect(key("ArrowDown")).toBe(false);
  });

  it("measures the pin again on a frame update, and lets it go when it's gone", async () => {
    await click(10, 10);
    const moved = measured({ name: "moved" });
    measure.mockResolvedValue([moved]);
    editor.frameChanged();
    await settle();
    expect(editor.state.measure.pin?.m.name).toBe("moved");
    measure.mockResolvedValue([null]);
    editor.frameChanged();
    await settle();
    expect(editor.state.measure.pin).toBeNull();
  });

  it("drops a click still waiting on its frame once Esc has unpinned", async () => {
    await click(10, 10);
    const answers: ((value: (Measurement | null)[]) => void)[] = [];
    measure.mockImplementationOnce(() => new Promise((resolve) => answers.push(resolve)));
    await click(20, 20);
    key("Escape");
    answers[0]!([measured({ loc: "b.tsx:1:1" })]);
    await settle();
    expect(editor.state.measure.pin).toBeNull();
  });

  it("keeps the newest of two overlapping refreshes of the pin", async () => {
    await click(10, 10);
    const answers: ((value: (Measurement | null)[]) => void)[] = [];
    measure.mockImplementation(() => new Promise((resolve) => answers.push(resolve)));
    editor.frameChanged();
    editor.frameChanged();
    await settle();
    answers[0]!([measured({ text: "first" })]);
    await settle();
    answers[1]!([measured({ text: "second" })]);
    await settle();
    expect(editor.state.measure.pin?.m.text).toBe("second");
  });

  it("forgets a pin whose frame is removed", async () => {
    await click(10, 10);
    editor.setCanvas({ ...canvas, frames: [] });
    expect(editor.state.measure.pin).toBeNull();
  });
});
