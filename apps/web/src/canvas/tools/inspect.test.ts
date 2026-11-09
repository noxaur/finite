import type { Canvas, Measurement, Rect } from "@finite/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { Camera } from "@/design/camera";
import type { CanvasEditor as Editor } from "../editor";

const measure = vi.fn<(targets: unknown[]) => Promise<(Measurement | null)[]>>();
type AreaReply = { elements: Measurement[]; total: number };
const measureArea = vi.fn<(rect: Rect, max: number) => Promise<AreaReply>>();

vi.mock("@/client/finite", () => ({ finite: {} }));
vi.mock("@/design/editing/insertion", () => ({}));
vi.mock("../bridge", () => ({
  bridgeOf: () => ({ measure, measureArea, rects: async () => ({}), inspect: async () => null }),
  mountedBridges: () => new Map(),
}));

const { CanvasEditor } = await import("../editor");

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

describe("the inspect tool", () => {
  let editor: Editor;
  let viewport: EventTarget;
  const key = (k: string) =>
    editor.key(
      { key: k, code: "", metaKey: false, ctrlKey: false, shiftKey: false, altKey: false },
      "page",
    );

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
    measureArea.mockReset();
    measureArea.mockResolvedValue({ elements: [], total: 0 });
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
    editor.setTool("inspect");
  });

  afterEach(() => {
    editor.dispose();
    vi.unstubAllGlobals();
  });

  it("M enters from anywhere and turns Interact off", () => {
    editor.setTool("interact");
    expect(key("m")).toBe(true);
    expect(editor.state.tool).toBe("inspect");
  });

  it("Interact, V and C leave and clear what was measured", async () => {
    for (const leave of [() => key("i"), () => key("v"), () => key("c")]) {
      editor.setTool("inspect");
      await move(10, 10);
      await click(10, 10);
      expect(editor.state.inspect.pin).not.toBeNull();
      leave();
      expect(editor.state.tool).not.toBe("inspect");
      expect(editor.state.inspect).toEqual({ hover: null, pin: null, up: 0, area: null });
    }
  });

  it("drops a probe that answers after the tool changed", async () => {
    let answer: (found: (Measurement | null)[]) => void = () => {};
    measure.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    const moved = move(10, 10);
    key("v");
    answer([measured()]);
    await moved;
    expect(editor.state.inspect.hover).toBeNull();
  });

  it("Esc unpins first, then returns to Select", async () => {
    await move(10, 10);
    await click(10, 10);
    expect(editor.state.inspect.pin?.target).toEqual({ loc: "a.tsx:1:1", index: 0 });
    expect(key("Escape")).toBe(true);
    expect(editor.state.inspect.pin).toBeNull();
    expect(editor.state.tool).toBe("inspect");
    expect(key("Escape")).toBe(true);
    expect(editor.state.tool).toBe("select");
  });

  it("clicking the pin or the empty canvas unpins; clicking another element moves it", async () => {
    await click(10, 10);
    measure.mockResolvedValue([measured({ loc: "b.tsx:1:1" })]);
    await click(20, 20);
    expect(editor.state.inspect.pin?.m.loc).toBe("b.tsx:1:1");
    await click(20, 20);
    expect(editor.state.inspect.pin).toBeNull();
    await click(20, 20);
    expect(editor.state.inspect.pin).not.toBeNull();
    await click(900, 900);
    expect(editor.state.inspect.pin).toBeNull();
  });

  it("↑ walks up and stops at the topmost element; ↓ comes back", async () => {
    const leaf = measured();
    const parent = measured({ loc: "a.tsx:0:0" });
    await move(10, 10);
    measure.mockResolvedValue([leaf, parent]);
    expect(key("ArrowUp")).toBe(true);
    await settle();
    expect(editor.state.inspect).toMatchObject({ up: 1, hover: { m: parent } });
    key("ArrowUp");
    await settle();
    expect(editor.state.inspect.up).toBe(1);
    measure.mockResolvedValue([leaf]);
    key("ArrowDown");
    await settle();
    expect(editor.state.inspect).toMatchObject({ up: 0, hover: { m: leaf } });
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
    expect(editor.state.inspect).toMatchObject({ up: 0, hover: { m: next } });
  });

  it("Backspace and ⌘D do nothing while measuring", () => {
    const remove = vi.spyOn(editor, "remove");
    const duplicate = vi.spyOn(editor, "duplicate");
    expect(key("Backspace")).toBe(true);
    expect(
      editor.key(
        { key: "d", code: "", metaKey: true, ctrlKey: false, shiftKey: false, altKey: false },
        "page",
      ),
    ).toBe(true);
    expect(remove).not.toHaveBeenCalled();
    expect(duplicate).not.toHaveBeenCalled();
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
    expect(editor.state.inspect.pin?.m.name).toBe("moved");
    measure.mockResolvedValue([null]);
    editor.frameChanged();
    await settle();
    expect(editor.state.inspect.pin).toBeNull();
  });

  it("drops a click held down while Esc unpins", async () => {
    await click(10, 10);
    const at = { clientX: 10, clientY: 10, pointerId: 1, button: 0 };
    viewport.dispatchEvent(Object.assign(new Event("pointerdown"), at));
    key("Escape");
    viewport.dispatchEvent(Object.assign(new Event("pointerup"), at));
    await settle();
    expect(editor.state.inspect.pin).toBeNull();
  });

  it("drops a click still waiting on its frame once Esc has unpinned", async () => {
    await click(10, 10);
    const answers: ((value: (Measurement | null)[]) => void)[] = [];
    measure.mockImplementationOnce(() => new Promise((resolve) => answers.push(resolve)));
    await click(20, 20);
    key("Escape");
    answers[0]!([measured({ loc: "b.tsx:1:1" })]);
    await settle();
    expect(editor.state.inspect.pin).toBeNull();
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
    expect(editor.state.inspect.pin?.m.text).toBe("second");
  });

  it("forgets a pin whose frame is removed", async () => {
    await click(10, 10);
    editor.setCanvas({ ...canvas, frames: [] });
    expect(editor.state.inspect.pin).toBeNull();
  });

  describe("drag area", () => {
    const pointer = (x: number, y: number) => ({
      clientX: x,
      clientY: y,
      pointerId: 1,
      button: 0,
    });
    const down = (x: number, y: number) =>
      viewport.dispatchEvent(Object.assign(new Event("pointerdown"), pointer(x, y)));
    const drag = async (x: number, y: number) => {
      viewport.dispatchEvent(Object.assign(new Event("pointermove"), pointer(x, y)));
      await settle();
    };
    const up = async (x: number, y: number) => {
      viewport.dispatchEvent(Object.assign(new Event("pointerup"), pointer(x, y)));
      await settle();
    };
    const area = async (x0: number, y0: number, x1: number, y1: number) => {
      down(x0, y0);
      await drag(x1, y1);
      await up(x1, y1);
    };
    const rectOf = () => editor.state.inspect.area?.rect;

    it("follows the pointer, clamps to the frame and stays after release", async () => {
      measureArea.mockResolvedValue({ elements: [measured()], total: 1 });
      down(10, 10);
      await drag(90, 40);
      expect(rectOf()).toEqual({ x: 10, y: 10, width: 80, height: 30 });
      await drag(800, 800);
      expect(rectOf()).toEqual({ x: 10, y: 10, width: 490, height: 490 });
      await up(800, 800);
      expect(editor.state.inspect.area).toMatchObject({ frameId: "f", total: 1 });
      expect(editor.state.inspect.area?.elements).toHaveLength(1);
    });

    it("leaves a press on the empty canvas alone", async () => {
      await area(700, 700, 800, 800);
      expect(editor.state.inspect.area).toBeNull();
    });

    it("clears on a click and does not pin from it", async () => {
      await area(10, 10, 90, 40);
      await click(50, 20);
      expect(editor.state.inspect.area).toBeNull();
      expect(editor.state.inspect.pin).toBeNull();
      expect(measure).not.toHaveBeenCalled();
      await area(10, 10, 90, 40);
      await click(400, 400);
      expect(editor.state.inspect.area).toBeNull();
    });

    it("clears when the tool changes", async () => {
      await area(10, 10, 90, 40);
      key("v");
      expect(editor.state.inspect.area).toBeNull();
    });

    it("Esc clears the area before a pin, then leaves the tool", async () => {
      await area(10, 10, 90, 40);
      editor.update({
        inspect: {
          ...editor.state.inspect,
          pin: { frameId: "f", target: { loc: "a.tsx:1:1", index: 0 }, m: measured() },
        },
      });
      expect(key("Escape")).toBe(true);
      expect(editor.state.inspect.area).toBeNull();
      expect(editor.state.inspect.pin).not.toBeNull();
      expect(key("Escape")).toBe(true);
      expect(editor.state.inspect.pin).toBeNull();
      expect(editor.state.tool).toBe("inspect");
      expect(key("Escape")).toBe(true);
      expect(editor.state.tool).toBe("select");
    });

    it("a new drag replaces the area, and clears a pin and the hover", async () => {
      await move(10, 10);
      await click(10, 10);
      expect(editor.state.inspect.pin).not.toBeNull();
      await area(10, 10, 90, 40);
      expect(editor.state.inspect.pin).toBeNull();
      expect(editor.state.inspect.hover).toBeNull();
      await area(100, 100, 200, 180);
      expect(rectOf()).toEqual({ x: 100, y: 100, width: 100, height: 80 });
    });

    it("suspends hover probing while an area exists", async () => {
      await area(10, 10, 90, 40);
      await move(50, 20);
      expect(measure).not.toHaveBeenCalled();
      expect(editor.state.inspect.hover).toBeNull();
    });

    it("drops a reply that lands after the area is cleared", async () => {
      let answer: (reply: AreaReply) => void = () => {};
      measureArea.mockReturnValue(new Promise((resolve) => (answer = resolve)));
      await area(10, 10, 90, 40);
      key("Escape");
      answer({ elements: [measured()], total: 1 });
      await settle();
      expect(editor.state.inspect.area).toBeNull();
    });

    it("drops the older drag's reply after a newer drag", async () => {
      const answers: ((reply: AreaReply) => void)[] = [];
      measureArea.mockImplementation(() => new Promise((resolve) => answers.push(resolve)));
      await area(10, 10, 90, 40);
      await area(100, 100, 200, 180);
      answers[0]!({ elements: [measured({ name: "old" })], total: 1 });
      await settle();
      expect(editor.state.inspect.area?.elements).toEqual([]);
      expect(answers).toHaveLength(2);
      answers[1]!({ elements: [measured({ name: "new" })], total: 1 });
      await settle();
      expect(editor.state.inspect.area?.elements[0]?.name).toBe("new");
    });

    it("coalesces a fast drag to the newest rect", async () => {
      const answers: ((reply: AreaReply) => void)[] = [];
      measureArea.mockImplementation(() => new Promise((resolve) => answers.push(resolve)));
      down(10, 10);
      await drag(50, 50);
      await drag(60, 60);
      await drag(70, 70);
      expect(measureArea).toHaveBeenCalledTimes(1);
      answers[0]!({ elements: [], total: 0 });
      await settle();
      expect(measureArea).toHaveBeenCalledTimes(2);
      expect(measureArea.mock.lastCall?.[0]).toEqual({ x: 10, y: 10, width: 60, height: 60 });
      await up(70, 70);
    });

    it("Esc during a drag cancels it, and later moves don't bring it back", async () => {
      down(10, 10);
      await drag(90, 40);
      expect(editor.state.inspect.area).not.toBeNull();
      expect(key("Escape")).toBe(true);
      expect(editor.state.inspect.area).toBeNull();
      await drag(120, 60);
      await up(120, 60);
      expect(editor.state.inspect.area).toBeNull();
    });

    it("a release under about 2px clears rather than keeping a sliver", async () => {
      down(10, 10);
      await drag(90, 11);
      await up(90, 11);
      expect(editor.state.inspect.area).toBeNull();
    });

    it("drops a click held down while Esc clears the area", async () => {
      await area(10, 10, 90, 40);
      down(50, 20);
      key("Escape");
      await up(50, 20);
      expect(editor.state.inspect.area).toBeNull();
      expect(editor.state.inspect.pin).toBeNull();
    });

    it("starts no area from a press whose frame was removed before the drag", async () => {
      down(10, 10);
      editor.setCanvas({ ...canvas, frames: [] });
      await drag(90, 40);
      await up(90, 40);
      expect(editor.state.inspect.area).toBeNull();
    });

    it("measures the area again on a frame update, and clears when its frame is removed", async () => {
      await area(10, 10, 90, 40);
      measureArea.mockResolvedValue({ elements: [measured({ name: "moved" })], total: 1 });
      editor.frameChanged();
      await settle();
      expect(editor.state.inspect.area?.elements[0]?.name).toBe("moved");
      editor.setCanvas({ ...canvas, frames: [] });
      expect(editor.state.inspect.area).toBeNull();
    });
  });
});
