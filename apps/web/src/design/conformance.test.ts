import "./wasm.node";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { Replica } from "./replica";
import type { Node, Op } from "./schema";

// The op cases in crates/design/fixtures/apply.json, generated from the Rust
// rules in crates/design/src/document.rs. Replica runs those rules through
// WebAssembly and keeps its own cache of nodes and sibling order from what
// they report. This checks the cache ends up where the Rust document does.
interface Case {
  readonly name: string;
  readonly nodes: ReadonlyArray<Node>;
  readonly ops: ReadonlyArray<Op>;
  readonly expect: {
    readonly applied: ReadonlyArray<boolean>;
    readonly nodes: ReadonlyArray<Node>;
    readonly children: ReadonlyArray<readonly [string | null, ReadonlyArray<string>]>;
  };
}

const fixture = JSON.parse(
  readFileSync(new URL("../../../../crates/design/fixtures/apply.json", import.meta.url), "utf8"),
) as { readonly cases: ReadonlyArray<Case> };

const load = (nodes: ReadonlyArray<Node>) => {
  const replica = new Replica();
  replica.load({
    meta: { id: "d", name: "D", createdAt: 0, updatedAt: 0 },
    seq: 0,
    nodes,
    comments: [],
  });
  return replica;
};

/** The cache's view of the tree, in the fixture's shape. */
const snapshot = (replica: Replica) => ({
  nodes: [...replica.nodes.values()].sort((a, b) => (a.id < b.id ? -1 : 1)),
  children: [null, ...[...replica.nodes.keys()].sort()]
    .map((parent) => [parent, replica.children(parent).map((n) => n.id)] as const)
    .filter(([, ids]) => ids.length > 0),
});

describe("Replica follows the Rust op rules", () => {
  it.each(fixture.cases.map((c) => [c.name, c] as const))("%s, one op at a time", (_, c) => {
    const replica = load(c.nodes);
    const applied = c.ops.map((op) => replica.apply(op) !== null);
    expect(applied).toEqual(c.expect.applied);
    expect(snapshot(replica)).toEqual({ nodes: c.expect.nodes, children: c.expect.children });
  });

  it.each(fixture.cases.map((c) => [c.name, c] as const))("%s, as one change", (_, c) => {
    const replica = load(c.nodes);
    const applied = replica.applyAll(c.ops).map((a) => a !== null);
    expect(applied).toEqual(c.expect.applied);
    expect(snapshot(replica)).toEqual({ nodes: c.expect.nodes, children: c.expect.children });
  });
});
