import type { NewNode, Rect } from "@finite/protocol";
import type { Point } from "../gestures";
import type { Gesture, Ghost, ToolDef, ToolHost } from "./host";
import { notBuilt } from "./host";

/** How big a click makes a shape, in canvas units. */
const CLICK_SIZE = 100;

/** The box a drag from `from` to `to` draws: Shift makes it square, Alt grows it from the middle. */
export function dragBox(from: Point, to: Point, square: boolean, center: boolean): Rect {
  let w = to.x - from.x;
  let h = to.y - from.y;
  if (square) {
    const side = Math.max(Math.abs(w), Math.abs(h));
    w = Math.sign(w || 1) * side;
    h = Math.sign(h || 1) * side;
  }
  const x = center ? from.x - w : from.x;
  const y = center ? from.y - h : from.y;
  const right = from.x + w;
  const bottom = from.y + h;
  return {
    x: Math.round(Math.min(x, right)),
    y: Math.round(Math.min(y, bottom)),
    width: Math.max(1, Math.round(Math.abs(right - x))),
    height: Math.max(1, Math.round(Math.abs(bottom - y))),
  };
}

/** A tool that draws one element into a box. */
function shapeTool<Id extends string>(def: {
  id: Id;
  label: string;
  keys: ToolDef["keys"];
  icon: ToolDef["icon"];
  enabled: boolean;
  round?: boolean;
  node: (box: Rect) => NewNode;
}): ToolDef<Id> {
  return {
    id: def.id,
    group: "shape",
    label: def.label,
    keys: def.keys,
    icon: def.icon,
    cursor: "crosshair",
    enabled: def.enabled,
    down(host, p) {
      const place = (box: Rect) =>
        host.draw({ box, node: def.node(box), deep: p.deep, alt: p.alt });
      return {
        click: () =>
          place({
            x: Math.round(p.world.x),
            y: Math.round(p.world.y),
            width: CLICK_SIZE,
            height: CLICK_SIZE,
          }).then(() => {}),
        begin: async () => boxGesture(host, p.world, def.round === true, place),
      };
    },
  };
}

export function boxGesture(
  host: ToolHost,
  from: Point,
  round: boolean,
  place: (box: Rect) => Promise<unknown>,
): Gesture {
  let box: Rect | null = null;
  const ghost = (b: Rect): Ghost => (round ? { box: b, round } : { box: b });
  return {
    move: (_screen, world, e) => {
      box = dragBox(from, world, e.shiftKey, e.altKey);
      host.setGhost(ghost(box));
    },
    end: async (commit) => {
      host.setGhost(null);
      if (commit && box) await place(box);
    },
  };
}

export const rectangle = shapeTool({
  id: "rectangle",
  label: "Rectangle",
  keys: { key: "r" },
  icon: "box",
  enabled: true,
  node: () => ({ tag: "div", name: "Rectangle", styles: { "background-color": "#d9d9d9" } }),
});

export const ellipse = shapeTool({
  id: "ellipse",
  label: "Ellipse",
  keys: { key: "o" },
  icon: "ellipse",
  enabled: false,
  round: true,
  node: () => ({
    tag: "div",
    name: "Ellipse",
    styles: { "background-color": "#d9d9d9", "border-radius": "50%" },
  }),
});

const later = (
  id: string,
  label: string,
  keys: ToolDef["keys"],
  icon: ToolDef["icon"],
  group: ToolDef["group"] = "shape",
) => ({
  id,
  group,
  label,
  keys,
  icon,
  cursor: "crosshair",
  enabled: false,
  down: notBuilt(label),
});

export const frame = later("frame", "Frame", { key: "f" }, "artboard", "frame") as ToolDef<"frame">;
export const line = later("line", "Line", { key: "l" }, "line") as ToolDef<"line">;
export const arrow = later(
  "arrow",
  "Arrow",
  { key: "l", shift: true },
  "arrow",
) as ToolDef<"arrow">;
export const polygon = later("polygon", "Polygon", null, "polygon") as ToolDef<"polygon">;
export const star = later("star", "Star", null, "star") as ToolDef<"star">;
export const image = later(
  "image",
  "Image or video",
  { key: "k", shift: true, mod: true },
  "image",
) as ToolDef<"image">;
