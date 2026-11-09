/** Elements painted with `fill` and `stroke` rather than a background and a border. */
const SVG_PAINTED = new Set([
  "svg",
  "path",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
]);

/**
 * What Fill and Stroke edit for a selection. Everything SVG is painted as SVG, each `<svg>` holding
 * one stamped `<path>` through that path, since the path's own fill would override the wrapper's.
 */
export function paintTargets<T extends { inspection: { tag: string }; paint?: T | undefined }>(
  selected: readonly T[],
): { targets: readonly T[]; vector: boolean } {
  const vector = selected.length > 0 && selected.every((x) => SVG_PAINTED.has(x.inspection.tag));
  return { targets: vector ? selected.map((x) => x.paint ?? x) : selected, vector };
}
