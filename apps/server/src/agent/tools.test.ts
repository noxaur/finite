import { describe, expect, it } from "vite-plus/test";
import type { Canvas, OpenDesign } from "@finite/protocol";
import { figureView, type Measured, type Screenshots } from "./screenshot.ts";
import { canvasOps, DEFAULT_SIZE, frameSize, measureContent, MIN_HUG } from "./tools.ts";

describe("frameSize", () => {
  const measured = (size: { width: number; height: number }) => {
    const asked: (number | undefined)[] = [];
    const measure = async (width: number | undefined) => {
      asked.push(width);
      return size;
    };
    return { asked, measure };
  };

  it("gives a component its natural size, but never below the minimum", async () => {
    const card = measured({ width: 384, height: 452 });
    expect(await frameSize({}, card.measure)).toEqual({ width: 384, height: 452 });
    expect(card.asked).toEqual([undefined]);
    const button = measured({ width: 120, height: 40 });
    expect(await frameSize({}, button.measure)).toEqual(MIN_HUG);
  });

  it("keeps a page's width and measures its height at that width", async () => {
    const page = measured({ width: 1440, height: 2100 });
    expect(await frameSize({ width: 1440 }, page.measure)).toEqual({ width: 1440, height: 2100 });
    expect(page.asked).toEqual([1440]);
  });

  it("uses a given size as is, and a default when measuring fails", async () => {
    const never = measured({ width: 1, height: 1 });
    expect(await frameSize({ width: 800, height: 600 }, never.measure)).toEqual({
      width: 800,
      height: 600,
    });
    expect(never.asked).toEqual([]);
    const fail = async () => {
      throw new Error("no Chrome");
    };
    expect(await frameSize({}, fail)).toEqual(DEFAULT_SIZE);
    expect(await frameSize({ width: 390 }, fail)).toEqual({
      width: 390,
      height: DEFAULT_SIZE.height,
    });
  });
});

describe("figureView", () => {
  const page = { width: 1000, height: 800 };

  it("crops the union of the boxes, 40px out", () => {
    const { crop } = figureView(
      [
        { x: 100, y: 100, width: 50, height: 50 },
        { x: 300, y: 200, width: 50, height: 50 },
      ],
      page,
    );
    expect(crop).toEqual({ x: 60, y: 60, width: 330, height: 230 });
  });

  it("clamps the crop to the page", () => {
    const { crop } = figureView([{ x: 0, y: 0, width: 1000, height: 800 }], page);
    expect(crop).toEqual({ x: 0, y: 0, width: 1000, height: 800 });
    const corner = figureView([{ x: 950, y: 760, width: 50, height: 40 }], page).crop;
    expect(corner).toEqual({ x: 910, y: 720, width: 90, height: 80 });
  });

  it("zooms a small crop in, up to 3, and a large one out, down to 0.5", () => {
    const small = figureView([{ x: 100, y: 100, width: 20, height: 20 }], page);
    expect(small.zoom).toBe(3);
    expect(small.scale).toBe(6);
    const big = figureView([{ x: 0, y: 0, width: 4000, height: 3000 }], {
      width: 4000,
      height: 3000,
    });
    expect(big.zoom).toBe(0.5);
    const mid = figureView([{ x: 0, y: 0, width: 1000, height: 800 }], page).zoom;
    expect(mid).toBeCloseTo(0.784, 2);
  });
});

describe("canvasOps measure", () => {
  const frame = {
    id: "f1",
    name: "Card",
    x: 0,
    y: 0,
    width: 300,
    height: 200,
    source: { kind: "file", file: "a.tsx" },
  };
  const element = {
    tag: "h1",
    name: "h1",
    index: 0,
    count: 2,
    box: { x: 0, y: 0, width: 10, height: 10 },
  } as Measured["element"];

  function ops(result: Awaited<ReturnType<Screenshots["measureElement"]>>) {
    const open = {
      design: { id: "d1" },
      canvases: async () => [{ id: "c1", frames: [frame] } as unknown as Canvas],
    } as unknown as OpenDesign;
    return canvasOps({
      open,
      actor: { kind: "agent", id: "a", name: "A" } as never,
      previews: { ensure: async () => {}, frameUrl: () => "http://frame" } as never,
      source: {} as never,
      screenshots: { measureElement: async () => result } as never,
    });
  }

  it("returns the report and the PNG as two content parts", async () => {
    const got = await ops({ element, png: new Uint8Array([1]) }).measure({
      frameId: "f1",
      select: "h1",
    });
    expect(got.report).toMatchObject({
      element: { tag: "h1" },
      note: "2 elements match h1. Pass index for another.",
    });
    expect(measureContent(got).map((c) => c.type)).toEqual(["text", "image"]);
  });

  it("refuses a missing match by naming read_canvas", async () => {
    await expect(ops({ missing: ".x" }).measure({ frameId: "f1", select: ".x" })).rejects.toThrow(
      /matches nothing in Card\. Call read_canvas/,
    );
  });

  it("refuses an index out of range with how many there are", async () => {
    await expect(
      ops({ count: 2 }).measure({ frameId: "f1", select: "h1", index: 4 }),
    ).rejects.toThrow(/matches 2 elements.*index 4 is out of range/);
  });
});
