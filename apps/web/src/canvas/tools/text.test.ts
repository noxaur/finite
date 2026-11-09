import type { Frame, Hit } from "@finite/protocol";
import { describe, expect, it, vi } from "vite-plus/test";
import type { Down, ToolHost } from "./host";
import { textOnPath } from "./text";

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
