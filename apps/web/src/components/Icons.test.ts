import { describe, expect, it } from "vite-plus/test";
import { ICON_NAMES, iconMarkup } from "./Icons";

describe("iconMarkup", () => {
  it.each(ICON_NAMES)("%s carries the filter it references and follows the text color", (name) => {
    const svg = iconMarkup(name, 12);
    expect(svg).toContain('width="12"');
    expect(svg).toContain(`<filter id="fin-ico-${name}"`);
    expect(svg).toContain(`filter="url(#fin-ico-${name})"`);
    expect(svg).toContain('stroke="currentColor"');
  });

  it("gives each copy its own filter id", () => {
    expect(iconMarkup("play", 12, "«r1»")).toContain('<filter id="fin-ico-playr1"');
    expect(iconMarkup("play", 12, "«r1»")).toContain('filter="url(#fin-ico-playr1)"');
  });

  it("fills only the play triangle", () => {
    expect(iconMarkup("play")).toContain('fill="currentColor"');
    for (const name of ["previous", "next", "close"] as const) {
      expect(iconMarkup(name)).not.toContain('fill="currentColor"');
    }
  });
});
