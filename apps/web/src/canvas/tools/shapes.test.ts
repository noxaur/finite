import { describe, expect, it } from "vite-plus/test";
import {
  arrowPath,
  clickedSize,
  dragLine,
  linePath,
  padded,
  polygonPath,
  starPath,
} from "./shapes";

describe("dragging out a line", () => {
  const from = { x: 10, y: 10 };

  it("keeps the ends where the drag put them, in any direction", () => {
    expect(dragLine(from, { x: 60, y: 30 }, false, false)).toEqual({
      box: { x: 10, y: 10, width: 50, height: 20 },
      a: { x: 0, y: 0 },
      b: { x: 50, y: 20 },
    });
    expect(dragLine(from, { x: 0, y: 60 }, false, false)).toEqual({
      box: { x: 0, y: 10, width: 10, height: 50 },
      a: { x: 10, y: 0 },
      b: { x: 0, y: 50 },
    });
  });

  it("snaps to 45° steps with Shift", () => {
    const flat = dragLine(from, { x: 60, y: 12 }, true, false);
    expect(flat.a).toEqual({ x: 0, y: 0 });
    expect(flat.box.height).toBe(1);
    const diagonal = dragLine(from, { x: 61, y: 57 }, true, false);
    expect(diagonal.b.x).toBe(diagonal.b.y);
  });

  it("grows from the middle with Alt", () => {
    expect(dragLine(from, { x: 20, y: 10 }, false, true).box).toMatchObject({ x: 0, width: 20 });
  });

  it("gains room around it without moving", () => {
    expect(padded(dragLine(from, { x: 60, y: 10 }, false, false), 16)).toEqual({
      box: { x: -6, y: -6, width: 82, height: 33 },
      a: { x: 16, y: 16 },
      b: { x: 66, y: 16 },
    });
  });
});

describe("shape outlines", () => {
  const box = { x: 0, y: 0, width: 100, height: 100 };
  const values = (d: string) => (d.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);

  it("draws a line and an arrow from one end to the other", () => {
    expect(linePath({ a: { x: 0, y: 0 }, b: { x: 80, y: 0 } })).toBe("M0 0L80 0");
    const arrow = arrowPath({ a: { x: 0, y: 0 }, b: { x: 80, y: 0 } });
    expect(arrow.startsWith("M0 0L80 0M")).toBe(true);
    expect(arrow.match(/L80 0/g)).toHaveLength(2);
  });

  it("keeps a short arrow's head inside the line", () => {
    const [, , , , x] = values(arrowPath({ a: { x: 0, y: 0 }, b: { x: 10, y: 0 } }));
    expect(x).toBeCloseTo(5.67, 1);
  });

  it("touches every edge of the box", () => {
    for (const d of [polygonPath(box, 3), polygonPath(box, 6), starPath(box, 5, 0.382)]) {
      const nums = values(d);
      const xs = nums.filter((_, i) => i % 2 === 0);
      const ys = nums.filter((_, i) => i % 2 === 1);
      expect(Math.min(...xs)).toBe(0);
      expect(Math.max(...xs)).toBe(100);
      expect(Math.min(...ys)).toBe(0);
      expect(Math.max(...ys)).toBe(100);
      expect(d.endsWith("Z")).toBe(true);
    }
  });

  it("gives a star twice its points", () => {
    expect(values(starPath(box, 5, 0.382))).toHaveLength(20);
  });
});

describe("a clicked-in image", () => {
  it("keeps a small file's size", () => {
    expect(clickedSize({ width: 320, height: 200 })).toEqual({ width: 320, height: 200 });
  });
  it("brings a large one down, proportionally", () => {
    expect(clickedSize({ width: 3200, height: 1600 })).toEqual({ width: 640, height: 320 });
  });
  it("falls back when the file has no size of its own", () => {
    expect(clickedSize({ width: 0, height: 0 })).toEqual({ width: 100, height: 100 });
  });
});
