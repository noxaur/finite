import { finite } from "@/client/finite";
import type { Rect } from "@finite/protocol";
import { planInsert } from "@/design/editing/insertion";
import { revsOf } from "../gestures";
import { undoOrderFor } from "../undoOrder";
import type { Placed, ToolHost } from "./host";

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** How long the new element may take to reach the frame, in milliseconds. */
const LANDING_MS = 4000;
const LANDING_STEP_MS = 150;
const REF = "new";

/** Adds `node` where `box` lands: into the frame under its center, or as a new one on empty canvas. */
export async function draw(
  host: ToolHost,
  input: Parameters<ToolHost["draw"]>[0],
): Promise<Placed | null> {
  const { box, node, deep = false, alt = false } = input;
  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const frame = host.frameAt(center);
  if (!frame) {
    try {
      const made = await finite.request("canvas.draw", {
        designId: host.designId,
        canvasId: host.canvasId,
        box,
        name: node.name ?? node.tag,
        node: { ...node, ref: REF },
      });
      undoOrderFor(host.designId).did({ kind: "canvas", canvasId: host.canvasId });
      host.select([{ frameId: made.frameId, name: node.name ?? node.tag }]);
      return { frameId: made.frameId, loc: made.created[REF] ?? "", index: 0 };
    } catch (e) {
      host.say(errorText(e));
      return null;
    }
  }

  const bridge = host.bridge(frame.id);
  const at = host.local(frame, center);
  const drop = await bridge?.drop(at.x, at.y).catch(() => null);
  if (!bridge || !drop || drop.chain.length === 0) {
    host.say("This frame has nothing to draw into yet. Wait for it to load, then try again.");
    return null;
  }
  const local: Rect = { ...host.local(frame, box), width: box.width, height: box.height };
  const plan = planInsert(drop.chain, host.ownFile(frame), local, {
    deep,
    alt,
    nodeTag: node.tag,
  });
  if ("refuse" in plan) {
    host.say(plan.refuse);
    return null;
  }
  const { anchor, makeRelative } = plan;
  const done = await host.edit(
    [
      ...(makeRelative
        ? [
            {
              kind: "style" as const,
              locs: [makeRelative.loc],
              tag: makeRelative.tag,
              styles: { position: "relative" },
              revs: revsOf([makeRelative]),
            },
          ]
        : []),
      {
        kind: "insert" as const,
        loc: anchor.loc,
        tag: anchor.tag,
        place: anchor.place,
        node: { ...node, ref: REF, styles: { ...plan.styles, ...node.styles } },
        revs: revsOf([anchor]),
      },
    ],
    [...drop.chain].reverse(),
  );
  if (!done) return null;
  const loc = done.created[REF];
  if (!loc) return null;
  if (plan.label) host.say(plan.label);

  // Which instance is the drawn one: the new element's index need not match its container's.
  for (const end = performance.now() + LANDING_MS; performance.now() < end;) {
    const rects = await bridge.rects([loc]).catch(() => ({}) as Record<string, Rect[]>);
    const found = rects[loc];
    if (found && found.length > 0) {
      const hit = found.findIndex(
        (r) => at.x >= r.x && at.x < r.x + r.width && at.y >= r.y && at.y < r.y + r.height,
      );
      const index = Math.max(hit, 0);
      host.select([{ frameId: frame.id, loc, index, name: node.name ?? node.tag }]);
      return { frameId: frame.id, loc, index };
    }
    await new Promise((resolve) => setTimeout(resolve, LANDING_STEP_MS));
  }
  return null;
}
