import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { Replica } from "./replica";
import type { Node, Op } from "./schema";

// The op cases in crates/design/fixtures/apply.json, generated from the Rust
// rules in crates/design/src/document.rs. Replica must give the same results.
interface Case {
  readonly name: string;
  readonly nodes: ReadonlyArray<Node>;
  readonly ops: ReadonlyArray<Op>;
  readonly expect: {
    readonly applied: ReadonlyArray<boolean>;
    readonly nodes: ReadonlyArray<Node>;
  };
}

const fixture = JSON.parse(
  readFileSync(new URL("../../../../crates/design/fixtures/apply.json", import.meta.url), "utf8"),
) as { readonly cases: ReadonlyArray<Case> };

describe("Replica matches the Rust op rules", () => {
  it.each(fixture.cases.map((c) => [c.name, c] as const))("%s", (_, c) => {
    const replica = new Replica();
    replica.load({
      meta: { id: "d", name: "D", createdAt: 0, updatedAt: 0 },
      seq: 0,
      nodes: c.nodes,
      comments: [],
    });
    const applied = c.ops.map((op) => replica.apply(op) !== null);
    const nodes = [...replica.nodes.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
    expect(applied).toEqual(c.expect.applied);
    expect(nodes).toEqual(c.expect.nodes);
  });
});
