import type { Frame, Hit } from "@finite/protocol";
import { describe, expect, it, vi } from "vite-plus/test";
import type { Down, ToolHost } from "./host";
import { placeText, textOnPath } from "./text";

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
