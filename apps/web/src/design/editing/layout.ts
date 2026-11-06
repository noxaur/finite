/** How an element lays its children out: block flow, a flex column or row, or a grid. */
export type LayoutKind = "block" | "column" | "row" | "grid";

/** Which layout a computed `display` and `flex-direction` make. */
export function layoutOf(display: string, direction: string): LayoutKind {
  const words = display.trim().toLowerCase().split(/\s+/);
  if (words.some((w) => w === "grid" || w === "inline-grid")) return "grid";
  if (words.some((w) => w === "flex" || w === "inline-flex")) {
    return direction.startsWith("column") ? "column" : "row";
  }
  return "block";
}

/** The styles that make an element lay its children out as `kind`. */
export function layoutStyles(kind: LayoutKind): Record<string, string | null> {
  switch (kind) {
    // Explicit, so it wins over a class that makes it flex or grid.
    case "block":
      return { display: "block", "flex-direction": null };
    case "column":
      return { display: "flex", "flex-direction": "column" };
    case "row":
      return { display: "flex", "flex-direction": "row" };
    case "grid":
      return { display: "grid", "flex-direction": null };
  }
}

/** Inline properties the Layout section reads and writes. */
export const LAYOUT_PROPS = [
  "display",
  "flex-direction",
  "flex-wrap",
  "justify-content",
  "align-items",
  "align-self",
  "gap",
  "row-gap",
  "column-gap",
  "grid-template-columns",
  "grid-template-rows",
] as const;
