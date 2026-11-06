import type { LayerNode } from "@finite/protocol";
import { describe, expect, it } from "vite-plus/test";
import { ATTACH_RANGE, labelAnchor } from "./labelAnchor";
import { childrenIn, layerName, layerNameAt, layerRows, pathIn } from "./layers";
import { pinSpot } from "./pins";
import { frameSrc } from "./frameSrc";
import { keyOf, remapSelection, selectionStore, toggleItem } from "./selection";
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
  it("tells its readers when only an item's name changes", () => {
    const item = { frameId: "f", loc: "a.tsx:1:1", index: 0, name: "Button" };
    selectionStore.set([item]);
    let told = 0;
    const off = selectionStore.subscribe(() => told++);
    selectionStore.set([{ ...item }]);
    selectionStore.set([{ ...item, name: "Get started" }]);
    off();
    selectionStore.set([]);
    expect(told).toBe(1);
  });

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
    const shut = layerRows(frames, { f: tree }, new Set(["f", "f|a.tsx:1:1|0"]));
    expect(shut.map((r) => [r.name, r.depth, r.open])).toEqual([
      ["Home", 0, true],
      ["1", 1, true],
      ["2 ×2", 2, false],
      ["About", 0, false],
    ]);
    const rows = layerRows(frames, { f: tree }, new Set(["f", "f|a.tsx:1:1|0", "f|a.tsx:2:1|×"]));
    expect(rows.map((r) => [r.name, r.depth, r.open])).toEqual([
      ["Home", 0, true],
      ["1", 1, true],
      ["2 ×2", 2, true],
      ["2", 3, null],
      ["2", 3, false],
      ["About", 0, false],
    ]);
  });

  it("names bare elements by their component, then by what their tag means", () => {
    const bare = (loc: string, tag: string) => ({ loc, tag, name: tag });
    expect(layerName({ loc: "a.tsx:1:1", tag: "div", name: "Buy now" }, "a.tsx")).toBe("Buy now");
    expect(layerName(bare("src/components/Card.tsx:3:5", "div"), "src/App.tsx")).toBe("Card");
    expect(layerName(bare("src/routes/pricing/index.tsx:3:5", "div"))).toBe("Pricing");
    expect(layerName(bare("src/App.tsx:9:5", "nav"), "src/App.tsx")).toBe("Nav");
    expect(layerName(bare("src/App.tsx:9:5", "div"), "src/App.tsx")).toBe("div");
  });

  it("names a selected element as its layers row does, for the composer", () => {
    const named = [
      {
        loc: "src/Home.tsx:1:1",
        rev: "r",
        tag: "div",
        index: 0,
        name: "div",
        children: [
          { loc: "src/Hero.tsx:2:1", rev: "r", tag: "div", index: 0, name: "div", children: [] },
          { loc: "src/Home.tsx:5:1", rev: "r", tag: "h1", index: 0, name: "Hello", children: [] },
        ],
      },
    ];
    expect(layerNameAt(named, "src/Home.tsx:1:1", 0)).toBe("Home");
    expect(layerNameAt(named, "src/Hero.tsx:2:1", 0)).toBe("Hero");
    expect(layerNameAt(named, "src/Home.tsx:5:1", 0)).toBe("Hello");
    expect(layerNameAt(named, "src/Home.tsx:5:1", 1)).toBeNull();
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

describe("frameSrc", () => {
  it("fills route params the way the server does, optional ones and splats included", () => {
    const route = (path: string, params?: Record<string, string>) =>
      frameSrc("http://127.0.0.1:5000/", { kind: "route", path, ...(params ? { params } : {}) });
    expect(route("/posts/{-$id}", { id: "42" })).toBe("http://127.0.0.1:5000/posts/42");
    expect(route("/posts/{-$id}")).toBe("http://127.0.0.1:5000/posts");
    expect(route("/docs/$", { _splat: "a/b" })).toBe("http://127.0.0.1:5000/docs/a/b");
  });
});

describe("which frame a label sits over", () => {
  const frames = [
    { x: 0, y: 0, width: 400 },
    { x: 500, y: 0, width: 400 },
    { x: 0, y: 1000, width: 400 },
  ];

  it("anchors the label place_frames writes above a frame to that frame's top", () => {
    expect(labelAnchor({ x: 500, y: -120, width: 400 }, frames)).toBe(frames[1]);
    expect(labelAnchor({ x: 0, y: 880, width: 400 }, frames)).toBe(frames[2]);
  });

  it("leaves labels free when they're far above, below, or beside every frame", () => {
    expect(labelAnchor({ x: 0, y: -ATTACH_RANGE - 1, width: 400 }, frames)).toBeNull();
    expect(labelAnchor({ x: 0, y: 600, width: 400 }, frames)).toBeNull();
    expect(labelAnchor({ x: 420, y: -120, width: 60 }, frames)).toBeNull();
  });
});
