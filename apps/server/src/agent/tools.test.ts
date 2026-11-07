import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_SIZE, frameSize, MIN_HUG } from "./tools.ts";

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
