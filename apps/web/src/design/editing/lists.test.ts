import { describe, expect, it } from "vite-plus/test";
import { moveEntry, placeholderOf, readList, splitList, stashOf, writeList } from "./lists";

describe("lists", () => {
  it("splits shadows at commas and filters at spaces", () => {
    expect(splitList("box-shadow", "0 1px 2px rgb(0 0 0 / 30%), inset 0 0 0 1px red")).toEqual([
      "0 1px 2px rgb(0 0 0 / 30%)",
      "inset 0 0 0 1px red",
    ]);
    expect(splitList("filter", "blur(4px) brightness(1.2)")).toEqual([
      "blur(4px)",
      "brightness(1.2)",
    ]);
    expect(splitList("box-shadow", "none")).toEqual([]);
  });

  it("hides an entry behind a placeholder and shows it again", () => {
    const styles = { "box-shadow": "0 1px 2px red, 0 4px 12px #0003" };
    const entries = readList(styles, "box-shadow");
    const hidden = writeList(styles, "box-shadow", [entries[0]!, { ...entries[1]!, hidden: true }]);
    expect(hidden).toEqual({
      "box-shadow": "0 1px 2px red, 0 0 0 0 transparent",
      [stashOf("box-shadow")]: "none, 0 4px 12px #0003",
    });
    const after = { ...styles, ...hidden } as Record<string, string>;
    const read = readList(after, "box-shadow");
    expect(read[1]).toEqual({ css: "0 4px 12px #0003", hidden: true });
    expect(
      writeList(
        after,
        "box-shadow",
        read.map((e) => ({ ...e, hidden: false })),
      ),
    ).toEqual({
      "box-shadow": "0 1px 2px red, 0 4px 12px #0003",
      [stashOf("box-shadow")]: null,
    });
  });

  it("reads a placeholder an agent wrote, with no stash, as a visible entry", () => {
    expect(readList({ "box-shadow": "0 0 0 0 transparent" }, "box-shadow")).toEqual([
      { css: "0 0 0 0 transparent", hidden: false },
    ]);
  });

  it("uses each filter's identity as its placeholder", () => {
    expect(placeholderOf("filter", "blur(4px)")).toBe("blur(0)");
    expect(placeholderOf("filter", "hue-rotate(90deg)")).toBe("hue-rotate(0deg)");
    expect(placeholderOf("background-image", "url(a.png)")).toBe(
      "linear-gradient(transparent, transparent)",
    );
    expect(writeList({}, "filter", [{ css: "blur(4px)", hidden: true }])).toEqual({
      filter: "blur(0)",
      [stashOf("filter")]: "blur(4px)",
    });
  });

  it("empties a list, and moves an entry", () => {
    expect(writeList({ filter: "blur(2px)" }, "filter", [], "none")).toEqual({ filter: "none" });
    expect(moveEntry(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
    expect(moveEntry(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
  });
});
