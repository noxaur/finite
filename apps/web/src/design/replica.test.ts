import "./wasm.node";
import { describe, expect, it } from "vite-plus/test";
import { type Applied, Replica } from "./replica";
import type { Node } from "./schema";

const node = (id: string, parent: string | null, index = "V"): Node => ({
  id,
  parent,
  index,
  type: "element",
  tag: "div",
  name: null,
  text: null,
  x: parent === null ? 0 : null,
  y: parent === null ? 0 : null,
  styles: {},
  attrs: {},
});

const replica = () => {
  const r = new Replica();
  r.load({
    meta: { id: "d", name: "D", createdAt: 0, updatedAt: 0 },
    seq: 0,
    nodes: [node("a", null), node("b", "a", "V"), node("c", "a", "k"), node("d", "b")],
    comments: [],
  });
  return r;
};

describe("Replica", () => {
  it("keeps thousands of siblings in order without sorting per node", () => {
    const r = replica();
    // 10,000 siblings arriving in a shuffled order, some sharing an index.
    const keys = Array.from({ length: 10_000 }, (_, i) => ({
      id: `n${i}`,
      index: `V${((i * 7919) % 5000).toString(36).padStart(3, "0")}1`,
    }));
    const started = performance.now();
    for (const { id, index } of keys) r.apply({ op: "create", node: node(id, "c", index) });
    // Delete a few and move one, so removals keep the order too.
    for (const { id } of keys.slice(0, 100)) r.apply({ op: "delete", id });
    r.apply({ op: "move", id: "n500", parent: "c", index: "V0001" });
    const took = performance.now() - started;

    const expected = keys
      .slice(100)
      .map((k) => (k.id === "n500" ? { ...k, index: "V0001" } : k))
      .sort((a, b) => (a.index < b.index ? -1 : a.index > b.index ? 1 : a.id < b.id ? -1 : 1))
      .map((k) => k.id);
    expect(r.children("c").map((n) => n.id)).toEqual(expected);
    expect([...r.siblingsAfter(expected[9_000]!)].map((n) => n.id)).toEqual(expected.slice(9_001));
    // It takes about 75 ms here, and over 1 s on CI while Cargo builds
    // alongside. Sorting per insert would take tens of seconds.
    expect(took).toBeLessThan(5_000);
  });

  it("applies a whole change in one call, and the cache follows op by op", () => {
    const r = replica();
    const seen: string[] = [];
    const applied = r.applyAll(
      [
        { op: "create", node: node("e", "a", "G") },
        { op: "create", node: node("f", "e") },
        { op: "set", id: "f", key: "style:color", value: "red" },
        { op: "set", id: "missing", key: "name", value: "x" },
        { op: "move", id: "f", parent: "c", index: "V" },
        { op: "delete", id: "e" },
      ],
      (a: Applied) => {
        // Each callback sees the tree right after its own op.
        const where =
          a.op === "delete" ? a.parent : a.op === "tokens" || a.op === "page" ? null : a.node.id;
        seen.push(
          `${a.op} ${r
            .children("a")
            .map((n) => n.id)
            .join("")} ${where}`,
        );
      },
    );
    expect(applied.map((a) => a?.op ?? null)).toEqual([
      "create",
      "create",
      "set",
      null,
      "move",
      "delete",
    ]);
    expect(seen).toEqual([
      "create ebc e",
      "create ebc f",
      "set ebc f",
      "move ebc f",
      "delete bc a",
    ]);
    expect(r.get("f")).toMatchObject({ parent: "c", styles: { color: "red" } });
    expect(applied[4]).toMatchObject({ op: "move", from: "e" });
  });

  it("orders children by fractional index", () => {
    const r = replica();
    r.apply({ op: "create", node: node("e", "a", "G") });
    expect(r.children("a").map((n) => n.id)).toEqual(["e", "b", "c"]);
  });

  it("deletes whole subtrees", () => {
    const r = replica();
    const applied = r.apply({ op: "delete", id: "b" });
    expect(applied).toEqual({ op: "delete", parent: "a", removed: ["b", "d"] });
    expect(r.get("d")).toBeUndefined();
  });

  it("sets and clears styles", () => {
    const r = replica();
    r.apply({ op: "set", id: "b", key: "style:color", value: "red" });
    expect(r.get("b")?.styles).toEqual({ color: "red" });
    expect(r.apply({ op: "set", id: "b", key: "style:color", value: "red" })).toBeNull();
    r.apply({ op: "set", id: "b", key: "style:color", value: null });
    expect(r.get("b")?.styles).toEqual({});
  });

  it("skips stale ops like the server", () => {
    const r = replica();
    r.apply({ op: "delete", id: "b" });
    expect(r.apply({ op: "set", id: "d", key: "name", value: "x" })).toBeNull();
    expect(r.apply({ op: "create", node: node("z", "b") })).toBeNull();
    expect(r.apply({ op: "move", id: "a", parent: "c", index: "V" })).toBeNull();
  });

  it("moves nodes between parents", () => {
    const r = replica();
    r.apply({ op: "move", id: "d", parent: "c", index: "V" });
    expect(r.children("b")).toEqual([]);
    expect(r.children("c").map((n) => n.id)).toEqual(["d"]);
    expect(r.artboardOf("d")?.id).toBe("a");
  });

  it("expands instances with the Rust rules and says which to draw again", () => {
    const r = replica();
    r.applyAll([
      { op: "set", id: "b", key: "component", value: true },
      { op: "create", node: { ...node("i", "c"), instanceOf: "b" } },
      { op: "set", id: "i", key: "override:d/style:color", value: "red" },
    ]);
    expect(r.takeDirty()).toEqual(["i"]);
    const [root, inside] = r.expand("i");
    expect(root?.id).toBe("i");
    expect(inside).toMatchObject({ id: "i/d", parent: "i", styles: { color: "red" } });
    // A node inside an instance is on the instance's artboard.
    expect(r.artboardOf("i/d")?.id).toBe("a");
    expect(r.componentInfo("i/d")).toEqual({
      instance: "i",
      component: "b",
      componentName: "div",
      instances: 1,
    });
    // Editing the component marks the instance, not the component's own artboard.
    r.apply({ op: "set", id: "d", key: "style:padding", value: "4px" });
    expect(r.takeDirty()).toEqual(["i"]);
    expect(r.exportHtml("c")).toBe(
      '<div><div><div style="color: red; padding: 4px"></div></div></div>',
    );
  });

  it("keeps the tokens and modes from the snapshot and from changes", () => {
    const r = new Replica();
    const snapshot = {
      meta: { id: "d", name: "D", createdAt: 0, updatedAt: 0 },
      seq: 0,
      nodes: [node("a", null), { ...node("b", null), mode: "dark" }],
      comments: [],
    };
    r.load({
      ...snapshot,
      modes: { "mode-1": { name: "Light", index: "V" }, dark: { name: "Dark", index: "W" } },
      tokens: { "--bg": { "mode-1": "#fff", dark: "#111" }, "--brand": { "mode-1": "red" } },
    });
    expect(r.tokens.modes).toEqual([
      { id: "mode-1", name: "Light" },
      { id: "dark", name: "Dark" },
    ]);
    // Each artboard gets the values of its own mode, and Dark falls back to Light's --brand.
    expect(r.tokenStyle("a", true)).toBe(
      "@layer finite-tokens { :host { --bg: #fff; --brand: red; } }",
    );
    expect(r.tokenStyle("b", false)).toBe(
      "@layer finite-tokens { :root { --bg: #111; --brand: red; } }",
    );
    expect(r.modeOf(r.get("b")!)).toBe("dark");
    // The same values again don't apply, as on the server.
    expect(r.apply({ op: "token", name: "--brand", modeId: "mode-1", value: "red" })).toBeNull();
    expect(r.apply({ op: "token", name: "--brand", modeId: "mode-1", value: null })).toEqual({
      op: "tokens",
    });
    expect(r.tokens.tokens["--brand"]).toBeUndefined();
    // Removing Dark sends its artboard back to the first mode.
    r.apply({ op: "mode", id: "dark", mode: null });
    expect(r.modeOf(r.get("b")!)).toBe("mode-1");
    r.load(snapshot);
    expect(r.tokens).toEqual({ modes: [{ id: "mode-1", name: "Default" }], tokens: {} });
    expect(r.tokenStyle("a", true)).toBe("");
  });

  it("lists pages and which page each artboard is on", () => {
    const r = new Replica();
    const snapshot = {
      meta: { id: "d", name: "D", createdAt: 0, updatedAt: 0 },
      seq: 0,
      nodes: [node("a", null), { ...node("b", null), page: "kit" }],
      comments: [],
    };
    // Without pages, every artboard is on the implicit first page.
    r.load(snapshot);
    expect(r.pages).toEqual([{ id: "page-1", name: "Page 1" }]);
    expect(r.pageOf(r.get("b")!)).toBe("page-1");

    r.load({
      ...snapshot,
      pages: {
        kit: { name: "Components", index: "k" },
        "page-1": { name: "Screens", index: "V" },
      },
    });
    expect(r.pages.map((p) => p.name)).toEqual(["Screens", "Components"]);
    expect(r.pageOf(r.get("a")!)).toBe("page-1");
    expect(r.pageOf(r.get("b")!)).toBe("kit");

    // Removing a page moves its artboards to the first page.
    expect(r.apply({ op: "page", id: "kit", page: null })).toEqual({ op: "page" });
    expect(r.pages.map((p) => p.id)).toEqual(["page-1"]);
    expect(r.pageOf(r.get("b")!)).toBe("page-1");
  });
});
