import { describe, expect, it } from "vite-plus/test";
import {
  boxBetween,
  clampInside,
  contains,
  freeName,
  gaps,
  membersOf,
  movedWith,
  rounded,
} from "./objects";

const frame = (id: string, x: number, y: number, width = 100, height = 80) => ({
  id,
  x,
  y,
  width,
  height,
});
const text = (id: string, x: number, y: number) => ({ id, x, y, width: 100 });

describe("membersOf", () => {
  const section = { x: 0, y: 0, width: 400, height: 300 };

  it("takes the frames wholly inside, and a frame half outside stays", () => {
    const { frameIds } = membersOf(
      section,
      [frame("in", 20, 150), frame("edge", 350, 150), frame("out", 900, 150)],
      [],
    );
    expect(frameIds).toEqual(["in"]);
  });

  it("takes a member's label, even above the section's top edge, and leaves another frame's", () => {
    const frames = [frame("in", 20, 150), frame("away", 800, 150)];
    // The server writes a label 120 above its frame.
    const labels = [text("mine", 20, 30), text("theirs", 800, 30)];
    expect(membersOf(section, frames, labels).textIds).toEqual(["mine"]);
    // A label above a member frame belongs to it, though its corner is outside the section.
    const high = membersOf(
      { ...section, y: 100, height: 200 },
      [frame("in", 20, 150)],
      [text("l", 20, 30)],
    );
    expect(high.textIds).toEqual(["l"]);
  });

  it("takes a free label whose corner is inside", () => {
    const { textIds } = membersOf(section, [], [text("free", 200, 280), text("far", 200, 900)]);
    expect(textIds).toEqual(["free"]);
  });
});

describe("object boxes", () => {
  it("knows containment", () => {
    expect(
      contains({ x: 0, y: 0, width: 10, height: 10 }, { x: 0, y: 0, width: 10, height: 10 }),
    ).toBe(true);
    expect(
      contains({ x: 0, y: 0, width: 10, height: 10 }, { x: 5, y: 5, width: 6, height: 2 }),
    ).toBe(false);
  });

  it("names the next free section", () => {
    expect(freeName([], "Section")).toBe("Section 1");
    expect(freeName(["Section 1", "Section 3", "Flow"], "Section")).toBe("Section 2");
  });

  it("keeps a slice inside its frame", () => {
    const bounds = { width: 300, height: 200 };
    expect(clampInside({ x: -20, y: 190, width: 100, height: 50 }, bounds)).toEqual({
      x: 0,
      y: 150,
      width: 100,
      height: 50,
    });
    expect(clampInside({ x: 250, y: 0, width: 100, height: 10 }, bounds)).toEqual({
      x: 200,
      y: 0,
      width: 100,
      height: 24,
    });
    expect(clampInside({ x: 0, y: 0, width: 900, height: 900 }, bounds)).toEqual({
      x: 0,
      y: 0,
      width: 300,
      height: 200,
    });
  });

  it("draws a box from any corner and rounds to whole units", () => {
    expect(boxBetween({ x: 50.4, y: 80 }, { x: 10, y: 20.6 })).toEqual({
      x: 10,
      y: 21,
      width: 40,
      height: 59,
    });
    expect(rounded({ x: 0.4, y: 0.6, width: 10.4, height: 0.1 })).toEqual({
      x: 0,
      y: 1,
      width: 11,
      height: 1,
    });
  });
});

describe("gaps", () => {
  const box = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });

  it("gives the four insets of a nested box, skipping a zero one", () => {
    const g = gaps(box(0, 0, 200, 100), box(10, 20, 100, 40));
    expect(g.map((x) => x.label)).toEqual(["10", "90", "20", "40"]);
    const flush = gaps(box(0, 0, 200, 100), box(0, 20, 100, 40));
    expect(flush.map((x) => x.label)).toEqual(["100", "20", "40"]);
  });

  it("measures the same either way round", () => {
    const outer = box(0, 0, 200, 100);
    const inner = box(10, 20, 100, 40);
    expect(gaps(inner, outer)).toEqual(gaps(outer, inner));
  });

  it("gives one gap along the axis the boxes are apart on, at the middle of their overlap", () => {
    const [g, ...rest] = gaps(box(0, 0, 100, 100), box(150, 40, 50, 100));
    expect(rest).toEqual([]);
    expect(g).toEqual({ a: { x: 100, y: 70 }, b: { x: 150, y: 70 }, label: "50" });
  });

  it("gives both gaps for boxes apart on both axes", () => {
    const g = gaps(box(0, 0, 10, 10), box(30, 25, 10, 10));
    expect(g.map((x) => x.label)).toEqual(["20", "15"]);
  });

  it("gives none for boxes that overlap without nesting", () => {
    expect(gaps(box(0, 0, 100, 100), box(50, 50, 100, 100))).toEqual([]);
  });
});

describe("movedWith", () => {
  it("moves the section and every member by the same whole step", () => {
    const moved = movedWith(
      { x: 10, y: 10, width: 400, height: 300 },
      [{ id: "f", x: 20, y: 50 }],
      [{ id: "t", x: 20, y: 5 }],
      { x: 30.6, y: -9.4 },
    );
    expect(moved).toEqual({
      x: 41,
      y: 1,
      frames: [{ id: "f", x: 51, y: 41 }],
      texts: [{ id: "t", x: 51, y: -4 }],
    });
  });
});
