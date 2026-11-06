import { describe, expect, it } from "vite-plus/test";
import { clamp, clampedText, PX_PER_STEP, scrubbed, scrubber, steppedText } from "./scrub";

describe("scrubbed", () => {
  it("moves one step for each PX_PER_STEP of travel", () => {
    expect(scrubbed(20, 40, {})).toBe(20 + 40 / PX_PER_STEP);
    expect(scrubbed(20, -40, {})).toBe(20 - 40 / PX_PER_STEP);
  });

  it("waits for a whole step of travel", () => {
    expect(scrubbed(5, PX_PER_STEP / 2 - 0.1, {})).toBe(5);
    expect(scrubbed(5, -(PX_PER_STEP / 2 - 0.1), {})).toBe(5);
  });

  it("scales by step, Shift and Alt", () => {
    expect(scrubbed(0, 40, { step: 0.05 })).toBeCloseTo(0.5);
    expect(scrubbed(0, 40, { shift: true })).toBe(100);
    expect(scrubbed(0, 40, { step: 0.05, fine: true })).toBeCloseTo(0.05);
  });

  it("stops at min and max", () => {
    expect(scrubbed(4, -400, { min: 0 })).toBe(0);
    expect(scrubbed(90, 400, { max: 100 })).toBe(100);
  });

  it("answers at once when dragged back from a limit", () => {
    // 400px past the limit, then back: the first step back comes after one step's travel.
    const up = scrubber(90);
    expect(up(400, { max: 100 })).toBe(100);
    expect(up(400 - PX_PER_STEP + 0.1, { max: 100 })).toBe(100);
    expect(up(400 - PX_PER_STEP, { max: 100 })).toBe(99);
    expect(up(400 - 2 * PX_PER_STEP, { max: 100 })).toBe(98);
    const down = scrubber(4);
    expect(down(-400, { min: 0 })).toBe(0);
    expect(down(-400 + PX_PER_STEP - 0.1, { min: 0 })).toBe(0);
    expect(down(-400 + PX_PER_STEP, { min: 0 })).toBe(1);
  });

  it("drops travel past a limit each time the limit holds it", () => {
    const up = scrubber(90);
    expect(up(100, { max: 100 })).toBe(100);
    expect(up(400, { max: 100 })).toBe(100);
    expect(up(400 - PX_PER_STEP, { max: 100 })).toBe(99);
    // Within the limits, it's as `scrubbed` has it.
    expect(scrubber(90)(-8, { max: 100 })).toBe(scrubbed(90, -8, { max: 100 }));
  });

  it("steps back by Shift and Alt steps from a limit", () => {
    const shifted = scrubber(90);
    expect(shifted(400, { shift: true, max: 100 })).toBe(100);
    expect(shifted(400 - PX_PER_STEP, { shift: true, max: 100 })).toBe(90);
    const fine = scrubber(0.5);
    expect(fine(-400, { step: 0.1, fine: true, min: 0 })).toBe(0);
    expect(fine(-400 + PX_PER_STEP, { step: 0.1, fine: true, min: 0 })).toBeCloseTo(0.01);
  });

  it("holds a radius at 0 when dragged left from 0", () => {
    expect(scrubbed(0, -200, { min: 0 })).toBe(0);
    expect(scrubbed(0, 40, { min: 0 })).toBe(10);
  });
});

describe("clamp", () => {
  it("leaves a number within its limits alone", () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-5)).toBe(-5);
    expect(clamp(-5, 0)).toBe(0);
    expect(clamp(15, 0, 10)).toBe(10);
  });
});

describe("clampedText", () => {
  it("holds the number and keeps its unit", () => {
    expect(clampedText("-4px", 0)).toBe("0px");
    expect(clampedText("150%", 0, 100)).toBe("100%");
  });

  it("leaves text it didn't change, or can't read, as typed", () => {
    expect(clampedText("12px", 0)).toBe("12px");
    expect(clampedText("-", 0)).toBe("-");
    expect(clampedText("var(--radius)", 0)).toBe("var(--radius)");
    expect(clampedText("-4px")).toBe("-4px");
  });
});

describe("steppedText", () => {
  it("steps the number and keeps its unit", () => {
    expect(steppedText({ value: 12, unit: "px" }, 10)).toBe("22px");
    expect(steppedText({ value: 0.1, unit: "" }, 0.2)).toBe("0.3");
  });

  it("stops at the limits", () => {
    expect(steppedText({ value: 3, unit: "px" }, -10, 0)).toBe("0px");
    expect(steppedText({ value: 95, unit: "%" }, 10, 0, 100)).toBe("100%");
  });
});
