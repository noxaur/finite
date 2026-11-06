import { describe, expect, it } from "vite-plus/test";
import {
  decorationColorOf,
  decorationColorStyles,
  decorationOf,
  decorationStyles,
  lineHeightInput,
  lineHeightShown,
  maxLinesOf,
  maxLinesStyles,
  wrapOf,
  wrapStyles,
} from "./typography";

/** Reads inline styles first, then what a class draws. */
const reader =
  (own: Record<string, string>, drawn: Record<string, string> = {}) =>
  (prop: string) =>
    own[prop] ?? drawn[prop];

describe("wrap", () => {
  it("writes truncate's three declarations together, and takes them off", () => {
    expect(wrapStyles({}, reader({}), "truncate")).toEqual({
      "white-space": "nowrap",
      overflow: "hidden",
      "text-overflow": "ellipsis",
    });
    const own = { "white-space": "nowrap", overflow: "hidden", "text-overflow": "ellipsis" };
    expect(wrapOf(reader(own))).toBe("truncate");
    expect(wrapStyles(own, reader(own), "wrap")).toEqual({
      "white-space": null,
      "text-overflow": null,
      overflow: null,
    });
    expect(wrapStyles(own, reader(own), "balance")).toMatchObject({ "text-wrap": "balance" });
  });

  it("covers a class's balance", () => {
    const read = reader({}, { "text-wrap": "balance", "white-space": "normal" });
    expect(wrapStyles({}, read, "wrap")).toEqual({ "text-wrap": "wrap" });
    expect(wrapStyles({}, read, "nowrap")).toEqual({
      "white-space": "nowrap",
      "text-wrap": "wrap",
    });
  });

  it("covers a class's no-wrap", () => {
    expect(wrapStyles({}, reader({}, { "white-space": "nowrap" }), "wrap")).toEqual({
      "white-space": "normal",
    });
  });
});

describe("decoration", () => {
  it("edits the line inside a shorthand, keeping its color", () => {
    const own = { "text-decoration": "underline var(--brand)" };
    expect(decorationOf(own, reader(own))).toBe("underline");
    expect(decorationStyles(own, reader(own), "line-through")).toEqual({
      "text-decoration": "line-through var(--brand)",
    });
    expect(decorationStyles({ "text-decoration": "underline" }, reader({}), "none")).toEqual({
      "text-decoration": null,
    });
    expect(decorationStyles({}, reader({}), "underline")).toEqual({
      "text-decoration-line": "underline",
    });
  });
});

describe("max lines", () => {
  it("clamps with the webkit box, and takes it all off", () => {
    const on = maxLinesStyles({}, 2);
    expect(on).toEqual({
      "line-clamp": "2",
      "-webkit-line-clamp": "2",
      "-webkit-box-orient": "vertical",
      display: "-webkit-box",
      overflow: "hidden",
    });
    const own = on as Record<string, string>;
    expect(maxLinesOf(own, reader(own))).toBe(2);
    expect(maxLinesStyles(own, null)).toEqual({
      "line-clamp": null,
      "-webkit-line-clamp": null,
      "-webkit-box-orient": null,
      display: null,
      overflow: null,
    });
    expect(maxLinesOf({}, reader({}, { "-webkit-line-clamp": "none" }))).toBeNull();
  });
});

describe("decoration color", () => {
  it("reads and writes the color inside a shorthand", () => {
    const own = { "text-decoration": "underline wavy var(--brand)" };
    expect(decorationColorOf(own, reader(own))).toBe("var(--brand)");
    expect(decorationColorStyles(own, "#ff000080")).toEqual({
      "text-decoration": "underline wavy #ff000080",
    });
    expect(decorationColorStyles({ "text-decoration-line": "underline" }, "red")).toEqual({
      "text-decoration-color": "red",
    });
    expect(decorationColorOf({}, reader({}, { color: "rgb(0, 0, 0)" }))).toBe("rgb(0, 0, 0)");
  });
});

describe("line height", () => {
  it("types and shows px, %, multiples and auto the same way", () => {
    expect(lineHeightInput("24")).toBe("24px");
    expect(lineHeightInput("150%")).toBe("150%");
    expect(lineHeightInput("1.5x")).toBe("1.5");
    expect(lineHeightInput("1.5×")).toBe("1.5");
    expect(lineHeightInput("auto")).toBe("normal");
    expect(lineHeightInput("--lh")).toBe("var(--lh)");
    expect(lineHeightShown("24px")).toEqual({ text: "24", value: 24, unit: "px" });
    expect(lineHeightShown("1.5")).toEqual({ text: "1.5×", value: 1.5, unit: "" });
    expect(lineHeightShown("normal")?.text).toBe("Auto");
    expect(lineHeightShown("150%")?.text).toBe("150%");
    expect(lineHeightShown("calc(1em + 4px)")).toBeNull();
  });
});
