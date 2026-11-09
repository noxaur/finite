import { describe, expect, it, vi } from "vite-plus/test";
import type { KeyInput, ToolHost } from "./host";
import { pen } from "./pen";
import { penDraft } from "./vectorState";

const draft = {
  closed: false,
  anchors: [{ p: { x: 0, y: 0 }, in: null, out: null, mode: "none" as const }],
};
const host = () => ({}) as ToolHost;

describe("the pen's draft", () => {
  it("survives the tool being picked again, as a held key does", () => {
    const one = host();
    pen.activate(one);
    penDraft.set(draft);
    pen.activate(one);
    expect(penDraft.get()).toBe(draft);
    penDraft.set(null);
  });

  it("doesn't follow the person to another canvas", () => {
    const one = host();
    pen.activate(one);
    penDraft.set(draft);
    pen.activate(host());
    expect(penDraft.get()).toBeNull();
  });
});

describe("finishing a path", () => {
  const enter = { key: "Enter" } as KeyInput;
  const twoAnchors = { ...draft, anchors: [...draft.anchors, ...draft.anchors] };

  function drawing() {
    let land!: (placed: null) => void;
    const setTool = vi.fn();
    const penHost = {
      state: { tool: "pen" },
      setTool,
      draw: () => new Promise<null>((resolve) => (land = resolve)),
    } as unknown as ToolHost;
    return { penHost, setTool, land: () => land(null) };
  }
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("hands back to Move once the path has landed", async () => {
    const { penHost, setTool, land } = drawing();
    penDraft.set(twoAnchors);
    pen.key(penHost, enter);
    land();
    await flush();
    expect(setTool).toHaveBeenCalledWith("select");
  });

  it("doesn't take the selection when draw kept someone's pick", async () => {
    const select = vi.fn();
    const layers = vi.fn(async () => []);
    const placed = { frameId: "f", loc: "src/a.tsx:1:1", index: 0, selected: false };
    const penHost = {
      state: { tool: "pen" },
      setTool: vi.fn(),
      draw: async () => placed,
      bridge: () => ({ layers }),
      select,
    } as unknown as ToolHost;
    penDraft.set(twoAnchors);
    pen.key(penHost, enter);
    await flush();
    expect(layers).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
  });

  it("leaves a draft started while the last path was landing", async () => {
    const { penHost, setTool, land } = drawing();
    penDraft.set(twoAnchors);
    pen.key(penHost, enter);
    penDraft.set(draft);
    land();
    await flush();
    expect(setTool).not.toHaveBeenCalled();
    expect(penDraft.get()).toBe(draft);
    penDraft.set(null);
  });
});
