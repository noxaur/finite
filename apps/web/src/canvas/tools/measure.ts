import type { Rect } from "@finite/protocol";
import { createStore, keyOf, selectionStore } from "../selection";
import type { ToolDef, ToolHost } from "./host";

/** The box measured from, in canvas units: set by a click, gone when the tool is picked again. */
export const measureFrom = createStore<Rect | null>(null);

/** What's under the pointer, as a box in canvas units: an element's box, else its frame's. */
export function hoveredBox(host: ToolHost): Rect | null {
  const h = host.state.hover;
  const frame = h && host.frame(h.frameId);
  if (!h || !frame) return null;
  const b = host.boxOf(frame);
  return { x: b.x + h.rect.x, y: b.y + h.rect.y, width: h.rect.width, height: h.rect.height };
}

/** The first selected thing, as a box in canvas units. */
export function selectedBox(host: ToolHost): Rect | null {
  const [first] = selectionStore.get();
  const frame = first && host.frame(first.frameId);
  if (!first || !frame) return null;
  const b = host.boxOf(frame);
  if (first.loc === undefined) return b;
  const r = host.state.rects[keyOf(first)];
  return r ? { x: b.x + r.x, y: b.y + r.y, width: r.width, height: r.height } : null;
}

/**
 * Shows the distances between two boxes. Click what to measure from (or select it first), then
 * move over another. It draws only an overlay (`MeasureOverlay`, which `Canvas` mounts while the
 * tool is on, since the registry stays free of components) and changes nothing.
 */
export const measure = {
  id: "measure",
  group: "comment",
  label: "Measurement",
  keys: { key: "m", shift: true },
  icon: "measure",
  cursor: "crosshair",
  enabled: true,
  sticky: true,
  hover: true,
  activate: () => measureFrom.set(null),
  down(host, p) {
    return {
      begin: async () => null,
      click: () => {
        const at = hoveredBox(host) ?? (p.frame ? host.boxOf(p.frame) : null);
        measureFrom.set(at);
      },
    };
  },
} as const satisfies ToolDef<"measure">;
