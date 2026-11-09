import type { Frame, Hit, Rect } from "@finite/protocol";
import { draggedZoom } from "../../design/editing/autoLayout";
import { chainOf, type Handle, type Point, revsOf } from "../gestures";
import { keyOf, type SelectionItem, selectionStore } from "../selection";
import { pressTargets } from "./move";
import type { Gesture, ToolDef, ToolHost } from "./host";

const WHOLE_FRAME =
  "Scale works on elements. Resize the frame instead, or select an element in it.";

/** Scales an element with CSS `zoom`, which changes layout, unlike `transform`. */
export const scale = {
  id: "scale",
  group: "move",
  label: "Scale",
  keys: { key: "k" },
  icon: "scale",
  cursor: "nwse-resize",
  enabled: true,
  sticky: true,
  pan: "empty",
  hover: true,
  down(host, p) {
    const { target, screen, world, frame } = p;
    const { handle, titleId } = pressTargets(target);
    if (handle) {
      const key = handle.dataset.key!;
      const which = handle.dataset.handle as Handle;
      return { begin: () => beginScale(host, key, which, screen), click: () => {} };
    }
    if (titleId || !frame) {
      return {
        passive: true,
        begin: async () => null,
        click: () => {
          if (titleId) host.say(WHOLE_FRAME);
        },
      };
    }
    const q = host.local(frame, world);
    const hit =
      host
        .bridge(frame.id)
        ?.hit(q.x, q.y)
        .catch(() => null) ?? Promise.resolve(null);
    const pick = async () => ((await hit) ? select(host, frame, (await hit)!) : null);
    return {
      begin: async () => {
        const item = await pick();
        if (!item) return (host.say(WHOLE_FRAME), null);
        return beginScale(host, keyOf(item), "se", screen);
      },
      click: async () => {
        if (!(await pick())) host.say(WHOLE_FRAME);
      },
    };
  },
} as const satisfies ToolDef<"scale">;

function select(host: ToolHost, frame: Frame, hit: Hit): SelectionItem {
  const chain = chainOf(hit);
  const selected = selectionStore
    .get()
    .find(
      (s) => s.frameId === frame.id && s.loc !== undefined && chain.some((c) => c.loc === s.loc),
    );
  if (selected) return selected;
  const item = host.selectHit(frame.id, hit, hit.index, hit.path);
  selectionStore.set([item]);
  return item;
}

async function beginScale(
  host: ToolHost,
  key: string,
  handle: Handle,
  from: Point,
): Promise<Gesture | null> {
  const item = selectionStore.get().find((s) => keyOf(s) === key);
  const facts = host.facts.get(key);
  if (!item || item.loc === undefined || !facts) return (host.say(WHOLE_FRAME), null);
  const bridge = host.bridge(item.frameId);
  const rect = host.state.rects[key];
  const inspection = await bridge?.inspect(item.loc, item.index ?? 0).catch(() => null);
  if (!bridge || !inspection || !rect) return null;
  const loc = item.loc;
  const start = parseFloat(inspection.computed.zoom ?? "") || 1;
  let zoom = start;
  return {
    move: (screen) => {
      const k = host.camera.view.zoom;
      zoom = draggedZoom(
        rect,
        handle,
        { x: (screen.x - from.x) / k, y: (screen.y - from.y) / k },
        start,
      );
      bridge.preview(loc, { zoom: String(zoom) });
      void bridge.rects([loc]).then((r: Record<string, Rect[]>) => {
        const now = r[loc]?.[item.index ?? 0];
        if (now) host.update({ rects: { ...host.state.rects, [key]: now } });
      });
    },
    end: async (commit) => {
      if (commit && zoom !== start) {
        await host.edit([
          {
            kind: "style",
            locs: [loc],
            tag: facts.tag,
            styles: { zoom: zoom === 1 ? null : String(zoom) },
            revs: revsOf([{ loc, rev: facts.rev }]),
          },
        ]);
      } else bridge.preview(loc, null);
      void host.refreshSelection();
    },
  };
}
