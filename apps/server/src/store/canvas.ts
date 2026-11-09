import { type Canvas, type CanvasPatch, type Frame, Refused } from "@finite/protocol";
import { applySectionPatch, inverseSectionPatch } from "./sections.ts";

type LocalPatch = Exclude<CanvasPatch, { op: "moveFramesTo" }>;

/** The canvas after `patch`. Refuses (`not-found`, `invalid`) instead of half-applying it. */
export function applyPatch(canvas: Canvas, patch: LocalPatch): Canvas {
  switch (patch.op) {
    case "moveFrames": {
      byId(
        canvas,
        patch.frames.map((f) => f.id),
      );
      const moved = new Map(patch.frames.map((f) => [f.id, f]));
      return {
        ...canvas,
        frames: canvas.frames.map((frame) => {
          const to = moved.get(frame.id);
          return to ? { ...frame, x: to.x, y: to.y } : frame;
        }),
      };
    }
    case "resizeFrames": {
      byId(
        canvas,
        patch.frames.map((f) => f.id),
      );
      const sized = new Map(patch.frames.map((f) => [f.id, f]));
      return {
        ...canvas,
        frames: canvas.frames.map((frame) => {
          const to = sized.get(frame.id);
          if (!to) return frame;
          const { hug: _hug, ...rest } = frame;
          const next: Frame = { ...rest, x: to.x, y: to.y, width: to.width, height: to.height };
          const hug = to.hug ?? frame.hug;
          return hug ? { ...next, hug } : next;
        }),
      };
    }
    case "addFrames": {
      const ids = new Set(canvas.frames.map((f) => f.id));
      for (const frame of patch.frames) {
        if (ids.has(frame.id)) {
          throw new Refused(
            `frame ${frame.id} is already on this canvas; pick a new id`,
            "invalid",
          );
        }
        ids.add(frame.id);
      }
      return { ...canvas, frames: [...canvas.frames, ...patch.frames] };
    }
    case "removeFrames": {
      byId(canvas, patch.frameIds);
      const gone = new Set(patch.frameIds);
      return { ...canvas, frames: canvas.frames.filter((f) => !gone.has(f.id)) };
    }
    case "renameFrame": {
      byId(canvas, [patch.frameId]);
      return {
        ...canvas,
        frames: canvas.frames.map((f) => (f.id === patch.frameId ? { ...f, name: patch.name } : f)),
      };
    }
    case "setText": {
      const exists = canvas.texts.some((t) => t.id === patch.text.id);
      return {
        ...canvas,
        texts: exists
          ? canvas.texts.map((t) => (t.id === patch.text.id ? patch.text : t))
          : [...canvas.texts, patch.text],
      };
    }
    case "removeText": {
      if (!canvas.texts.some((t) => t.id === patch.textId)) {
        throw new Refused(`no text ${patch.textId} on this canvas`, "not-found");
      }
      return { ...canvas, texts: canvas.texts.filter((t) => t.id !== patch.textId) };
    }
    case "setSection":
    case "removeSection":
    case "moveSection":
    case "setSlice":
    case "removeSlice":
      return applySectionPatch(canvas, patch);
  }
}

/**
 * Moves frames, and the comments and slices pinned to them, from one canvas to another. Returns both
 * canvases after the move.
 */
export function moveFramesTo(
  from: Canvas,
  to: Canvas,
  frameIds: string[],
): { from: Canvas; to: Canvas } {
  if (from.id === to.id) throw new Refused("the frames are already on that canvas", "invalid");
  byId(from, frameIds);
  const moving = new Set(frameIds);
  const taken = new Set(to.frames.map((f) => f.id));
  for (const id of frameIds) {
    if (taken.has(id)) {
      throw new Refused(`canvas ${to.name} already has a frame ${id}`, "invalid");
    }
  }
  const pinned = (c: Canvas["comments"][number]) =>
    "frameId" in c.anchor && moving.has(c.anchor.frameId);
  return {
    from: {
      ...from,
      frames: from.frames.filter((f) => !moving.has(f.id)),
      comments: from.comments.filter((c) => !pinned(c)),
      slices: from.slices.filter((s) => !moving.has(s.frameId)),
    },
    to: {
      ...to,
      frames: [...to.frames, ...from.frames.filter((f) => moving.has(f.id))],
      comments: [...to.comments, ...from.comments.filter(pinned)],
      slices: [...to.slices, ...from.slices.filter((s) => moving.has(s.frameId))],
    },
  };
}

/** Refuses when any of `ids` isn't a frame on the canvas. */
function byId(canvas: Canvas, ids: string[]): void {
  const have = new Set(canvas.frames.map((f) => f.id));
  const missing = ids.filter((id) => !have.has(id));
  if (missing.length) {
    throw new Refused(
      `no frame ${missing.join(", ")} on canvas ${canvas.name}; it may have been removed`,
      "not-found",
    );
  }
}

/** A patch and the canvas it applies to. */
export type Step = { canvasId: string; patch: CanvasPatch };

/** The patch that takes `patch` back, given the canvas before it was applied. */
export function inversePatch(before: Canvas, patch: CanvasPatch): Step {
  const frame = (id: string) => before.frames.find((f) => f.id === id)!;
  const on = (p: CanvasPatch): Step => ({ canvasId: before.id, patch: p });
  switch (patch.op) {
    case "moveFrames":
      return on({
        op: "moveFrames",
        frames: patch.frames.map(({ id }) => ({ id, x: frame(id).x, y: frame(id).y })),
      });
    case "resizeFrames":
      return on({
        op: "resizeFrames",
        frames: patch.frames.map(({ id }) => {
          const { x, y, width, height, hug } = frame(id);
          return { id, x, y, width, height, hug: hug ?? false };
        }),
      });
    case "addFrames":
      return on({ op: "removeFrames", frameIds: patch.frames.map((f) => f.id) });
    case "removeFrames":
      return on({ op: "addFrames", frames: patch.frameIds.map(frame) });
    case "renameFrame":
      return on({ op: "renameFrame", frameId: patch.frameId, name: frame(patch.frameId).name });
    case "moveFramesTo":
      return {
        canvasId: patch.toCanvasId,
        patch: { op: "moveFramesTo", frameIds: patch.frameIds, toCanvasId: before.id },
      };
    case "setText": {
      const old = before.texts.find((t) => t.id === patch.text.id);
      return on(old ? { op: "setText", text: old } : { op: "removeText", textId: patch.text.id });
    }
    case "removeText": {
      const old = before.texts.find((t) => t.id === patch.textId)!;
      return on({ op: "setText", text: old });
    }
    case "setSection":
    case "removeSection":
    case "moveSection":
    case "setSlice":
    case "removeSlice":
      return on(inverseSectionPatch(before, patch));
  }
}
