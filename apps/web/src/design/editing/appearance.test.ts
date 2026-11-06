import { describe, expect, it } from "vite-plus/test";
import { cornerOf, ellipseOf, ellipseText, opacityPercent, opacityValue } from "./appearance";

describe("appearance", () => {
  it("reads opacity as a percentage and writes it back from 0 to 1", () => {
    expect(opacityPercent("0.5")).toBe(50);
    expect(opacityPercent("40%")).toBe(40);
    expect(opacityPercent("var(--o)")).toBeNull();
    expect(opacityValue(70)).toBe("0.7");
    expect(opacityValue(120)).toBe("1");
  });

  it("reads and writes elliptical corners", () => {
    const e = ellipseOf("16px / 8px")!;
    expect(e).toEqual({ h: ["16px", "16px", "16px", "16px"], v: ["8px", "8px", "8px", "8px"] });
    expect(ellipseOf("8px")).toBeNull();
    expect(ellipseText({ ...e, v: ["8px", "20px", "8px", "8px"] })).toBe("16px / 8px 20px 8px 8px");
    expect(cornerOf("10px 4px")).toEqual(["10px", "4px"]);
    expect(cornerOf("6px")).toEqual(["6px", "6px"]);
  });
});
