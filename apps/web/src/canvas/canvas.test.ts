import type { LayerNode } from "@finite/protocol";
import { describe, expect, it } from "vite-plus/test";
import { childrenIn, layerRows, pathIn } from "./layers";
import { pinSpot } from "./pins";
import { frameSrc } from "./frameSrc";
import { keyOf, remapSelection, toggleItem } from "./selection";
import { framesToMount } from "./virtualize";

const box = (id: string, x: number, y = 0) => ({ id, x, y, width: 100, height: 100 });

describe("which frames keep an iframe", () => {
  const frames = Array.from({ length: 30 }, (_, i) => box(`f${i}`, i * 200));
  const view = { x: 0, y: 0, width: 650, height: 400 };

  it("mounts the frames in view, nearest the middle first", () => {
    expect(framesToMount(frames, view, [])).toEqual(["f1", "f2", "f0", "f3"]);
  });

  it("keeps recently shown ones up to the cap, and pinned ones first", () => {
    const recent = ["f20", "f21", "f22", "f23", "f24", "f25", "f26", "f27", "f28", "f29"];
    const out = framesToMount(frames, view, recent, new Set(["f15"]));
    expect(out).toHaveLength(12);
    expect(out.slice(0, 5)).toEqual(["f15", "f1", "f2", "f0", "f3"]);
    expect(out.slice(5)).toEqual(recent.slice(0, 7));
  });

  it("never mounts more than the cap, even when all are in view", () => {
    const all = { x: 0, y: 0, width: 10_000, height: 400 };
    expect(framesToMount(frames, all, [])).toHaveLength(12);
  });

  it("drops frames that are gone", () => {
    expect(framesToMount([box("a", 0)], view, ["gone"])).toEqual(["a"]);
  });
});

describe("the selection", () => {
  it("follows remapped locs and keeps frames as they are", () => {
    const items = [
      { frameId: "f", loc: "src/A.tsx:3:2", index: 1 },
      { frameId: "f" },
      { frameId: "g", loc: "src/B.tsx:1:1", index: 0 },
    ];
    expect(remapSelection(items, { "src/A.tsx:3:2": "src/A.tsx:4:2" })).toEqual([
      { frameId: "f", loc: "src/A.tsx:4:2", index: 1 },
      { frameId: "f" },
      { frameId: "g", loc: "src/B.tsx:1:1", index: 0 },
    ]);
  });

  it("toggles one item in or out, by frame, loc and instance", () => {
    const a = { frameId: "f", loc: "src/A.tsx:3:2", index: 0 };
    const b = { ...a, index: 1 };
    expect(toggleItem([a], b)).toEqual([a, b]);
    expect(toggleItem([a, b], { ...a, name: "div" })).toEqual([b]);
    expect(keyOf({ frameId: "f" })).toBe("f");
  });
});

const layer = (loc: string, index: number, children: LayerNode[] = []): LayerNode => ({
  loc,
  rev: "00000000",
  tag: "div",
  index,
  name: loc.split(":")[1]!,
  children,
});

describe("layer trees", () => {
  const tree = [
    layer("a.tsx:1:1", 0, [layer("a.tsx:2:1", 0), layer("a.tsx:2:1", 1, [layer("a.tsx:3:1", 1)])]),
  ];

  it("finds an element's ancestors, nearest first, and a node's children", () => {
    expect(pathIn(tree, "a.tsx:3:1", 1)?.map((p) => p.loc)).toEqual(["a.tsx:2:1", "a.tsx:1:1"]);
    expect(pathIn(tree, "a.tsx:9:9", 0)).toBeNull();
    expect(childrenIn(tree, { loc: "a.tsx:1:1", index: 0 })?.length).toBe(2);
    expect(childrenIn(tree, null)).toHaveLength(1);
  });

  it("lists frames, and the open ones' elements under them", () => {
    const frames = [
      { id: "f", name: "Home" },
      { id: "g", name: "About" },
    ];
    const rows = layerRows(frames, { f: tree }, new Set(["f", "f|a.tsx:1:1|0"]));
    expect(rows.map((r) => [r.name, r.depth, r.open])).toEqual([
      ["Home", 0, true],
      ["1", 1, true],
      ["2", 2, null],
      ["2", 2, false],
      ["About", 0, false],
    ]);
  });
});

describe("frame sources", () => {
  it("loads a route with its params filled in", () => {
    expect(
      frameSrc("http://127.0.0.1:5173/", {
        kind: "route",
        path: "/users/:id/$tab",
        params: { id: "4 2", tab: "posts" },
      }),
    ).toBe("http://127.0.0.1:5173/users/4%202/posts");
  });

  it("loads one file's export through the plugin's frame page", () => {
    expect(
      frameSrc("http://127.0.0.1:5173", {
        kind: "file",
        file: ".finite/boards/c1/Card.tsx",
        exportName: "Card",
      }),
    ).toBe(
      "http://127.0.0.1:5173/__finite/frame?file=.finite%2Fboards%2Fc1%2FCard.tsx&export=Card",
    );
  });
});

describe("comment pins", () => {
  const frame = (id: string) =>
    id === "f" ? { box: { x: 100, y: 50, width: 400, height: 300 } } : undefined;

  it("sits at the top-right corner of its element's box", () => {
    const rects = {
      "a.tsx:1:1": [
        { x: 0, y: 0, width: 1, height: 1 },
        { x: 10, y: 20, width: 30, height: 5 },
      ],
    };
    expect(pinSpot({ frameId: "f", loc: "a.tsx:1:1", index: 1 }, frame, rects)).toEqual({
      at: { x: 140, y: 70 },
      moved: false,
    });
  });

  it("falls back to the frame's corner, marked moved once the frame says the element is gone", () => {
    const anchor = { frameId: "f", loc: "a.tsx:9:9", index: 0 };
    expect(pinSpot(anchor, frame, {})).toEqual({ at: { x: 500, y: 50 }, moved: true });
    expect(pinSpot(anchor, frame, null)).toEqual({ at: { x: 500, y: 50 }, moved: false });
    expect(pinSpot({ frameId: "gone" }, frame, null)).toBeNull();
    expect(pinSpot({ x: 3, y: 4 }, frame, null)).toEqual({ at: { x: 3, y: 4 }, moved: false });
  });
});
