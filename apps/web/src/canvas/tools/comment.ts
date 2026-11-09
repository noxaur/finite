import type { CommentAnchor, Frame } from "@finite/protocol";
import { bridgeOf } from "../bridge";
import type { Point } from "../gestures";
import type { ToolDef, ToolHost } from "./host";
import { notBuilt } from "./host";

/** Places a comment on what's clicked, or on the canvas. */
export const comment = {
  id: "comment",
  group: "comment",
  label: "Comment",
  keys: { key: "c" },
  icon: "comment",
  cursor: "crosshair",
  enabled: true,
  sticky: true,
  hover: true,
  down(host, p) {
    return { begin: async () => null, click: () => placeComment(host, p.world, p.frame) };
  },
} as const satisfies ToolDef<"comment">;

export const annotation = {
  id: "annotation",
  group: "comment",
  label: "Annotation",
  keys: { key: "y" },
  icon: "annotation",
  cursor: "crosshair",
  enabled: false,
  sticky: true,
  down: notBuilt("Annotation"),
} as const satisfies ToolDef<"annotation">;

async function placeComment(host: ToolHost, world: Point, frame: Frame | null) {
  if (!frame)
    return host.update({ commentDraft: { anchor: { x: world.x, y: world.y }, at: world } });
  const p = host.local(frame, world);
  const hit = await bridgeOf(frame.id)
    ?.hit(p.x, p.y)
    .catch(() => null);
  const b = host.boxOf(frame);
  const anchor: CommentAnchor = hit
    ? { frameId: frame.id, loc: hit.loc, index: hit.index }
    : { frameId: frame.id };
  const at = hit
    ? { x: b.x + hit.rect.x + hit.rect.width, y: b.y + hit.rect.y }
    : { x: b.x + b.width, y: b.y };
  host.update({ commentDraft: { anchor, at }, openComment: null });
}
