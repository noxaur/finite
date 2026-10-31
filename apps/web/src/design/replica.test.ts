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
