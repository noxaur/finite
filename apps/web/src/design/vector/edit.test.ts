import { describe, expect, it } from "vite-plus/test";
import {
  bendSegment,
  closeSub,
  deleteAnchors,
  hitTest,
  insertPoint,
  isEndpoint,
  joinEnds,
  joinPicked,
  moveAnchors,
  moveHandle,
  nearestSegment,
  pullHandles,
  setMode,
  snapAngle,
  toCorner,
} from "./edit";
import { parsePath, printPath } from "./path";

const smooth = () => parsePath("M0 0C0 10 10 10 20 10C30 10 40 10 40 0");

describe("moving", () => {
  it("carries an anchor's handles with it", () => {
    const moved = moveAnchors(smooth(), [{ sub: 0, i: 1 }], { x: 0, y: 5 });
    expect(printPath(moved)).toBe("M0 0C0 10 10 15 20 15C30 15 40 10 40 0");
  });

  it("doesn't touch the paths it's given", () => {
    const start = smooth();
    moveAnchors(start, [{ sub: 0, i: 1 }], { x: 9, y: 9 });
    expect(printPath(start)).toBe(printPath(smooth()));
  });
});

describe("handles follow the mode geometry gives", () => {
  const ref = { sub: 0, i: 1 };

  it("mirrors angle and length", () => {
    const [s] = moveHandle(smooth(), ref, "out", { x: 25, y: 20 }, false);
    const a = s!.anchors[1]!;
    expect(a.mode).toBe("mirror");
    expect(a.in).toEqual({ x: 15, y: 0 });
  });

  it("mirrors only the angle when the lengths differ", () => {
    const paths = parsePath("M0 0C0 10 15 10 20 10C40 10 40 10 40 0");
    expect(paths[0]!.anchors[1]!.mode).toBe("angle");
    const [s] = moveHandle(paths, ref, "out", { x: 20, y: 30 }, false);
    const a = s!.anchors[1]!;
    expect(a.in!.x).toBeCloseTo(20);
    expect(a.in!.y).toBeCloseTo(5);
  });

  it("leaves the other handle alone with no mirroring, and Alt breaks a mirror", () => {
    const free = parsePath("M0 0C0 10 15 12 20 10C40 10 40 10 40 0");
    expect(free[0]!.anchors[1]!.mode).toBe("none");
    const [s] = moveHandle(free, ref, "out", { x: 30, y: 30 }, false);
    expect(s!.anchors[1]!.in).toEqual({ x: 15, y: 12 });
    const [broken] = moveHandle(smooth(), ref, "out", { x: 25, y: 20 }, true);
    expect(broken!.anchors[1]!.in).toEqual({ x: 10, y: 10 });
    expect(broken!.anchors[1]!.mode).toBe("none");
  });

  it("sets a mode, giving a corner handles along its neighbours", () => {
    const paths = parsePath("M0 0L20 0L40 0");
    const [s] = setMode(paths, ref, "mirror");
    const a = s!.anchors[1]!;
    expect(a.mode).toBe("mirror");
    expect(a.out!.x).toBeCloseTo(26.67, 1);
    expect(a.in!.x).toBeCloseTo(13.33, 1);
  });

  it("sets mirror on uneven handles by the out handle", () => {
    const paths = parsePath("M0 0C0 10 15 10 20 10C40 10 40 10 40 0");
    const [s] = setMode(paths, ref, "mirror");
    expect(s!.anchors[1]!.in).toEqual({ x: 0, y: 10 });
  });

  it("pulls handles out of a corner, and takes them back", () => {
    const paths = parsePath("M0 0L10 0L20 0");
    const pulled = pullHandles(paths, ref, { x: 15, y: 5 });
    expect(pulled[0]!.anchors[1]!.in).toEqual({ x: 5, y: -5 });
    expect(toCorner(pulled, ref)[0]!.anchors[1]!.out).toBeNull();
  });
});

describe("segments", () => {
  it("finds the nearest point on a line and on a curve", () => {
    const near = nearestSegment(parsePath("M0 0L10 0"), { x: 5, y: 3 })!;
    expect(near.t).toBeCloseTo(0.5);
    expect(near.distance).toBeCloseTo(3);
    const curve = nearestSegment(smooth(), { x: 20, y: 11 })!;
    expect(curve.distance).toBeLessThan(1.1);
  });

  it("bends so the pressed point follows the pointer", () => {
    const paths = parsePath("M0 0L30 0");
    const bent = bendSegment(paths, { sub: 0, i: 0 }, 0.5, { x: 15, y: 12 });
    const on = nearestSegment(bent, { x: 15, y: 12 })!;
    expect(on.distance).toBeLessThan(0.05);
    expect(bent[0]!.anchors[0]!.out).not.toBeNull();
  });

  it("keeps a smooth anchor smooth while bending next to it", () => {
    const bent = bendSegment(smooth(), { sub: 0, i: 0 }, 0.5, { x: 20, y: 30 });
    const a = bent[0]!.anchors[1]!;
    expect(a.in!.x - a.p.x).toBeCloseTo(a.p.x - a.out!.x);
    expect(a.in!.y - a.p.y).toBeCloseTo(a.p.y - a.out!.y);
  });
});

