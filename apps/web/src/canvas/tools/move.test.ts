import type { Frame, Rect, SourceEdit } from "@finite/protocol";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { keyOf, selectionStore } from "../selection";
import type { Down, Gesture, PressPlan, ToolHost } from "./host";
import { select } from "./move";

const inspection = { current: {} as Record<string, string> };
const previews: Array<Record<string, string | null> | null> = [];
const bridge = {
  hit: async () => ({
    loc: "a.tsx:1:0",
    rev: "r1",
    tag: "div",
    rect,
    index: 0,
    count: 1,
    path: [],
  }),
  inspect: async () => ({
    tag: "div",
    rev: "r1",
    className: "",
    computed: inspection.current,
    parent: { display: "block", flexDirection: "row" },
  }),
  preview: (_: string, styles: Record<string, string | null> | null) => previews.push(styles),
};
const rect: Rect = { x: 20, y: 20, width: 360, height: 160 };

vi.mock("../bridge", () => ({ bridgeOf: () => bridge }));

async function drag(computed: Record<string, string>, by: { x: number; y: number }) {
  inspection.current = computed;
  const frame = { id: "f" } as Frame;
  const item = { frameId: "f", loc: "a.tsx:1:0", index: 0 };
  const sent: SourceEdit[][] = [];
  const host = {
    facts: new Map([[keyOf(item), { rev: "r1", tag: "div", path: [] }]]),
    state: { rects: { [keyOf(item)]: rect } },
    local: (_: Frame, p: { x: number; y: number }) => p,
    update: () => {},
    selectHit: () => item,
    frameItem: () => ({ frameId: "f" }),
    refreshSelection: async () => {},
    edit: async (edits: SourceEdit[]) => {
      sent.push(edits);
      return { created: {} };
    },
  } as unknown as ToolHost;
  const from = { x: 100, y: 100 };
  const down = {
    target: null,
    world: from,
    screen: from,
    shift: false,
    deep: false,
    alt: false,
    frame,
  } as unknown as Down;
  const plan = select.down(host, down) as PressPlan;
  const gesture = (await plan.begin()) as Gesture;
  const to = { x: from.x + by.x, y: from.y + by.y };
  gesture.move(to, to, { shiftKey: false } as PointerEvent);
  await gesture.end(true);
  const [edit] = sent[0]!;
  if (edit?.kind !== "style") throw new Error("expected a style edit");
  return edit.styles;
}

afterEach(() => {
  selectionStore.set([]);
  previews.length = 0;
});

describe("moving a positioned element", () => {
  it("keeps the size its opposite insets were giving it", async () => {
    const styles = await drag(
      {
        position: "absolute",
        left: "20px",
        top: "20px",
        zoom: "1",
        sizedWidth: "auto",
        sizedHeight: "auto",
      },
      { x: 10, y: 10 },
    );
    expect(styles).toMatchObject({
      left: "30px",
      top: "30px",
      right: null,
      bottom: null,
      width: "360px",
      height: "160px",
    });
    expect(previews.at(-1)).toMatchObject({ width: "360px", height: "160px" });
  });

  it("leaves a size that isn't from its insets alone", async () => {
    const styles = await drag(
      {
        position: "absolute",
        left: "20px",
        top: "20px",
        zoom: "1",
        sizedWidth: "fixed",
        sizedHeight: "hug",
      },
      { x: 10, y: 10 },
    );
    expect(styles).not.toHaveProperty("width");
    expect(styles).not.toHaveProperty("height");
  });

  it("moves under an ancestor's zoom by the drag, not twice it", async () => {
    const styles = await drag(
      { position: "absolute", left: "10px", top: "0px", zoom: "1", effectiveZoom: "2" },
      { x: 20, y: 0 },
    );
    expect(styles).toMatchObject({ left: "20px", top: "0px" });
  });
});
