import { describe, expect, it } from "vite-plus/test";
import { readSize } from "./client/bridge.ts";

describe("reading how an axis is sized", () => {
  it("calls a size the element declares in pixels fixed, even when it matches the layout", () => {
    // A column stretched it to 240, the same as its own `w-240`.
    expect(readSize(240, 80, 240, "240px")).toBe("fixed");
    expect(readSize(80, 80, 80, "80px")).toBe("fixed");
  });

  it("reads hug and auto when the element declares no length", () => {
    expect(readSize(80, 80, 240, "auto")).toBe("hug");
    expect(readSize(80, 80, 240, "fit-content")).toBe("hug");
    expect(readSize(240, 80, 240, "auto")).toBe("auto");
    expect(readSize(300, 80, 240, "50%")).toBe("fixed");
    expect(readSize(120, 80, 240, "auto")).toBe("fixed");
  });
});
