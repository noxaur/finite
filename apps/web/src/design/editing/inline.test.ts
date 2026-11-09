import type { Inline } from "@finite/protocol";
import { describe, expect, it } from "vite-plus/test";
import {
  hasText,
  isFormatted,
  isPlain,
  lengthAll,
  linkIn,
  normalize,
  plainText,
  sameContent,
  setLink,
  setRunStyle,
  toggleFormat,
} from "./inline";

const text = (t: string, marks: Extract<Inline, { t: "text" }>["marks"] = []): Inline => ({
  t: "text",
  text: t,
  marks,
});
const keeps = [{ id: 0, label: "<a>" }];

describe("formatting a range of text", () => {
  it("splits the runs at the offsets and marks the middle", () => {
    expect(toggleFormat([text("Hello world")], 6, 11, "bold")).toEqual([
      text("Hello "),
      text("world", [{ m: "strong" }]),
    ]);
  });

  it("turns off when the whole range already has the format", () => {
    const content = [text("Hello "), text("world", [{ m: "b" }])];
    expect(isFormatted(content, 6, 11, "bold")).toBe(true);
    expect(toggleFormat(content, 6, 11, "bold")).toEqual([text("Hello world")]);
  });

  it("turns on when only part of the range has it", () => {
    const content = [text("ab", [{ m: "em" }]), text("cd")];
    expect(isFormatted(content, 0, 4, "italic")).toBe(false);
    expect(toggleFormat(content, 0, 4, "italic")).toEqual([text("abcd", [{ m: "em" }])]);
  });

  it("wraps a chip inside the range and skips a line break", () => {
    const content: Inline[] = [text("a"), { t: "atom", id: 1 }, { t: "br" }, text("b")];
    expect(lengthAll(content)).toBe(4);
    expect(toggleFormat(content, 0, 4, "underline")).toEqual([
      text("a", [{ m: "u" }]),
      { t: "atom", id: 1, marks: [{ m: "u" }] },
      { t: "br", marks: [{ m: "u" }] },
      text("b", [{ m: "u" }]),
    ]);
  });

  it("keeps a wrapper outermost, so its text stays one element", () => {
    const content = [text("abc", [{ m: "keep", id: 0 }])];
    expect(toggleFormat(content, 1, 2, "strike")).toEqual([
      text("a", [{ m: "keep", id: 0 }]),
      text("b", [{ m: "keep", id: 0 }, { m: "s" }]),
      text("c", [{ m: "keep", id: 0 }]),
    ]);
  });
});

describe("styling a range", () => {
  it("adds a span, then merges later properties into it", () => {
    const one = setRunStyle([text("abcd")], 0, 2, "color", "#ff0000");
    expect(one).toEqual([text("ab", [{ m: "span", styles: { color: "#ff0000" } }]), text("cd")]);
    expect(setRunStyle(one, 0, 2, "font-size", "20px")).toEqual([
      text("ab", [{ m: "span", styles: { color: "#ff0000", "font-size": "20px" } }]),
      text("cd"),
    ]);
  });
});

describe("links", () => {
  it("adds and replaces a link, and reads it back", () => {
    const linked = setLink([text("abc")], 0, 3, "/a", keeps);
    expect(linked).toEqual([text("abc", [{ m: "a", href: "/a" }])]);
    expect(linkIn(linked, 0, 3, keeps)).toBe("/a");
    expect(setLink(linked, 0, 3, "/b", keeps)).toEqual([text("abc", [{ m: "a", href: "/b" }])]);
  });

  it("removes a link, including an anchor Finite only keeps", () => {
    const content = [text("x", [{ m: "keep", id: 0 }])];
    expect(linkIn(content, 0, 1, keeps)).toBe("");
    expect(setLink(content, 0, 1, null, keeps)).toEqual([text("x")]);
    expect(linkIn([text("x")], 0, 1, keeps)).toBeNull();
  });
});

describe("content", () => {
  it("merges neighbours alike and drops empty runs", () => {
    expect(normalize([text("a"), text(""), text("b")])).toEqual([text("ab")]);
    expect(normalize([text("a", [{ m: "b" }]), text("b", [{ m: "i" }])])).toHaveLength(2);
  });

  it("compares, flattens and tells plain from formatted", () => {
    expect(sameContent([text("a")], [text("a")])).toBe(true);
    expect(isPlain([text("a")])).toBe(true);
    expect(isPlain([text("a", [{ m: "b" }])])).toBe(false);
    expect(plainText([text("a"), { t: "br" }, text("b")])).toBe("a b");
    expect(hasText([text("  ")])).toBe(false);
    expect(hasText([{ t: "atom", id: 0 }])).toBe(true);
  });
});
