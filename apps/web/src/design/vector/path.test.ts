import { describe, expect, it } from "vite-plus/test";
import { deleteAnchors, moveAnchors } from "./edit";
import { boundsOf, deriveMode, parsePath, printPath, reframe, type SubPath } from "./path";

describe("parsePath and printPath", () => {
  it("round-trips absolute paths", () => {
    const d = "M0 0L10 0L10 10Z";
    expect(printPath(parsePath(d))).toBe(d);
  });

  it("reads relative, implicit, H, V and S commands", () => {
    expect(printPath(parsePath("m1 1 2 0 h3 v4 l1 1"))).toBe("M1 1L3 1L6 1L6 5L7 6");
    expect(printPath(parsePath("M0 0C0 10 10 10 10 0S20 -10 20 0"))).toBe(
      "M0 0C0 10 10 10 10 0C10 -10 20 -10 20 0",
    );
  });

  it("turns a quadratic and an arc into cubics", () => {
    expect(printPath(parsePath("M0 0Q10 10 20 0"))).toBe("M0 0C6.67 6.67 13.33 6.67 20 0");
    const arc = parsePath("M0 0A5 5 0 0 1 10 0");
    expect(arc[0]!.anchors.at(-1)!.p).toEqual({ x: 10, y: 0 });
    expect(arc[0]!.anchors.length).toBe(3);
    expect(printPath(parsePath("M0 0a5 5 0 00 10 0"))).toBe(
      printPath(parsePath("M0 0a5 5 0 0 0 10 0")),
    );
  });

  it("makes one anchor of a closed path's meeting ends", () => {
    const [s] = parsePath("M0 0C5 0 10 5 10 10L0 10L0 0Z");
    expect(s!.closed).toBe(true);
    expect(s!.anchors.length).toBe(3);
    expect(printPath(parsePath(printPath([s!])))).toBe(printPath([s!]));
  });

  it("keeps several subpaths and drops lone moves", () => {
    expect(parsePath("M0 0L1 1ZM5 5M6 6L7 7").length).toBe(2);
  });

  it("refuses what isn't a path", () => {
    expect(() => parsePath("M0 0Lx")).toThrow();
  });
});

describe("handle modes come from geometry", () => {
  const p = { x: 0, y: 0 };

  it("reads collinear equal handles as mirrored by length", () => {
    expect(deriveMode({ p, in: { x: -5, y: 0 }, out: { x: 5, y: 0 } })).toBe("mirror");
  });
  it("reads collinear uneven handles as mirrored by angle", () => {
    expect(deriveMode({ p, in: { x: -2, y: 0 }, out: { x: 8, y: 0 } })).toBe("angle");
  });
  it("reads anything else as free", () => {
    expect(deriveMode({ p, in: { x: 2, y: 3 }, out: { x: 8, y: 0 } })).toBe("none");
    expect(deriveMode({ p, in: null, out: { x: 8, y: 0 } })).toBe("none");
  });

  it("derives on parse", () => {
    const [s] = parsePath("M0 0C5 0 10 5 10 10C10 15 15 20 20 20");
    expect(s!.anchors[1]!.mode).toBe("mirror");
  });
});

describe("reframe", () => {
  it("finds the curve's real extent, not its control points'", () => {
    const b = boundsOf(parsePath("M0 0C0 20 20 20 20 0"))!;
    expect(b.height).toBeCloseTo(15, 1);
  });

  it("measures from a whole-pixel box and is never empty", () => {
    const line = parsePath("M10.5 20L30.5 20");
    const out = reframe(line);
    expect(out.box).toEqual({ x: 10, y: 20, width: 21, height: 1 });
    expect(out.d).toBe("M0.5 0L20.5 0");
    expect(out.viewBox).toBe("0 0 21 1");
  });
});

describe("geometry that has to survive a round trip", () => {
  it("keeps a closed cubic loop whose ends meet in one anchor", () => {
    const d = "M0 0C100 0 100 100 0 0ZM200 0L300 0";
    expect(printPath(parsePath(d))).toBe(d);
  });

  it("keeps a near-complete arc, omitting only one with identical endpoints", () => {
    const paths = parsePath("M0 0A100 100 0 1 1 0.0001 0M200 0L300 0");
    expect(paths).toHaveLength(2);
    expect(paths[0]!.anchors.length).toBeGreaterThan(2);
    expect(parsePath("M5 5A100 100 0 1 1 5 5L9 9")[0]!.anchors).toHaveLength(2);
  });

  it("resets the reflected control point after an arc that adds no segment", () => {
    expect(printPath(parsePath("M0 0C0 10 10 10 10 0A5 5 0 0 1 10 0S20 10 20 0"))).toBe(
      "M0 0C0 10 10 10 10 0C10 0 20 10 20 0",
    );
  });

  it("picks decimals from the path's extent", () => {
    expect(printPath(parsePath("M0 0L0.003 0.003"))).toBe("M0 0L0.003 0.003");
    expect(printPath(parsePath("M10.5 20L30.25 40.123"))).toBe("M10.5 20L30.25 40.12");
    expect(printPath(parsePath("M0 0L24 24.126"))).toBe("M0 0L24 24.13");
  });

  it("doesn't merge a small path's ends just because they're close", () => {
    const d = "M0 0L0.003 0L0.0005 0.0005Z";
    expect(printPath(parsePath(d))).toBe(d);
  });

  const points = (s: SubPath) =>
    s.anchors.flatMap((a) => [a.p, a.in, a.out].filter((p) => p !== null));
  const extent = (s: SubPath) => {
    const all = points(s);
    return Math.max(
      Math.max(...all.map((p) => p.x)) - Math.min(...all.map((p) => p.x)),
      Math.max(...all.map((p) => p.y)) - Math.min(...all.map((p) => p.y)),
    );
  };
  const expectSame = (a: SubPath, b: SubPath) => {
    const close = extent(a) / 1000;
    const [pa, pb] = [points(a), points(b)];
    expect(a.closed).toBe(b.closed);
    expect(pb).toHaveLength(pa.length);
    pa.forEach((p, i) => {
      expect(Math.abs(p.x - pb[i]!.x)).toBeLessThanOrEqual(close);
      expect(Math.abs(p.y - pb[i]!.y)).toBeLessThanOrEqual(close);
    });
  };

  const INPUTS = [
    "M0 0C100 0 100 100 0 0ZM200 0L300 0",
    "M0 0A100 100 0 1 1 0.0001 0M200 0L300 0",
    "M0 0C0 10 10 10 10 0A5 5 0 0 1 10 0S20 10 20 0M200 0L300 0",
    "M0 0L0.003 0.003M200 0L300 0",
  ];
  const EDITS: Array<[string, (paths: SubPath[], sub: number) => SubPath[]]> = [
    ["moving a point", (paths, sub) => moveAnchors(paths, [{ sub, i: 0 }], { x: 1, y: 1 })],
    ["deleting a point", (paths, sub) => deleteAnchors(paths, [{ sub, i: 0 }])],
  ];

  for (const d of INPUTS) {
    for (const [name, edit] of EDITS) {
      it(`${name} leaves the other subpaths of ${d} alone`, () => {
        const original = parsePath(d);
        expect(original).toHaveLength(2);
        for (const edited of [0, 1]) {
          const others = original.filter((_, i) => i !== edited);
          const after = edit(original, edited);
          const parsed = parsePath(printPath(after));
          const kept =
            after.length === original.length ? parsed.filter((_, i) => i !== edited) : parsed;
          expect(kept).toHaveLength(others.length);
          others.forEach((s, i) => expectSame(s, kept[i]!));
        }
      });
    }
  }
});
