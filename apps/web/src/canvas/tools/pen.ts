import type { NewNode } from "@finite/protocol";
import { fitStroke } from "../../design/vector/fit";
import { snapAngle } from "../../design/vector/edit";
import { reframe, type SubPath } from "../../design/vector/path";
import { selectionStore } from "../selection";
import type { Gesture, ToolDef, ToolHost } from "./host";
import { findNode, penDraft, pencilStroke } from "./vectorState";

/** How near an anchor a press lands on it, in screen pixels. */
const ON_ANCHOR_PX = 9;
/** How closely the pencil's curves follow the stroke, in screen pixels. */
const FIT_PX = 2;

/** An `<svg>` holding one path. Stretching its box keeps the stroke's width, and the geometry. */
function vectorNode(name: string, d: string, viewBox: string): NewNode {
  return {
    tag: "svg",
    name,
    attrs: { viewBox, preserveAspectRatio: "none" },
    styles: { overflow: "visible" },
    children: [
      {
        tag: "path",
        attrs: { d, vectorEffect: "non-scaling-stroke" },
        styles: { fill: "none", stroke: "#000000", "stroke-width": "2px" },
      },
    ],
  };
}

/** Draws the shape and selects its path, so fill, stroke and Enter reach the vector at once. */
async function place(host: ToolHost, paths: SubPath[], name: string) {
  const { box, d, viewBox } = reframe(paths);
  const placed = await host.draw({ box, node: vectorNode(name, d, viewBox) });
  if (!placed?.selected) return;
  const landed = selectionStore.get();
  const layers = await host
    .bridge(placed.frameId)
    ?.layers()
    .catch(() => null);
  const svg = layers && findNode(layers, placed.loc, placed.index);
  const path = svg?.children.find((c) => c.tag === "path");
  if (svg && path && selectionStore.get() === landed) {
    host.select([host.selectHit(placed.frameId, path, path.index, [svg])]);
  }
}

/** The canvas the pen's draft was started on. */
let draftOwner: ToolHost | null = null;

/** Writes the pen's path, if it has one, and hands back to Move unless asked to stay out of it. */
async function finish(host: ToolHost, closed: boolean, leave = true) {
  const draft = penDraft.get();
  penDraft.set(null);
  if (!draft || draft.anchors.length < 2) return;
  await place(host, [{ anchors: draft.anchors, closed }], "Vector");
  // A new draft started while this one landed keeps the pen.
  if (leave && host.state.tool === "pen" && !penDraft.get()) host.setTool("select");
}

/** Removes the anchor placed last. */
function dropLast() {
  const draft = penDraft.get();
  if (!draft) return;
  const anchors = draft.anchors.slice(0, -1);
  penDraft.set(anchors.length > 0 ? { ...draft, anchors } : null);
}

export const pen = {
  id: "pen",
  group: "pen",
  label: "Pen",
  keys: { key: "p" },
  icon: "pen",
  cursor: "crosshair",
  enabled: true,
  sticky: true,
  activate(host) {
    // A held key picks the tool again, and that mustn't cost the draft.
    if (draftOwner !== host) penDraft.set(null);
    draftOwner = host;
  },
  deactivate: (host) => void finish(host, false, false),
  down(host, p) {
    const anchors = penDraft.get()?.anchors ?? [];
    const near = ON_ANCHOR_PX / host.camera.view.zoom;
    const onto = (a: (typeof anchors)[number] | undefined) =>
      a !== undefined && Math.hypot(a.p.x - p.world.x, a.p.y - p.world.y) <= near;
    if (anchors.length >= 2 && onto(anchors[0])) {
      const close = () => finish(host, true);
      return { click: close, begin: async () => (void close(), null) };
    }
    if (onto(anchors.at(-1))) {
      const end = () => finish(host, false);
      return { click: end, begin: async () => (void end(), null) };
    }
    const last = anchors.at(-1);
    const at = p.shift && last ? snapAngle(last.p, p.world) : p.world;
    const index = anchors.length;
    penDraft.set({
      closed: false,
      anchors: [...anchors, { p: at, in: null, out: null, mode: "none" }],
    });
    return { click: () => {}, begin: async () => pullHandles(index) };
  },
  key(host, e) {
    if (!penDraft.get()) return false;
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "z") {
      dropLast();
      return true;
    }
    if (e.key === "Backspace" || e.key === "Delete") {
      dropLast();
      return true;
    }
    if (e.key === "Enter" || e.key === "Escape") {
      void finish(host, false);
      return true;
    }
    return false;
  },
} as const satisfies ToolDef<"pen">;

/** Drags the anchor's handles out: Alt leaves the incoming one where it was. */
function pullHandles(index: number): Gesture {
  return {
    move: (_, world, e) => {
      const draft = penDraft.get();
      const anchor = draft?.anchors[index];
      if (!draft || !anchor) return;
      const out = e.shiftKey ? snapAngle(anchor.p, world) : world;
      const anchors = draft.anchors.slice();
      anchors[index] = {
        ...anchor,
        out,
        in: e.altKey ? anchor.in : { x: 2 * anchor.p.x - out.x, y: 2 * anchor.p.y - out.y },
        mode: e.altKey ? "none" : "mirror",
      };
      penDraft.set({ ...draft, anchors });
    },
    end: () => {},
  };
}

export const pencil = {
  id: "pencil",
  group: "pen",
  label: "Pencil",
  keys: { key: "p", shift: true },
  icon: "pencil",
  cursor: "crosshair",
  enabled: true,
  sticky: true,
  down(host, p) {
    return {
      click: () => {},
      begin: async () => {
        const points = [p.world];
        pencilStroke.set(points);
        return {
          move: (_, world) => {
            points.push(world);
            pencilStroke.set([...points]);
          },
          end: async (commit) => {
            pencilStroke.set(null);
            if (!commit || points.length < 2) return;
            const stroke = fitStroke(points, FIT_PX / host.camera.view.zoom);
            if (stroke.anchors.length >= 2) await place(host, [stroke], "Vector");
          },
        };
      },
    };
  },
} as const satisfies ToolDef<"pencil">;
