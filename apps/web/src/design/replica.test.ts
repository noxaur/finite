import { describe, expect, it } from "vite-plus/test";
import { Replica } from "./replica";
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
    expect(took).toBeLessThan(1_000);
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
});
