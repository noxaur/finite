import type { LayerNode, Rect, SourceEdit } from "@finite/protocol";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { keyOf, selectionStore, type SelectionItem } from "../selection";
import { removeAutoLayout } from "./autoLayout";
import type { ToolHost } from "./host";

type El = { rect: Rect; computed: Record<string, string>; tag?: string };

/** A frame of `els` by loc under one parent, and what the command sent. */
function setup(parent: string, name: string, els: Record<string, El>, kids: string[]) {
  const node = (loc: string, n: string, children: LayerNode[] = []): LayerNode => ({
    loc,
    rev: "r1",
    tag: els[loc]?.tag ?? "div",
    index: 0,
    name: n,
    children,
  });
  const layers = [
    node(
      parent,
      name,
      kids.map((k) => node(k, "div")),
    ),
  ];
  const bridge = {
    rects: async (locs: string[]) => Object.fromEntries(locs.map((l) => [l, [els[l]!.rect]])),
    inspect: async (loc: string) => ({
      tag: els[loc]?.tag ?? "div",
      rev: "r1",
      className: "",
      computed: els[loc]!.computed,
      parent: { display: "block", flexDirection: "row" },
    }),
    layers: async () => layers,
  };
  const sent: SourceEdit[][] = [];
  const item: SelectionItem = { frameId: "f", loc: parent, index: 0, name };
  const facts = new Map([[keyOf(item), { rev: "r1", tag: "div", path: [] }]]);
  const host = {
    facts,
    bridge: () => bridge,
    say: (text: string) => {
      throw new Error(text);
    },
    selectHit: (frameId: string, hit: { loc: string }, index: number) => ({
      frameId,
      loc: hit.loc,
      index,
    }),
    edit: async (edits: SourceEdit[]) => {
      sent.push(edits);
      return { created: {} };
    },
  } as unknown as ToolHost;
  selectionStore.set([item]);
  return { host, sent };
}

const styleOf = (edits: SourceEdit[], loc: string) => {
  const edit = edits.find((e) => e.kind === "style" && e.locs.includes(loc));
  return edit?.kind === "style" ? edit.styles : undefined;
};

afterEach(() => selectionStore.set([]));

describe("Shift+Alt+A on an ordinary flex container", () => {
  it("keeps the size of a container its children were holding open", async () => {
    const { host, sent } = setup(
      "a.tsx:1:0",
      "div",
      {
        "a.tsx:1:0": {
          rect: { x: 0, y: 0, width: 300, height: 80 },
          computed: { display: "flex", position: "static", sizedWidth: "auto", sizedHeight: "hug" },
        },
        "a.tsx:2:0": {
          rect: { x: 0, y: 0, width: 300, height: 80 },
          computed: { position: "static", sizedWidth: "fixed", sizedHeight: "fixed" },
        },
      },
      ["a.tsx:2:0"],
    );
    await removeAutoLayout(host);
    expect(styleOf(sent[0]!, "a.tsx:1:0")).toMatchObject({ width: "300px", height: "80px" });
  });

  it("leaves a fixed container's size alone", async () => {
    const { host, sent } = setup(
      "a.tsx:1:0",
      "div",
      {
        "a.tsx:1:0": {
          rect: { x: 0, y: 0, width: 300, height: 80 },
          computed: {
            display: "flex",
            position: "static",
            sizedWidth: "fixed",
            sizedHeight: "fixed",
          },
        },
        "a.tsx:2:0": {
          rect: { x: 0, y: 0, width: 10, height: 10 },
          computed: { position: "static", sizedWidth: "fixed", sizedHeight: "fixed" },
        },
      },
      ["a.tsx:2:0"],
    );
    await removeAutoLayout(host);
    const styles = styleOf(sent[0]!, "a.tsx:1:0")!;
    expect(styles).not.toHaveProperty("width");
    expect(styles).not.toHaveProperty("height");
  });
});

describe("unwrapping under an ancestor's zoom", () => {
  it("writes the measured displacement in the child's own pixels", async () => {
    const { host, sent } = setup(
      "a.tsx:1:0",
      "Auto layout",
      {
        "a.tsx:1:0": {
          rect: { x: 68, y: 0, width: 300, height: 40 },
          computed: {
            display: "flex",
            position: "absolute",
            left: "34px",
            top: "0px",
            zoom: "1",
            effectiveZoom: "2",
          },
        },
        "a.tsx:2:0": {
          rect: { x: 168, y: 0, width: 40, height: 40 },
          computed: {
            position: "static",
            zoom: "1",
            effectiveZoom: "2",
            sizedWidth: "auto",
            sizedHeight: "auto",
          },
        },
      },
      ["a.tsx:2:0"],
    );
    await removeAutoLayout(host);
    expect(styleOf(sent[0]!, "a.tsx:2:0")).toMatchObject({
      position: "absolute",
      left: "84px",
      width: "20px",
    });
  });
});
