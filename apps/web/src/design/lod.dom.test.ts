// @vitest-environment happy-dom
import { describe, expect, it } from "vite-plus/test";
import { toXhtml } from "./lod";

describe("toXhtml", () => {
  it("closes void elements and quotes attributes, so an SVG image can parse it", () => {
    const xhtml = toXhtml('<p class=a>one<br>two</p><img src="x.png">');
    expect(xhtml).toMatch(/<br[^>]*\/>/);
    expect(xhtml).toContain('class="a"');
    expect(xhtml).toMatch(/<img [^>]*src="x.png"[^>]*\/>/);
  });

  it("escapes text that would read as markup", () => {
    expect(toXhtml("<p>a &lt; b &amp; c</p>")).toContain("a &lt; b &amp; c");
  });

  it("drops scripts and embedded content, which an image can't use", () => {
    // Not `<link>` or `<iframe>`: happy-dom would try to load them.
    const xhtml = toXhtml(
      "<p>hi</p><script>alert(1)</script><object></object><template></template>",
    );
    expect(xhtml).toContain("hi");
    for (const tag of ["script", "object", "template"]) expect(xhtml).not.toContain(`<${tag}`);
  });

  it("keeps a style block's rules", () => {
    expect(toXhtml("<style>.a > b { color: red }</style><p>x</p>")).toMatch(
      /\.a (&gt;|>) b \{ color: red \}/,
    );
  });
});