describe("adding and deleting points", () => {
  it("adds a point on a straight segment", () => {
    const { paths, ref } = insertPoint(parsePath("M0 0L10 0"), { sub: 0, i: 0 }, 0.25);
    expect(printPath(paths)).toBe("M0 0L2.5 0L10 0");
    expect(ref).toEqual({ sub: 0, i: 1 });
  });

  it("adds a point on a curve without changing the curve", () => {
    const before = parsePath("M0 0C0 20 20 20 20 0");
    const { paths } = insertPoint(before, { sub: 0, i: 0 }, 0.5);
    expect(paths[0]!.anchors[1]!.p).toEqual({ x: 10, y: 15 });
    expect(paths[0]!.anchors[1]!.mode).toBe("mirror");
    // The original curve's point at t = 0.25 is still on the split curve.
    expect(nearestSegment(paths, { x: 3.125, y: 11.25 })!.distance).toBeLessThan(0.01);
  });

  it("deletes a point and joins its neighbours", () => {
    const paths = parsePath("M0 0L10 0L20 0");
    expect(printPath(deleteAnchors(paths, [{ sub: 0, i: 1 }]))).toBe("M0 0L20 0");
  });

  it("drops an end's outward handle when an end is deleted", () => {
    const after = deleteAnchors(smooth(), [{ sub: 0, i: 0 }]);
    expect(after[0]!.anchors[0]!.in).toBeNull();
    expect(printPath(after)).toBe("M20 10C30 10 40 10 40 0");
  });

  it("removes a path left with too few points", () => {
    const paths = parsePath("M0 0L10 0ZM5 5L6 6");
    expect(deleteAnchors(paths, [{ sub: 1, i: 0 }]).length).toBe(1);
  });
});

describe("joining and closing", () => {
  it("knows an open path's ends", () => {
    const [open] = parsePath("M0 0L1 0L2 0");
    expect(isEndpoint(open!, 0)).toBe(true);
    expect(isEndpoint(open!, 1)).toBe(false);
    expect(isEndpoint(parsePath("M0 0L1 0L2 0Z")[0]!, 0)).toBe(false);
  });

  it("closes an open path", () => {
    expect(printPath(closeSub(parsePath("M0 0L10 0L10 10"), 0))).toBe("M0 0L10 0L10 10Z");
  });

  it("closes onto one anchor when the ends meet", () => {
    const closed = closeSub(parsePath("M0 0L10 0L10 10L0 0"), 0);
    expect(closed[0]!.anchors.length).toBe(3);
    expect(printPath(closed)).toBe("M0 0L10 0L10 10Z");
  });

  it("joins two paths end to start with a straight segment", () => {
    const joined = joinEnds(parsePath("M0 0L10 0M20 0L30 0"), { sub: 0, i: 1 }, { sub: 1, i: 0 });
    expect(printPath(joined!)).toBe("M0 0L10 0L20 0L30 0");
  });

  it("merges ends that meet, reversing a path if it has to", () => {
    const joined = joinEnds(parsePath("M0 0L10 0M30 0L10 0"), { sub: 0, i: 1 }, { sub: 1, i: 1 });
    expect(printPath(joined!)).toBe("M0 0L10 0L30 0");
  });

  it("refuses points that aren't ends, and closed paths", () => {
    const paths = parsePath("M0 0L1 0L2 0M5 5L6 6");
    expect(joinEnds(paths, { sub: 0, i: 1 }, { sub: 1, i: 0 })).toBeNull();
    expect(joinPicked(parsePath("M0 0L1 0L2 0Z"), [{ sub: 0, i: 0 }])).toBeNull();
  });

  it("closes the picked end's path, and joins two picked ends", () => {
    const open = parsePath("M0 0L1 0L2 2");
    expect(printPath(joinPicked(open, [{ sub: 0, i: 0 }])!)).toBe("M0 0L1 0L2 2Z");
    expect(
      printPath(
        joinPicked(open, [
          { sub: 0, i: 0 },
          { sub: 0, i: 2 },
        ])!,
      ),
    ).toBe("M0 0L1 0L2 2Z");
  });
});

describe("hit testing", () => {
  const paths = smooth();

  it("prefers a shown handle over an anchor over a segment", () => {
    const picked = [{ sub: 0, i: 1 }];
    expect(hitTest(paths, picked, { x: 10, y: 10 }, 2)).toEqual({
      kind: "handle",
      ref: { sub: 0, i: 1 },
      which: "in",
    });
    expect(hitTest(paths, [], { x: 10, y: 10 }, 2)?.kind).toBe("segment");
    expect(hitTest(paths, [], { x: 20, y: 10 }, 2)?.kind).toBe("anchor");
    expect(hitTest(paths, [], { x: 100, y: 100 }, 2)).toBeNull();
  });
});

describe("snapping", () => {
  it("lands on the nearest 45 degrees", () => {
    const p = snapAngle({ x: 0, y: 0 }, { x: 10, y: 9 });
    expect(p.x).toBeCloseTo(p.y);
  });
});
