import type { Frame, Hit } from "@finite/protocol";
import { describe, expect, it, vi } from "vite-plus/test";
import type { Down, ToolHost } from "./host";
import { placeText, text, textOnPath } from "./text";

const LOC = "src/App.tsx:3:30";
const RECT = { x: 0, y: 0, width: 10, height: 10 };
const FRAME = { id: "f1" } as Frame;

function hostOver(instances: number) {
  const hit: Hit = {
    loc: LOC,
    rev: "aaaaaaaa",
    tag: "path",
    rect: RECT,
    index: 0,
    count: instances,
    path: [],
  };
  const bridge = {
    hit: async () => hit,
    vector: async () => ({ d: "M0 0", ctm: [1, 0, 0, 1, 0, 0], viewBox: null, id: null }),
    rects: async () => ({ [LOC]: Array.from({ length: instances }, () => RECT) }),
  };
  const say = vi.fn();
  const edit = vi.fn(async () => false as const);
  const host = {
    bridge: () => bridge,
    local: () => ({ x: 5, y: 5 }),
    setTool: vi.fn(),
    say,
    edit,
  } as unknown as ToolHost;
  return { host, say, edit };
}

describe("text on a path", () => {
  it("refuses a path that renders more than once, and says so", async () => {
    const { host, say, edit } = hostOver(3);
    const plan = textOnPath.down(host, { frame: FRAME, world: { x: 5, y: 5 } } as Down);
    if (plan === "pass") throw new Error("expected a press plan");
    await plan.click();
    expect(edit).not.toHaveBeenCalled();
    expect(say).toHaveBeenCalledWith(expect.stringContaining("renders 3 times"));
  });

  it("writes to a path that renders once", async () => {
    const { host, say, edit } = hostOver(1);
    const plan = textOnPath.down(host, { frame: FRAME, world: { x: 5, y: 5 } } as Down);
    if (plan === "pass") throw new Error("expected a press plan");
    await plan.click();
    expect(edit).toHaveBeenCalledTimes(1);
    expect(say).not.toHaveBeenCalled();
  });
});

describe("new text", () => {
  const content = [{ t: "text" as const, text: "Hi", marks: [] }];
  const point = { x: 40, y: 60, width: 1, height: 1 };
  const measured = { width: 100.4, height: 24 };

  function drawing(over: Frame | null) {
    const draw = vi.fn(async () => null);
    return { draw, host: { frameAt: () => over, draw } as unknown as ToolHost };
  }

  it("makes a frame big enough for the text on empty canvas", async () => {
    const { host, draw } = drawing(null);
    const target = { kind: "new", box: point, deep: false, alt: false, fixed: false } as const;
    await placeText(host, target, content, measured);
    expect(draw).toHaveBeenCalledWith(
      expect.objectContaining({ box: { x: 40, y: 60, width: 109, height: 32 } }),
    );
  });

  it("keeps a dragged width on empty canvas, and takes the height from the text", async () => {
    const { host, draw } = drawing(null);
    const box = { x: 40, y: 60, width: 300, height: 6 };
    const target = { kind: "new", box, deep: false, alt: false, fixed: true } as const;
    await placeText(host, target, content, measured);
    expect(draw).toHaveBeenCalledWith(
      expect.objectContaining({ box: { x: 40, y: 60, width: 300, height: 32 } }),
    );
  });

  it("leaves the box alone over a frame, where the text hugs it", async () => {
    const { host, draw } = drawing(FRAME);
    const target = { kind: "new", box: point, deep: false, alt: false, fixed: false } as const;
    await placeText(host, target, content, measured);
    expect(draw).toHaveBeenCalledWith(expect.objectContaining({ box: point }));
  });
});

