import { shapeTool } from "./shapes";

const PAGE_FILL = "#f7f9fa";

/** Draws a frame: a new board on empty canvas, a container inside an existing frame. */
export const frame = shapeTool({
  id: "frame",
  group: "frame",
  label: "Frame",
  keys: { key: "f" },
  icon: "artboard",
  clickSize: (inFrame) => (inFrame ? { width: 200, height: 200 } : { width: 1280, height: 800 }),
  node: () => ({ tag: "div", name: "Frame", styles: { "background-color": PAGE_FILL } }),
});
