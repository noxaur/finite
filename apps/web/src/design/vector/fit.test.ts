import { describe, expect, it } from "vite-plus/test";
import { fitStroke } from "./fit";
import { nearestSegment } from "./edit";

describe("fitStroke", () => {
  it("fits a smooth stroke with few anchors, within the tolerance", () => {
    const points = Array.from({ length: 200 }, (_, i) => {
      const a = (i / 199) * Math.PI;
      return { x: 100 * Math.cos(a), y: 100 * Math.sin(a) };
    });
    const stroke = fitStroke(points, 1);
    expect(stroke.anchors.length).toBeLessThan(8);
    for (const p of points) {
      expect(nearestSegment([stroke], p)!.distance).toBeLessThan(1.5);
    }
  });

  it("keeps the ends of the stroke", () => {
    const stroke = fitStroke(
      [
        { x: 0, y: 0 },
        { x: 5, y: 1 },
        { x: 10, y: 0 },
      ],
      1,
    );
    expect(stroke.anchors[0]!.p).toEqual({ x: 0, y: 0 });
    expect(stroke.anchors.at(-1)!.p).toEqual({ x: 10, y: 0 });
  });

  it("ignores points repeated in place", () => {
    const p = { x: 3, y: 3 };
    expect(fitStroke([p, p, p], 1).anchors.length).toBe(1);
  });
});
