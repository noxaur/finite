import { describe, expect, it } from "vite-plus/test";
import { readList, writeList } from "./lists";
import {
  isEasing,
  msOf,
  parseTransition,
  partialTransition,
  resetTransition,
  rowEntries,
  tokenIn,
  transitionRows,
  transitionText,
} from "./transitions";

const tokens: Record<string, string> = {
  "--d-fast": "120ms",
  "--ease": "cubic-bezier(.2, 0, 0, 1)",
};
const resolve = (t: string) => tokens[t];

describe("transitions", () => {
  it("takes an entry apart, tokens included", () => {
    expect(parseTransition("opacity 200ms ease-out 50ms")).toEqual({
      property: "opacity",
      duration: "200ms",
      easing: "ease-out",
      delay: "50ms",
    });
    expect(parseTransition("background-color var(--d-fast) var(--ease)", resolve)).toEqual({
      property: "background-color",
      duration: "var(--d-fast)",
      easing: "var(--ease)",
      delay: "0s",
    });
    expect(parseTransition("0.3s")).toMatchObject({ property: "all", duration: "0.3s" });
    expect(parseTransition("display 1s allow-discrete")).toBeNull();
    expect(isEasing("var(--ease-out)")).toBe(true);
    expect(msOf("0.25s")).toBe(250);
    expect(msOf("var(--d-fast)")).toBeNull();
    expect(
      transitionText({ property: "opacity", duration: "200ms", easing: "ease", delay: "0s" }),
    ).toBe("opacity 200ms");
  });

  it("shows a run that names a group's properties as one row", () => {
    const styles = {
      transition:
        "color 150ms, background-color 150ms, border-color 150ms, transform 200ms ease-out",
    };
    const rows = transitionRows(readList(styles, "transition"));
    expect(rows.map((r) => [r.property, r.entries.length])).toEqual([
      ["colors", 3],
      ["transform", 1],
    ]);
    const timing = rows[1]!.timing!;
    expect(rowEntries("transform", timing, false).map((e) => e.css)).toEqual([
      "transform 200ms ease-out",
      "translate 200ms ease-out",
      "scale 200ms ease-out",
      "rotate 200ms ease-out",
    ]);
  });

  it("hides an entry without moving the others", () => {
    const styles = { transition: "opacity 200ms, transform 300ms" };
    const [a, b] = readList(styles, "transition");
    const out = writeList(styles, "transition", [{ ...a!, hidden: true }, b!]);
    expect(out).toEqual({
      transition: "--finite-off 0s, transform 300ms",
      "--finite-off-transition": "opacity 200ms, none",
    });
    const back = readList(out as Record<string, string>, "transition");
    expect(back[0]).toEqual({ css: "opacity 200ms", hidden: true });
  });
});

describe("tokens with a fallback and custom rows", () => {
  it("reads var(--ease-out, ease) as the token", () => {
    expect(tokenIn("var(--ease-out, ease)")).toBe("--ease-out");
    expect(tokenIn("var(--ease, cubic-bezier(0.2, 0, 0, 1))")).toBe("--ease");
    expect(parseTransition("opacity 200ms var(--ease-out, ease)")?.easing).toBe(
      "var(--ease-out, ease)",
    );
  });

  it("keeps what a custom entry says, and resets it in place", () => {
    expect(partialTransition("display 300ms allow-discrete")).toEqual({
      property: "display",
      duration: "300ms",
    });
    expect(resetTransition("display 300ms allow-discrete")).toBe("display 300ms");
    expect(resetTransition("var(--x)")).toBe("all 200ms");
  });
});
