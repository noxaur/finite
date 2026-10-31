import { describe, expect, it } from "vite-plus/test";
import type { DesignSummary } from "@/design/schema";
import { LOBBY_LIMIT, mergeLobby } from "./lobby";

const summary = (id: string, updatedAt: number): DesignSummary => ({
  id,
  name: id,
  createdAt: 0,
  updatedAt,
  seq: 0,
  artboardCount: 0,
  nodeCount: 0,
});

describe("mergeLobby", () => {
  it("moves a changed design to the front", () => {
    const list = [summary("a", 2), summary("b", 1)];
    const { designs, trimmed } = mergeLobby(list, summary("b", 3));
    expect(designs.map((d) => d.id)).toEqual(["b", "a"]);
    expect(trimmed).toBe(false);
  });

  it("keeps at most LOBBY_LIMIT designs", () => {
    let designs: ReadonlyArray<DesignSummary> = [];
    let trimmed = false;
    for (let i = 0; i < LOBBY_LIMIT + 50; i++) {
      ({ designs, trimmed } = mergeLobby(designs, summary(`d${i}`, i)));
    }
    expect(designs).toHaveLength(LOBBY_LIMIT);
    expect(designs[0]?.id).toBe(`d${LOBBY_LIMIT + 49}`);
    expect(trimmed).toBe(true);
  });
});
