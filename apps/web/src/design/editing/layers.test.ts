import "../wasm.node";
import { describe, expect, it } from "vite-plus/test";
import { Replica } from "../replica";
import type { Node } from "../schema";
import { summarize } from "../session";
import { draggedLayers, dropAt, dropEdit, LayerModel, type Row } from "./layers";

const node = (
  id: string,
  parent: string | null,
  index: string,
  extra: Partial<Node> = {},
): Node => ({
  id,
  parent,
  index,
  type: "element",
  tag: "div",
  name: id,
  text: null,
  x: parent === null ? 0 : null,
  y: parent === null ? 0 : null,
  styles: {},
  attrs: {},
  ...extra,
});

/** board > [card > [title, body], footer], and a second board. */
const replica = () => {
  const r = new Replica();
  r.load({
    meta: { id: "d", name: "D", createdAt: 0, updatedAt: 0 },
    seq: 1,
    nodes: [
      node("board", null, "a"),
      node("card", "board", "a"),
      node("title", "card", "a"),
      node("body", "card", "b"),
      node("footer", "board", "b"),
      node("pic", "footer", "a", { tag: "img" }),
      node("other", null, "b"),
    ],
    comments: [],
  });
  return r;
};

const shown = (model: LayerModel) =>
  model.rows().map((r) => `${"  ".repeat(r.depth)}${r.facts.id}`);

describe("LayerModel", () => {
  it("walks only the open rows of the page", () => {
    const model = new LayerModel(replica());
    model.setPage("page-1");
    expect(shown(model)).toEqual(["board", "other"]);
    model.reveal(["title"]);
    expect(shown(model)).toEqual(["board", "  card", "    title", "    body", "  footer", "other"]);
  });

  it("keeps the facts of rows a change didn't touch, so they don't draw again", () => {
    const r = replica();
    const model = new LayerModel(r);
    model.setPage("page-1");
    model.reveal(["title"]);
    const before = new Map(model.rows().map((row) => [row.facts.id, row.facts]));
    const applied = r.applyAll([{ op: "set", id: "title", key: "attr:hidden", value: "" }]);
    model.apply(
      summarize(
        "draft",
        applied.filter((a) => a !== null),
      ),
    );
    const after = new Map(model.rows().map((row) => [row.facts.id, row.facts]));
    expect(after.get("title")).not.toBe(before.get("title"));
    expect(after.get("title")?.hidden).toBe(true);
    expect(after.get("body")).toBe(before.get("body"));
    expect(after.get("card")).toBe(before.get("card"));
  });

  it("finds layers by name", () => {
    const model = new LayerModel(replica());
    model.setPage("page-1");
    model.setQuery("bo");
    expect(shown(model)).toEqual(["board", "body"]);
  });
});

describe("dropAt", () => {
  const rows = (): ReadonlyArray<Row> => {
    const model = new LayerModel(replica());
    model.setPage("page-1");
    model.reveal(["title", "pic"]);
    // board, card, title, body, footer, pic, other
    return model.rows();
  };
  const none = new Set<string>();

  it("drops before, into and after a container by where in its row the pointer is", () => {
    const all = rows();
    expect(dropAt(all, 4, 0.1, 0, none)).toMatchObject({ parent: "board", before: "footer" });
    expect(dropAt(all, 4, 0.5, 0, none)).toMatchObject({ parent: "footer", edge: "inside" });
  });

  it("splits a row that can't hold layers in half", () => {
    const all = rows();
    expect(dropAt(all, 5, 0.4, 2, none)).toMatchObject({ parent: "footer", before: "pic" });
    expect(dropAt(all, 5, 0.6, 2, none)).toMatchObject({ parent: "footer", before: null });
  });

  it("puts a drop after an open row before its first child", () => {
    expect(dropAt(rows(), 1, 0.9, 0, none)).toMatchObject({ parent: "card", before: "title" });
  });

  it("lets the pointer's indent pick the level below the last of nested layers", () => {
    const all = rows();
    // Below `body`, the last child of `card`: inside card, or after card in board.
    expect(dropAt(all, 3, 0.9, 2, none)).toMatchObject({ parent: "card", before: null });
    expect(dropAt(all, 3, 0.9, 1, none)).toMatchObject({ parent: "board", before: "footer" });
    expect(dropAt(all, 3, 0.9, 0, none)).toMatchObject({ parent: "board", before: "footer" });
  });

  it("never drops a layer into itself", () => {
    expect(dropAt(rows(), 2, 0.5, 0, new Set(["card"]))).toBeNull();
  });
});

describe("dragging layers", () => {
  it("moves the outermost selected layers, in the order shown", () => {
    const model = new LayerModel(replica());
    model.setPage("page-1");
    model.reveal(["title"]);
    expect(draggedLayers(model.rows(), "body", ["footer", "card", "body"])).toEqual([
      "card",
      "footer",
    ]);
    expect(draggedLayers(model.rows(), "title", ["footer"])).toEqual(["title"]);
  });

  it("anchors after a dragged layer at the next one that stays", () => {
    const r = replica();
    const drop = { parent: "board", before: "card", row: 1, edge: "before", depth: 1 } as const;
    expect(dropEdit(r, ["card"], drop)).toEqual({
      kind: "place",
      ids: ["card"],
      parent: "board",
      before: "footer",
    });
  });
});