describe("a click with the Text tool", () => {
  const FILE = "app/layout.tsx";
  const hitOn = (tag: string, loc = `${FILE}:8:4`): Hit => ({
    loc,
    rev: "aaaaaaaa",
    tag,
    rect: RECT,
    index: 0,
    count: 1,
    path: [],
  });
  const main = {
    loc: "app/page.tsx:3:4",
    rev: "bbbbbbbb",
    tag: "main",
    index: 0,
    count: 1,
    rect: { x: 0, y: 0, width: 800, height: 100 },
    display: "block",
    flexDirection: "row",
    position: "static",
    borderLeft: 0,
    borderTop: 0,
    scrollLeft: 0,
    scrollTop: 0,
    children: [],
  };

  function clicking(hit: Hit, inline: unknown, chain: unknown[] = [main]) {
    const update = vi.fn();
    const say = vi.fn();
    const bridge = {
      hit: async () => hit,
      inspect: async () => ({ tag: hit.tag, computed: { color: "red" } }),
      rects: async () => ({ [hit.loc]: [RECT] }),
      drop: async () => ({ chain }),
    };
    const host = {
      frameAt: () => FRAME,
      local: (_: Frame, p: { x: number; y: number }) => p,
      boxOf: () => ({ ...RECT, x: 100, y: 100 }),
      ownFile: () => "app/page.tsx",
      bridge: () => bridge,
      readInline: vi.fn(async () => {
        if (inline instanceof Error) throw inline;
        return inline;
      }),
      update,
      say,
    } as unknown as ToolHost;
    return { host, update, say };
  }

  async function click(host: ToolHost) {
    const plan = text.down(host, {
      frame: FRAME,
      world: { x: 50, y: 500 },
      deep: false,
      alt: false,
    } as Down);
    await (plan as { click: () => Promise<void> }).click();
  }

  const opened = (update: ReturnType<typeof vi.fn>) =>
    update.mock.calls.flatMap(([patch]) => (patch.editingText ? [patch.editingText.target] : []));

  it("starts new text instead of editing <html>", async () => {
    const { host, update, say } = clicking(hitOn("html"), new Error("<html> is the page"));
    await click(host);
    expect(opened(update)).toEqual([expect.objectContaining({ kind: "new" })]);
    expect(say).not.toHaveBeenCalled();
  });

  it("starts new text over a layout slot, or an element holding only other elements", async () => {
    const slot = {
      rev: "aaaaaaaa",
      content: [{ t: "atom", id: 0 }],
      keeps: [{ id: 0, kind: "slot", label: "{children}" }],
    };
    const a = clicking(hitOn("div"), slot);
    await click(a.host);
    expect(opened(a.update)).toEqual([expect.objectContaining({ kind: "new" })]);
    const component = { ...slot, keeps: [{ id: 0, kind: "component", label: "<Badge>" }] };
    const b = clicking(hitOn("div"), component);
    await click(b.host);
    expect(opened(b.update)).toEqual([expect.objectContaining({ kind: "new" })]);
  });

  it("edits an element that holds text", async () => {
    const value = { rev: "aaaaaaaa", content: [{ t: "text", text: "Hi", marks: [] }], keeps: [] };
    const { host, update } = clicking(hitOn("h1"), value);
    await click(host);
    expect(opened(update)).toEqual([expect.objectContaining({ kind: "element", tag: "h1" })]);
  });

  it("refuses with the planner's reason before opening an editor when nothing can hold it", async () => {
    const onlyP = { ...main, tag: "p", children: [] };
    const { host, update, say } = clicking(hitOn("html"), new Error("no"), [onlyP]);
    await click(host);
    expect(opened(update)).toEqual([]);
    expect(say).toHaveBeenCalledWith(expect.stringContaining("Nothing here can hold"));
  });

  it("says the page has nothing to hold the text when there's no chain", async () => {
    const { host, update, say } = clicking(hitOn("html"), new Error("no"), []);
    await click(host);
    expect(opened(update)).toEqual([]);
    expect(say).toHaveBeenCalledWith(expect.stringContaining("nothing to draw into"));
  });
});
