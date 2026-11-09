import type { DropNode } from "@finite/protocol";
import { describe, expect, it } from "vite-plus/test";
import { planInsert } from "./insertion";

const rev = "0123abcd";
const node = (loc: string, over: Partial<DropNode> = {}): DropNode => ({
  loc,
  rev,
  tag: "div",
  index: 0,
  count: 1,
  rect: { x: 0, y: 0, width: 400, height: 400 },
  display: "block",
  flexDirection: "row",
  position: "static",
  borderLeft: 0,
  borderTop: 0,
  scrollLeft: 0,
  scrollTop: 0,
  children: [],
  ...over,
});
const child = (loc: string, x: number) => {
  const { children: _none, ...rest } = node(loc, { rect: { x, y: 0, width: 50, height: 50 } });
  return rest;
};
const box = { x: 60, y: 70, width: 100, height: 40 };
const opts = { deep: false, alt: false, nodeTag: "div" };
const OWN = "src/App.tsx";

describe("planInsert", () => {
  it("puts an absolute child in a plain container, made relative in the same edit", () => {
    const plan = planInsert([node(`${OWN}:4:2`)], OWN, box, opts);
    expect(plan).toEqual({
      anchor: { loc: `${OWN}:4:2`, rev, tag: "div", place: "end" },
      styles: {
        position: "absolute",
        left: "60px",
        top: "70px",
        width: "100px",
        height: "40px",
      },
      makeRelative: { loc: `${OWN}:4:2`, rev, tag: "div" },
      instances: 1,
    });
  });

  it("measures from the container's padding box, scrolled", () => {
    const plan = planInsert(
      [
        node(`${OWN}:4:2`, {
          position: "relative",
          rect: { x: 10, y: 10, width: 200, height: 200 },
          borderLeft: 2,
          borderTop: 3,
          scrollTop: 100,
        }),
      ],
      OWN,
      box,
      opts,
    );
    expect(plan).toMatchObject({ styles: { left: "48px", top: "157px" } });
    expect(plan).not.toHaveProperty("makeRelative");
  });

  it("slots a flow child between a flex container's children", () => {
    const flex = node(`${OWN}:4:2`, {
      display: "flex",
      children: [child(`${OWN}:5:4`, 0), child(`${OWN}:6:4`, 200)],
    });
    expect(planInsert([flex], OWN, box, opts)).toMatchObject({
      anchor: { loc: `${OWN}:6:4`, place: "before" },
      styles: { width: "100px", height: "40px", "flex-shrink": "0" },
    });
    const end = { ...box, x: 500 };
    expect(planInsert([flex], OWN, end, opts)).toMatchObject({
      anchor: { loc: `${OWN}:4:2`, place: "end" },
    });
  });

  it("inverts the choice with Alt", () => {
    const flex = node(`${OWN}:4:2`, { display: "flex", position: "relative" });
    expect(planInsert([flex], OWN, box, { ...opts, alt: true })).toMatchObject({
      styles: { position: "absolute" },
    });
    expect(planInsert([node(`${OWN}:4:2`)], OWN, box, { ...opts, alt: true })).toMatchObject({
      styles: { "flex-shrink": "0" },
    });
  });

  it("skips what can't hold children", () => {
    const chain = [node(`${OWN}:5:4`, { tag: "img" }), node(`${OWN}:4:2`)];
    expect(planInsert(chain, OWN, box, opts)).toMatchObject({ anchor: { loc: `${OWN}:4:2` } });
    const svg = [node(`${OWN}:6:4`, { tag: "path" }), node(`${OWN}:5:4`, { tag: "svg" })];
    expect(planInsert(svg, OWN, box, opts)).toHaveProperty("refuse");
    expect(planInsert(svg, OWN, box, { ...opts, nodeTag: "path" })).toMatchObject({
      anchor: { loc: `${OWN}:5:4` },
    });
  });

  it.each(["table", "thead", "tbody", "tfoot", "tr", "colgroup"])(
    "skips %s, where the parser would move a div out",
    (tag) => {
      const chain = [node(`${OWN}:5:4`, { tag }), node(`${OWN}:4:2`)];
      expect(planInsert(chain, OWN, box, opts)).toMatchObject({ anchor: { loc: `${OWN}:4:2` } });
    },
  );

  it.each([
    "h1",
    "h6",
    "span",
    "label",
    "button",
    "strong",
    "em",
    "b",
    "i",
    "small",
    "abbr",
    "cite",
    "code",
    "dfn",
    "kbd",
    "mark",
    "pre",
    "q",
    "s",
    "samp",
    "sub",
    "sup",
    "time",
    "u",
    "var",
  ])("skips %s, which can't validly hold a div", (tag) => {
    const chain = [node(`${OWN}:5:4`, { tag }), node(`${OWN}:4:2`)];
    expect(planInsert(chain, OWN, box, opts)).toMatchObject({ anchor: { loc: `${OWN}:4:2` } });
  });

  it("draws inside a link and a table cell", () => {
    for (const tag of ["a", "td"]) {
      expect(planInsert([node(`${OWN}:4:2`, { tag })], OWN, box, opts)).toMatchObject({
        anchor: { loc: `${OWN}:4:2`, place: "end" },
      });
    }
  });

  it("refuses a route whose only root is a heading, and says what to do", () => {
    const layout = node("src/Layout.tsx:3:2", {
      children: [child(`${OWN}:7:4`, 0)],
    });
    layout.children[0]!.tag = "h1";
    expect(planInsert([layout], OWN, box, opts)).toEqual({
      refuse:
        "Nothing here can hold a new element. Draw inside a container like a div, or ask the agent to add one.",
    });
  });

  it("climbs out of another file to the frame's own", () => {
    const chain = [node("src/Card.tsx:3:2"), node(`${OWN}:4:2`)];
    expect(planInsert(chain, OWN, box, opts)).toMatchObject({ anchor: { loc: `${OWN}:4:2` } });
  });

  it("anchors beside the caller's own child inside a shared component", () => {
    const card = node("src/Card.tsx:3:2", {
      children: [child(`${OWN}:9:6`, 0), child(`${OWN}:10:6`, 100)],
      count: 3,
    });
    expect(planInsert([card, node(`${OWN}:8:4`)], OWN, box, opts)).toMatchObject({
      anchor: { loc: `${OWN}:10:6`, place: "after" },
      label: "Adds to Card.tsx · used in 3 places",
      instances: 3,
    });
  });

  it("goes into the file's root when a layout renders it", () => {
    const layout = node("src/Layout.tsx:3:2", {
      children: [child("src/Layout.tsx:4:4", 0), child(`${OWN}:7:4`, 0)],
    });
    expect(planInsert([layout], OWN, box, opts)).toMatchObject({
      anchor: { loc: `${OWN}:7:4`, place: "end" },
      makeRelative: { loc: `${OWN}:7:4` },
    });
  });

  it("takes the nearest element whatever its file with ⌘", () => {
    const chain = [node("src/Card.tsx:3:2"), node(`${OWN}:4:2`)];
    expect(planInsert(chain, OWN, box, { ...opts, deep: true })).toMatchObject({
      anchor: { loc: "src/Card.tsx:3:2" },
      label: "Adds to Card.tsx",
    });
  });

  it("takes the nearest element when the router names no file", () => {
    expect(planInsert([node("src/Any.tsx:3:2")], undefined, box, opts)).toMatchObject({
      anchor: { loc: "src/Any.tsx:3:2", place: "end" },
    });
  });

  it("says why when nothing fits", () => {
    expect(planInsert([node("src/Card.tsx:3:2")], OWN, box, opts)).toHaveProperty("refuse");
  });
});
