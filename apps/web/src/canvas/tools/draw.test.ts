import type { DropNode, Frame } from "@finite/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { finite } from "@/client/finite";
import { keyOf, type SelectionItem, selectionStore } from "../selection";
import { draw } from "./draw";
import type { ToolHost } from "./host";

vi.mock("@/client/finite", () => ({ finite: { request: vi.fn() } }));
vi.mock("../undoOrder", () => ({ undoOrderFor: () => ({ did: () => {} }) }));

const OWN = "src/App.tsx";
const NEW_LOC = `${OWN}:9:4`;
const BOX = { x: 10, y: 10, width: 50, height: 50 };
const FRAME = { id: "f1" } as Frame;
const NODE = { tag: "div", name: "Rectangle" };
const container: DropNode = {
  loc: `${OWN}:3:2`,
  rev: "r1",
  tag: "div",
  index: 0,
  count: 1,
  rect: { x: 0, y: 0, width: 400, height: 400 },
  display: "block",
  flexDirection: "row",
  position: "relative",
  borderLeft: 0,
  borderTop: 0,
  scrollLeft: 0,
  scrollTop: 0,
  children: [],
};
const picked: SelectionItem = { frameId: "f2", loc: `${OWN}:20:4`, index: 0 };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function hostOn(
  frame: Frame | null,
  edit: ToolHost["edit"] = async () => ({
    created: { new: NEW_LOC },
    remap: {},
  }),
) {
  const bridge = {
    drop: async () => ({ chain: [container] }),
    rects: async () => ({ [NEW_LOC]: [BOX] }),
  };
  const state = { selectedText: null as string | null, selectedObject: null };
  const select = vi.fn((items: SelectionItem[]) => selectionStore.set(items));
  const host = {
    designId: "d1",
    canvasId: "c1",
    state,
    bridge: () => bridge,
    frameAt: () => frame,
    local: (_: Frame, p: { x: number; y: number }) => p,
    ownFile: () => OWN,
    say: vi.fn(),
    edit,
    select,
  } as unknown as ToolHost;
  return { host, select, state };
}

describe("a shape landing", () => {
  beforeEach(() => selectionStore.set([]));
  afterEach(() => selectionStore.set([]));

  it("selects what it drew when nobody picked anything", async () => {
    const { host, select } = hostOn(FRAME);
    const placed = await draw(host, { box: BOX, node: NODE });
    expect(placed?.selected).toBe(true);
    expect(select).toHaveBeenCalledTimes(1);
  });

  it("keeps a pick made while the edit was on its way", async () => {
    const answer = deferred<{ created: Record<string, string>; remap: Record<string, string> }>();
    const { host, select } = hostOn(FRAME, () => answer.promise);
    const drawing = draw(host, { box: BOX, node: NODE });
    await new Promise((resolve) => setTimeout(resolve, 0));
    selectionStore.set([picked]);
    answer.resolve({ created: { new: NEW_LOC }, remap: {} });
    const placed = await drawing;
    expect(placed).toMatchObject({ loc: NEW_LOC, selected: false });
    expect(select).not.toHaveBeenCalled();
    expect(selectionStore.get().map(keyOf)).toEqual([keyOf(picked)]);
  });

  it("keeps a text label picked while the shape was on its way", async () => {
    const answer = deferred<{ created: Record<string, string>; remap: Record<string, string> }>();
    const { host, select, state } = hostOn(FRAME, () => answer.promise);
    const drawing = draw(host, { box: BOX, node: NODE });
    await new Promise((resolve) => setTimeout(resolve, 0));
    state.selectedText = "t1";
    answer.resolve({ created: { new: NEW_LOC }, remap: {} });
    await drawing;
    expect(select).not.toHaveBeenCalled();
  });

  it("doesn't take its own edit moving the selection's locs for a pick", async () => {
    const selected: SelectionItem = { frameId: "f1", loc: `${OWN}:12:4`, index: 0 };
    const moved = `${OWN}:15:4`;
    selectionStore.set([selected]);
    const { host, select } = hostOn(FRAME, async () => {
      selectionStore.set([{ ...selected, loc: moved }]);
      return { created: { new: NEW_LOC }, remap: { [selected.loc!]: moved } };
    });
    await draw(host, { box: BOX, node: NODE });
    expect(select).toHaveBeenCalledTimes(1);
  });

  it("keeps a pick on empty canvas too", async () => {
    const answer = deferred<{ frameId: string; created: Record<string, string> }>();
    vi.mocked(finite.request).mockReturnValueOnce(answer.promise as never);
    const { host, select } = hostOn(null);
    const drawing = draw(host, { box: BOX, node: NODE });
    selectionStore.set([picked]);
    answer.resolve({ frameId: "new-frame", created: { new: NEW_LOC } });
    expect(await drawing).toMatchObject({ frameId: "new-frame", selected: false });
    expect(select).not.toHaveBeenCalled();
  });
});
