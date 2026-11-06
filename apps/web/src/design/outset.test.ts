import { describe, expect, it } from "vite-plus/test";
import { strokeOutset } from "./outset";

const css = (style: Partial<Parameters<typeof strokeOutset>[0]>) => ({
  outlineStyle: "none",
  outlineWidth: "0px",
  outlineOffset: "0px",
  boxShadow: "none",
  ...style,
});

describe("strokeOutset", () => {
  it("is nothing without an outline or shadow", () => {
    expect(strokeOutset(css({}))).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
  });

  it("takes in an outline and its offset", () => {
    const o = strokeOutset(
      css({ outlineStyle: "solid", outlineWidth: "3px", outlineOffset: "2px" }),
    );
    expect(o).toEqual({ top: 5, right: 5, bottom: 5, left: 5 });
  });

  it("takes in a hard shadow's spread and offset, and the widest of several", () => {
    const o = strokeOutset(
      css({ boxShadow: "rgb(0, 0, 0) 0px 0px 0px 4px, rgba(1, 2, 3, 0.5) 6px 2px 0px 0px" }),
    );
    expect(o).toEqual({ top: 4, right: 6, bottom: 4, left: 4 });
  });

  it("leaves out soft and inset shadows", () => {
    const o = strokeOutset(
      css({ boxShadow: "rgb(0, 0, 0) 0px 4px 12px 0px, rgb(0, 0, 0) 0px 0px 0px 8px inset" }),
    );
    expect(o).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
  });
});
