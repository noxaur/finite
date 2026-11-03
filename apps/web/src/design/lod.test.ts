import { describe, expect, it } from "vite-plus/test";
import {
  BITMAP_BELOW,
  bitmapScale,
  bitmapSvg,
  evictionPlan,
  LIVE_ABOVE,
  MIN_INTERVAL_MS,
  PAUSE_MS,
  rebuildDelay,
  wantsBitmaps,
} from "./lod";

describe("wantsBitmaps", () => {
  it("switches to bitmaps below the threshold and back to live DOM above a higher one", () => {
    expect(wantsBitmaps(BITMAP_BELOW - 0.01, false)).toBe(true);
    expect(wantsBitmaps(BITMAP_BELOW, false)).toBe(false);
    expect(wantsBitmaps(LIVE_ABOVE - 0.01, true)).toBe(true);
    expect(wantsBitmaps(LIVE_ABOVE, true)).toBe(false);
  });

  it("holds its state between the two thresholds, so hovering at the line doesn't flip", () => {
    const between = (BITMAP_BELOW + LIVE_ABOVE) / 2;
    expect(wantsBitmaps(between, false)).toBe(false);
    expect(wantsBitmaps(between, true)).toBe(true);
  });
});

describe("bitmapScale", () => {
  it("draws about one bitmap pixel per screen pixel at the zoom it's asked for", () => {
    for (const zoom of [0.02, 0.1, 0.25]) {
      const scale = bitmapScale(800, 1000, 1, zoom);
      expect(scale).toBeGreaterThanOrEqual(zoom);
      expect(scale).toBeLessThan(zoom * 1.5);
    }
  });

  it("draws more pixels on a denser screen", () => {
    expect(bitmapScale(800, 1000, 2, 0.1)).toBeGreaterThan(bitmapScale(800, 1000, 1, 0.1));
  });

  it("keeps one scale across a small zoom change", () => {
    expect(bitmapScale(800, 1000, 1, 0.1)).toBe(bitmapScale(800, 1000, 1, 0.105));
  });

  it("stops at the highest zoom a bitmap is shown at, and never draws larger than the artboard", () => {
    expect(bitmapScale(800, 1000, 1, 5)).toBe(bitmapScale(800, 1000, 1, LIVE_ABOVE));
    expect(bitmapScale(800, 1000, 1, 5)).toBeLessThan(LIVE_ABOVE * 1.5);
    expect(bitmapScale(800, 1000, 10, 1)).toBe(1);
  });

  it("draws a huge artboard at a lower resolution to cap its pixels and side", () => {
    const scale = bitmapScale(2000, 400_000, 2, LIVE_ABOVE);
    expect(2000 * scale * (400_000 * scale)).toBeLessThanOrEqual(16_000_000);
    expect(400_000 * scale).toBeLessThanOrEqual(8192);
  });
});

describe("rebuildDelay", () => {
  it("waits for a pause after an edit", () => {
    expect(rebuildDelay(10_000, 0)).toBe(PAUSE_MS);
  });

  it("spaces rebuilds of an artboard that keeps changing", () => {
    expect(rebuildDelay(10_000, 9_500)).toBe(MIN_INTERVAL_MS - 500);
  });
});

describe("bitmapSvg", () => {
  it("wraps markup in a foreignObject the size of the artboard", () => {
    const svg = bitmapSvg("<p>hi</p>", "p{color:red}", 800.4, 600.6);
    expect(svg).toContain('width="800" height="601"');
    expect(svg).toContain("<foreignObject");
    expect(svg).toContain("<p>hi</p>");
  });

  it("keeps CSS from being read as markup", () => {
    const svg = bitmapSvg("", 'a[title="x&y"] > b { content: "<"; } ]]> c', 10, 10);
    const style = svg.slice(svg.indexOf("<style>") + 7, svg.indexOf("</style>"));
    // The text sits in CDATA, and the `]]>` inside it is split across two sections.
    expect(style.startsWith("<![CDATA[")).toBe(true);
    expect(style).toContain('a[title="x&y"] > b { content: "<"; } ]]]]><![CDATA[> c');
  });
});

describe("evictionPlan", () => {
  const at = (id: string, distance: number, pixels = 10) => ({ id, distance, pixels });

  it("drops nothing while the bitmaps fit", () => {
    expect(evictionPlan([at("a", 5), at("b", 9)], 20, 20)).toEqual([]);
  });

  it("drops the farthest first, and only as many as it takes", () => {
    const candidates = [at("near", 1), at("far", 9), at("mid", 5)];
    expect(evictionPlan(candidates, 30, 15)).toEqual(["far", "mid"]);
  });

  it("drops what it can when the ones that must stay are over budget", () => {
    expect(evictionPlan([at("a", 1)], 100, 10)).toEqual(["a"]);
    expect(evictionPlan([], 100, 10)).toEqual([]);
  });
});
