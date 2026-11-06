import { describe, expect, it } from "vite-plus/test";
import { cellOf } from "./cells";

describe("cellOf", () => {
  it("reads keywords either way round, and percentages x then y", () => {
    expect(cellOf("top left")).toEqual({ x: 0, y: 0 });
    expect(cellOf("left top")).toEqual({ x: 0, y: 0 });
    expect(cellOf("bottom")).toEqual({ x: 1, y: 2 });
    expect(cellOf("100% 50%")).toEqual({ x: 2, y: 1 });
    expect(cellOf("10px 20px")).toBeNull();
    expect(cellOf("left left")).toBeNull();
  });
});
