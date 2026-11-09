import type { Slice } from "@finite/protocol";
import { clampInside, freeName, rounded } from "../objects";
import type { ToolDef, ToolHost } from "./host";

/** The size a click makes a slice, in the frame's own pixels. */
const CLICK_SIZE = 200;

/** Marks a region of one frame for export as a PNG. */
export const slice = {
  id: "slice",
  group: "frame",
  label: "Slice",
  keys: { key: "s" },
  icon: "slice",
  cursor: "crosshair",
  enabled: true,
  down(host, p) {
    const frame = p.frame;
    if (!frame) {
      host.say("Slices go inside a frame.");
      return "pass";
    }
    const from = host.local(frame, p.world);
    const place = (box: { x: number; y: number; width: number; height: number }) =>
      addSlice(host, frame.id, clampInside(rounded(box), host.boxOf(frame)));
    return {
      click: () => place({ ...from, width: CLICK_SIZE, height: CLICK_SIZE }),
      begin: async () => {
        let box: { x: number; y: number; width: number; height: number } | null = null;
        const origin = host.boxOf(frame);
        return {
          move: (_screen, world) => {
            const to = host.local(frame, world);
            const x = Math.min(from.x, to.x);
            const y = Math.min(from.y, to.y);
            box = clampInside(
              { x, y, width: Math.abs(to.x - from.x), height: Math.abs(to.y - from.y) },
              origin,
            );
            host.setGhost({ box: { ...box, x: origin.x + box.x, y: origin.y + box.y } });
          },
          end: async (commit) => {
            host.setGhost(null);
            if (commit && box) await place(box);
          },
        };
      },
    };
  },
} as const satisfies ToolDef<"slice">;

async function addSlice(
  host: ToolHost,
  frameId: string,
  box: { x: number; y: number; width: number; height: number },
) {
  const made: Slice = {
    id: crypto.randomUUID(),
    frameId,
    name: freeName(
      host.slices.map((s) => s.name),
      "Slice",
    ),
    ...box,
  };
  await host.patch({ op: "setSlice", slice: made });
  host.selectObject({ kind: "slice", id: made.id });
}
