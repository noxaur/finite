import { describe, expect, it } from "vite-plus/test";
import { ICON_NAMES, iconMarkup, strokeFor } from "./Icons";

/** Icons drawn solid on purpose, where solid is the convention. */
const FILLED = new Set([
  "play",
  "fillSolid",
  "fillConic",
  "opacity",
  "flipH",
  "flipV",
  "wifi",
  "token",
  "fillRadial",
  "truncate",
  "maxLines",
  "grip",
  "origin",
]);

describe("iconMarkup", () => {
  it.each(ICON_NAMES)("%s is a plain round-stroked SVG in the text color", (name) => {
    const svg = iconMarkup(name, 12);
    expect(svg).toContain('width="12"');
    expect(svg).toContain('viewBox="0 0 24 24"');
    expect(svg).toContain('stroke="currentColor"');
    expect(svg).toContain('stroke-linecap="round"');
    expect(svg).toContain('stroke-linejoin="round"');
    expect(svg).not.toMatch(/filter|feTurbulence|id="/);
    expect(svg).not.toMatch(/#[0-9a-f]{3,6}\b/i);
  });

  it("fills only the icons whose convention is solid", () => {
    for (const name of ICON_NAMES) {
      expect(iconMarkup(name).includes('fill="currentColor"'), name).toBe(FILLED.has(name));
    }
  });

  it("keeps the stroke at 1px at 15px and below", () => {
    expect(strokeFor(15)).toBe(1.6);
    expect(strokeFor(24)).toBe(1.6);
    expect(strokeFor(12)).toBe(2);
    expect(iconMarkup("chevronDown", 12)).toContain('stroke-width="2"');
  });
});
