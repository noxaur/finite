import "./wasm.node";
import { describe, expect, it } from "vite-plus/test";
import { Replica } from "./replica";
import type { Node } from "./schema";
import { designModel } from "./wasm";

const text = (id: string, parent: string, value: string): Node => ({
  id,
  parent,
  index: "V",
  type: "text",
  name: null,
  text: value,
  x: null,
  y: null,
  styles: {},
  attrs: {},
});

const board: Node = { ...text("a", "", ""), parent: null, type: "element", tag: "p", text: null };

const load = (nodes: ReadonlyArray<Node>) => {
  const r = new Replica();
  r.load({ meta: { id: "d", name: "D", createdAt: 0, updatedAt: 0 }, seq: 0, nodes, comments: [] });
  return r;
};

describe("the WebAssembly boundary", () => {
  it("checks attributes with the server's rules", () => {
    const safe = (name: string, value: string) => designModel().isSafeAttr(name, value);
    expect(safe("href", "https://example.com")).toBe(true);
    expect(safe("onclick", "x")).toBe(false);
    expect(safe("href", "java\tscript:alert(1)")).toBe(false);
    // The case that once got through: SVG animation sets `href` from a list.
    expect(safe("values", "0;javascript:alert(1)")).toBe(false);
    // Both arguments arrive intact when the first one isn't ASCII.
    expect(safe("tïtle", "javascript:x")).toBe(false);
    expect(safe("tïtle", "ok")).toBe(true);
  });

  it("passes long text that isn't ASCII both ways", () => {
    // Three bytes per character in UTF-8, so the input buffer has to grow
    // past its first guess of one byte each, and memory grows with it.
    const long = "日本語ü👋".repeat(200_000);
    const r = load([board, text("t", "a", long)]);
    expect(r.exportHtml("a")).toBe(`<p>${long}</p>`);
    r.apply({ op: "set", id: "t", key: "text", value: `${long}!` });
    expect(r.get("t")?.text).toBe(`${long}!`);
  });

  it("turns a bad input into an error and keeps going", () => {
    const r = load([board]);
    // A create without its node: the Rust side refuses the JSON.
    expect(() => r.apply({ op: "create" } as never)).toThrow(/finite\.wasm: missing field `node`/);
    expect(r.apply({ op: "set", id: "a", key: "name", value: "Board" })?.op).toBe("set");
  });

  it("frees a document", () => {
    const r = load([board]);
    r.free();
    expect(() => r.exportHtml("a")).toThrow(/no replica/);
  });
});
