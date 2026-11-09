import type { Frame, Rect, SourceEdit } from "@finite/protocol";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { keyOf, selectionStore } from "../selection";
import type { Down, Gesture, PressPlan, ToolHost } from "./host";
import { select } from "./move";

const inspection = { current: {} as Record<string, string> };
const previews: Array<Record<string, string | null> | null> = [];
const pressed = {
  current: {
    loc: "a.tsx:1:0",
    rev: "r1",
    tag: "div",
    rect: { x: 0, y: 0, width: 1, height: 1 },
    index: 0,
    count: 1,
    path: [] as { loc: string; rev: string; tag: string }[],
  },
};
const bridge = {
  hit: async () => pressed.current,
  rects: async (locs: string[]) => Object.fromEntries(locs.map((l) => [l, [rect]])),
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
const measured = { current: rect };

vi.mock("../bridge", () => ({ bridgeOf: () => bridge }));

async function drag(computed: Record<string, string>, by: { x: number; y: number }) {
  inspection.current = computed;
  const frame = { id: "f" } as Frame;
  const item = { frameId: "f", loc: "a.tsx:1:0", index: 0 };
  const sent: SourceEdit[][] = [];
  const facts = new Map([[keyOf(item), { rev: "r1", tag: "div", path: [] as unknown[] }]]);
  const host = {
    facts,
    state: {
      get rects() {
        return Object.fromEntries([...facts.keys()].map((k) => [k, measured.current]));
      },
    },
    local: (_: Frame, p: { x: number; y: number }) => p,
    update: () => {},
    selectHit: (_: string, el: { loc: string; tag: string }, index: number) => {
      const picked = { frameId: "f", loc: el.loc, index };
      if (!facts.has(keyOf(picked))) facts.set(keyOf(picked), { rev: "r1", tag: el.tag, path: [] });
      return picked;
    },
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
  return { ...edit.styles, locs: edit.locs };
}

afterEach(() => {
  selectionStore.set([]);
  previews.length = 0;
  measured.current = rect;
  pressed.current = { ...pressed.current, loc: "a.tsx:1:0", tag: "div", path: [] };
});

describe("moving a positioned element", () => {
  it("keeps the size its opposite insets were giving it", async () => {
    const styles = await drag(
      {
        position: "absolute",
        left: "20px",
        top: "20px",
        zoom: "1",
        width: "360px",
        height: "160px",
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

  it("writes the computed size, which matches its box-sizing", async () => {
    // A content-box element: the measured 360×160 box holds 12px of padding and border a side.
    const styles = await drag(
      {
        position: "absolute",
        left: "20px",
        top: "20px",
        zoom: "1",
        boxSizing: "content-box",
        width: "336px",
        height: "136px",
        sizedWidth: "auto",
        sizedHeight: "auto",
      },
      { x: 10, y: 10 },
    );
    expect(styles).toMatchObject({ width: "336px", height: "136px" });
  });

  it("writes the computed size under a transform, which doesn't change it", async () => {
    measured.current = { x: 20, y: 20, width: 720, height: 320 };
    const styles = await drag(
      {
        position: "absolute",
        left: "20px",
        top: "20px",
        zoom: "1",
        width: "360px",
        height: "160px",
        sizedWidth: "auto",
        sizedHeight: "auto",
      },
      { x: 10, y: 10 },
    );
    expect(styles).toMatchObject({ width: "360px", height: "160px" });
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

describe("dragging a drawn vector", () => {
  const svg = { loc: "a.tsx:2:0", rev: "r1", tag: "svg" };
  const body = { loc: "a.tsx:1:0", rev: "r1", tag: "body" };

  it("moves the <svg> when the press lands on the <path> inside it", async () => {
    pressed.current = { ...pressed.current, loc: "a.tsx:3:0", tag: "path", path: [svg, body] };
    const styles = await drag(
      { position: "absolute", left: "20px", top: "20px", zoom: "1" },
      { x: 10, y: 10 },
    );
    expect(styles).toMatchObject({ left: "30px", top: "30px", locs: ["a.tsx:2:0"] });
  });

  it("moves a selected inner <svg>, not the positioned <svg> around it", async () => {
    const inner = { loc: "a.tsx:1:0", rev: "r1", tag: "svg" };
    const outer = { loc: "a.tsx:0:0", rev: "r1", tag: "svg" };
    pressed.current = { ...pressed.current, loc: "a.tsx:3:0", tag: "path", path: [inner, outer] };
    selectionStore.set([{ frameId: "f", loc: inner.loc, index: 0 }]);
    const styles = await drag(
      { position: "absolute", left: "20px", top: "20px", zoom: "1" },
      { x: 10, y: 10 },
    );
    expect(styles).toMatchObject({ locs: [inner.loc] });
  });

  it("moves the <svg> when the <path> was selected by an earlier click", async () => {
    pressed.current = { ...pressed.current, loc: "a.tsx:3:0", tag: "path", path: [svg, body] };
    selectionStore.set([{ frameId: "f", loc: "a.tsx:3:0", index: 0 }]);
    const styles = await drag(
      { position: "absolute", left: "20px", top: "20px", zoom: "1" },
      { x: 10, y: 10 },
    );
    expect(styles).toMatchObject({ locs: ["a.tsx:2:0"] });
  });
});
