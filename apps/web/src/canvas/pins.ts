import type { Comment, CommentAnchor, Rect } from "@finite/protocol";
import type { PinState } from "../components/PinIcon";
import type { Point } from "./gestures";

/** Where a pin sits, in canvas units, and whether its element no longer renders. */
export type PinSpot = { at: Point; moved: boolean };

/**
 * Where a comment's pin goes: the top-right corner of its element's box (the `index`th instance
 * of `loc`), else its frame's top-right corner, marked `moved` when the frame answers but the
 * element is gone. A canvas comment sits where it was put.
 */
export function pinSpot(
  anchor: CommentAnchor,
  frame: (id: string) => { box: Rect } | undefined,
  rects: Readonly<Record<string, Rect[]>> | null,
): PinSpot | null {
  if (!("frameId" in anchor)) return { at: { x: anchor.x, y: anchor.y }, moved: false };
  const f = frame(anchor.frameId);
  if (!f) return null;
  const corner = { x: f.box.x + f.box.width, y: f.box.y };
  if (anchor.loc === undefined) return { at: corner, moved: false };
  const r = rects?.[anchor.loc]?.[anchor.index ?? 0];
  if (r) return { at: { x: f.box.x + r.x + r.width, y: f.box.y + r.y }, moved: false };
  // Measured and not there: the element moved or went. Unmeasured (unmounted): just the corner.
  return { at: corner, moved: rects !== null };
}

export function pinState(comment: Comment): PinState {
  if (comment.resolvedAt !== undefined) return "resolved";
  const last = comment.replies.at(-1)?.author ?? comment.author;
  return last.kind === "agent" ? "replied" : "waiting";
}
