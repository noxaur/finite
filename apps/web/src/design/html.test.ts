import { describe, expect, it } from "vite-plus/test";
import { artboardDocument, exportHtml, pixelSize } from "./html";
import { Replica } from "./replica";
import type { Node } from "./schema";

const el = (id: string, parent: string | null, tag: string, extra: Partial<Node> = {}): Node => ({
  id,
  parent,
  index: id,
  type: "element",
  tag,
  name: null,
  text: null,
  x: null,
  y: null,
  styles: {},
  attrs: {},
  ...extra,
});

const text = (id: string, parent: string, value: string): Node => ({
  ...el(id, parent, ""),
  type: "text",
  text: value,
});

const replica = (nodes: Node[]) => {
  const r = new Replica();
  r.load({ meta: { id: "d", name: "D", createdAt: 0, updatedAt: 0 }, seq: 0, nodes, comments: [] });
  return r;
};

describe("exportHtml", () => {
  it("writes styles, attributes and escaped text", () => {
    const r = replica([
      el("a", null, "div", { styles: { width: "390px", color: "red" }, attrs: { class: "x" } }),
      el("b", "a", "p"),
      text("c", "b", '1 < 2 & "ok"'),
      el("d", "a", "img", { attrs: { src: "a.png" } }),
    ]);
    expect(exportHtml(r, "a")).toBe(
      '<div class="x" style="width: 390px; color: red"><p>1 &lt; 2 &amp; "ok"</p><img src="a.png" /></div>',
    );
  });

  it("leaves script and style code unescaped but can't be closed early", () => {
    const r = replica([
      el("a", null, "div"),
      el("b", "a", "script"),
      text("c", "b", "if (a < b) x('</SCRIPT>')"),
    ]);
    expect(exportHtml(r, "a")).toBe("<div><script>if (a < b) x('<\\/SCRIPT>')</script></div>");
  });

  it("wraps an artboard in a page with a content policy", () => {
    const r = replica([el("a", null, "div")]);
    const page = artboardDocument(r, "a");
    expect(page).toContain("Content-Security-Policy");
    expect(page).toContain("default-src 'none'");
    // Each element carries its node id, so comments can point inside the sandbox.
    expect(page).toMatch(/<body><div data-finite-id="a"><\/div><\/body>/);
    expect(exportHtml(r, "a")).toBe("<div></div>");
  });
});

describe("pixelSize", () => {
  it("reads plain pixel sizes only", () => {
    expect(pixelSize(el("a", null, "div", { styles: { width: "390px", height: "auto" } }))).toEqual(
      {
        width: 390,
        height: null,
      },
    );
  });
});
