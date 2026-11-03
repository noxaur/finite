// @vitest-environment happy-dom
import { describe, expect, it } from "vite-plus/test";
import { MAX_TOTAL_BYTES, inlineRemote, type Fetcher } from "./inline";

const BASE = "https://finite.test/design/";

/** A fetcher that serves `resources` (url → text), and records what it was asked for. */
function serve(resources: Record<string, string>, bytes = 10) {
  const asked: string[] = [];
  const fetcher: Fetcher = async (url) => {
    asked.push(url);
    const body = resources[url];
    if (body === undefined) throw new Error(`404 ${url}`);
    const type = url.endsWith(".css") ? "text/css" : "image/png";
    return { data: `data:${type};base64,${btoa(body)}`, bytes };
  };
  return { fetcher, asked };
}

describe("inlineRemote", () => {
  it("replaces a remote picture with a data URL, and leaves data URLs alone", async () => {
    const t = serve({ "https://cdn.test/a.png": "PNG" });
    const out = await inlineRemote(
      '<img src="https://cdn.test/a.png"><img src="data:image/png;base64,AA==">',
      "",
      t.fetcher,
      BASE,
    );
    expect(out.html).toContain(`src="data:image/png;base64,${btoa("PNG")}"`);
    expect(out.html).toContain('src="data:image/png;base64,AA=="');
    expect(t.asked).toEqual(["https://cdn.test/a.png"]);
  });

  it("resolves a relative picture against the page", async () => {
    const t = serve({ "https://finite.test/design/x.png": "X" });
    await inlineRemote('<img src="x.png">', "", t.fetcher, BASE);
    expect(t.asked).toEqual(["https://finite.test/design/x.png"]);
  });

  it("inlines a web font and a background picture in CSS", async () => {
    const t = serve({ "https://cdn.test/f.woff2": "FONT", "https://cdn.test/b.png": "BG" });
    const out = await inlineRemote(
      '<div style="background:url(https://cdn.test/b.png)"></div><style>@font-face{font-family:F;src:url("https://cdn.test/f.woff2")}</style>',
      "",
      t.fetcher,
      BASE,
    );
    expect(out.html).toContain(`url(data:image/png;base64,${btoa("BG")})`);
    expect(out.html).toContain(`data:image/png;base64,${btoa("FONT")}`);
    expect(out.html).not.toContain("cdn.test");
  });

  it("inlines the shared CSS too", async () => {
    const t = serve({ "https://cdn.test/f.woff2": "FONT" });
    const out = await inlineRemote(
      "",
      "@font-face{src:url(https://cdn.test/f.woff2)}",
      t.fetcher,
      BASE,
    );
    expect(out.css).toContain(btoa("FONT"));
  });

  it("replaces a linked stylesheet with its rules, fonts inlined", async () => {
    const t = serve({
      "https://fonts.test/s.css": "@font-face{src:url(/f.woff2)}",
      "https://fonts.test/f.woff2": "FONT",
    });
    const out = await inlineRemote(
      '<link rel="stylesheet" href="https://fonts.test/s.css"><p>x</p>',
      "",
      t.fetcher,
      BASE,
    );
    expect(out.html).not.toContain("<link");
    expect(out.html).toContain(btoa("FONT"));
  });

  it("rejects when a resource can't be fetched, so the artboard stays live", async () => {
    const t = serve({});
    await expect(
      inlineRemote('<img src="https://cdn.test/gone.png">', "", t.fetcher, BASE),
    ).rejects.toThrow("404");
  });

  it("rejects when one artboard pulls in more than the cap", async () => {
    const t = serve(
      { "https://cdn.test/a.png": "A", "https://cdn.test/b.png": "B" },
      MAX_TOTAL_BYTES,
    );
    await expect(
      inlineRemote(
        '<img src="https://cdn.test/a.png"><img src="https://cdn.test/b.png">',
        "",
        t.fetcher,
        BASE,
      ),
    ).rejects.toThrow("too much");
  });
});
