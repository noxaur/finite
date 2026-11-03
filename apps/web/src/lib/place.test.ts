import { describe, expect, it } from "vite-plus/test";
import { parsePlace } from "./place";

const view = { x: 0, y: 0, zoom: 1 };

describe("parsePlace", () => {
  it("reads a saved place", () => {
    const place = { page: "p1", views: { p1: { x: -120.5, y: 40, zoom: 0.75 }, p2: view } };
    expect(parsePlace(JSON.stringify(place))).toEqual(place);
  });

  it("keeps the first page as null", () => {
    expect(parsePlace(JSON.stringify({ page: null, views: {} }))).toEqual({
      page: null,
      views: {},
    });
  });

  it("drops a broken view and keeps the others", () => {
    const views = { p1: view, p2: { x: "0", y: 0, zoom: 1 }, p3: { ...view, zoom: 0 }, p4: null };
    expect(parsePlace(JSON.stringify({ page: "p1", views }))).toEqual({
      page: "p1",
      views: { p1: view },
    });
  });

  it("rejects missing and malformed places", () => {
    expect(parsePlace(null)).toBeNull();
    expect(parsePlace("not json")).toBeNull();
    expect(parsePlace("null")).toBeNull();
    expect(parsePlace(JSON.stringify({ page: 3, views: {} }))).toBeNull();
    expect(parsePlace(JSON.stringify({ page: null }))).toBeNull();
  });
});
