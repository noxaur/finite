import { describe, expect, it } from "vite-plus/test";
import { applyChange, PAGE_STORAGE_QUOTA, parseStorage } from "./pageStorage";

describe("parseStorage", () => {
  it("keeps string values and drops the rest", () => {
    expect(parseStorage('{"a":"1","b":2,"c":null}')).toEqual({ a: "1" });
    expect(parseStorage("[1]")).toEqual({});
    expect(parseStorage("not json")).toEqual({});
    expect(parseStorage(null)).toEqual({});
  });
});

describe("applyChange", () => {
  it("sets, removes and clears", () => {
    expect(
      applyChange(
        { a: "1", b: "2" },
        {
          set: [
            ["a", "x"],
            ["b", null],
          ],
        },
      ),
    ).toEqual({ a: "x" });
    expect(applyChange({ a: "1" }, { clear: true, set: [["c", "3"]] })).toEqual({ c: "3" });
  });

  it("refuses a change that goes over the quota", () => {
    expect(applyChange({}, { set: [["k", "x".repeat(PAGE_STORAGE_QUOTA)]] })).toBeNull();
  });
});
