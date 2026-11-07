import { describe, expect, it } from "vite-plus/test";
import { createUndoOrder } from "./undoOrder";

describe("undo order", () => {
  it("undoes the last action of either kind, and redoes in reverse", () => {
    const order = createUndoOrder();
    order.did({ kind: "source" });
    order.did({ kind: "canvas", canvasId: "c1" });
    order.did({ kind: "source" });
    expect(order.undo()).toEqual({ kind: "source" });
    expect(order.undo()).toEqual({ kind: "canvas", canvasId: "c1" });
    expect(order.redo()).toEqual({ kind: "canvas", canvasId: "c1" });
    expect(order.undo()).toEqual({ kind: "canvas", canvasId: "c1" });
    expect(order.undo()).toEqual({ kind: "source" });
    expect(order.undo()).toBeUndefined();
  });

  it("forgets the redo side after a new action", () => {
    const order = createUndoOrder();
    order.did({ kind: "canvas", canvasId: "c1" });
    order.undo();
    order.did({ kind: "source" });
    expect(order.redo()).toBeUndefined();
    expect(order.undo()).toEqual({ kind: "source" });
  });
});
