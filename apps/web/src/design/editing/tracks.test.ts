import { describe, expect, it } from "vite-plus/test";
import { parseTrack, trackLabel, tracksOf, tracksValue } from "./tracks";

describe("grid tracks", () => {
  it("lists tracks, repeats expanded", () => {
    expect(tracksOf("200px 1fr auto")).toEqual(["200px", "1fr", "auto"]);
    expect(tracksOf("repeat(3, minmax(0, 1fr))")).toEqual([
      "minmax(0, 1fr)",
      "minmax(0, 1fr)",
      "minmax(0, 1fr)",
    ]);
    expect(tracksOf("none")).toEqual([]);
    expect(tracksOf("repeat(auto-fill, minmax(100px, 1fr))")).toBeNull();
    expect(tracksOf("[a] 1fr [b]")).toBeNull();
  });

  it("writes equal tracks as a repeat", () => {
    expect(tracksValue(["1fr", "1fr", "1fr"])).toBe("repeat(3, 1fr)");
    expect(tracksValue(["120px", "1fr"])).toBe("120px 1fr");
    expect(tracksValue(["1fr"])).toBe("1fr");
    expect(tracksValue([])).toBeNull();
  });

  it("shows tracks without CSS", () => {
    expect(trackLabel("200px")).toBe("200");
    expect(trackLabel("minmax(0, 1fr)")).toBe("1fr");
    expect(trackLabel("minmax(100px, 1fr)")).toBe("100–1fr");
    expect(parseTrack("120")).toBe("120px");
    expect(parseTrack("2fr")).toBe("2fr");
    expect(parseTrack(" ")).toBeNull();
  });
});
