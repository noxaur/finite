import { describe, expect, it } from "vite-plus/test";
import { parseAngle, roundTo } from "./units";

describe("units", () => {
  it("rounds away float noise", () => {
    expect(roundTo(0.1 + 0.2, 3)).toBe(0.3);
    expect(roundTo(1.234, 1)).toBe(1.2);
  });

  it("reads an angle in degrees", () => {
    expect(parseAngle("45deg")).toBe(45);
    expect(parseAngle("0.25TURN")).toBe(90);
    expect(parseAngle("50grad")).toBe(45);
    expect(parseAngle("0")).toBe(0);
    expect(parseAngle("45")).toBeNull();
    expect(parseAngle("10px")).toBeNull();
  });
});
