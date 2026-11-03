import "./wasm.node";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { artboardDocument, pixelSize } from "./html";
import { Replica } from "./replica";
import type { Node } from "./schema";
import { designModel } from "./wasm";

const el = (id: string, parent: string | null, tag: string, extra: Partial<Node> = {}): Node => ({
  id,
  parent,
  index: "V",
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

const replica = (nodes: ReadonlyArray<Node>) => {
  const r = new Replica();
  r.load({ meta: { id: "d", name: "D", createdAt: 0, updatedAt: 0 }, seq: 0, nodes, comments: [] });
  return r;
};

describe("artboardDocument", () => {
  it("wraps an artboard in a page with the server's content policy and base CSS", () => {
    const r = replica([el("a", null, "div", { attrs: { class: "x" } })]);
    const page = artboardDocument(r, "a");
    expect(page).toContain(`content="${designModel().csp}"`);
    expect(designModel().csp).toContain("default-src 'none'");
    expect(page).toContain(designModel().baseCss);
    // Each element carries its node id, so comments can point inside the sandbox.
    expect(page).toContain('<body><div data-finite-id="a" class="x"></div></body>');
    expect(r.exportHtml("a")).toBe('<div class="x"></div>');
  });

  it("puts the tokens before the artboard, in a layer its own styles override", () => {
    const r = replica([el("a", null, "div")]);
    r.apply({ op: "token", name: "--brand", modeId: "mode-1", value: "red" });
    const page = artboardDocument(r, "a");
    const tokens = page.indexOf("<style>@layer finite-tokens { :root { --brand: red; } }</style>");
    expect(tokens).toBeGreaterThan(page.indexOf(designModel().baseCss));
    expect(tokens).toBeLessThan(page.indexOf("<body>"));
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

// The cases in crates/design/fixtures/export.json, recorded from the Rust
// export that screenshots use. The viewer calls that same export through
// WebAssembly, so these check the boundary: the nodes go in as JSON, and
// the HTML, escaped text and all, comes back unchanged.
describe("the viewer exports artboards with the screenshot code", () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL("../../../../crates/design/fixtures/export.json", import.meta.url),
      "utf8",
    ),
  ) as {
    readonly cases: ReadonlyArray<{
      readonly name: string;
      readonly root: string;
      readonly nodes: ReadonlyArray<Node>;
      readonly expect: string;
    }>;
  };

  it.each(fixture.cases.map((c) => [c.name, c] as const))("%s", (_, c) => {
    expect(replica(c.nodes).exportHtml(c.root)).toBe(c.expect);
  });

  it("returns nothing for a node that isn't there", () => {
    expect(replica([]).exportHtml("missing")).toBe("");
  });
});
