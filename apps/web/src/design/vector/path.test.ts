import { describe, expect, it } from "vite-plus/test";
import { boundsOf, deriveMode, parsePath, printPath, reframe } from "./path";

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
