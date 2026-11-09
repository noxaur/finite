import { type OpenDesign, type Previews, Refused } from "@finite/protocol";
import type { Screenshots } from "../agent/screenshot.ts";

/** What exporting needs: the design's running preview and Chrome. */
export type SliceRenderer = { previews: Previews; screenshots: Screenshots };

/** Renders a slice to a PNG in Chrome, as a `data:` URL ready for a download link. */
export async function exportSlice(
  render: SliceRenderer | undefined,
  open: OpenDesign,
  { canvasId, sliceId }: { canvasId: string; sliceId: string },
): Promise<{ url: string }> {
  if (!render) {
    throw new Refused(
      "Slice export needs the preview and Chrome, which aren't running.",
      "not-implemented",
    );
  }
  const canvas = (await open.canvases()).find((c) => c.id === canvasId && !c.removedAt);
  if (!canvas) throw new Refused(`no canvas ${canvasId} in this design`, "not-found");
  const slice = canvas.slices.find((s) => s.id === sliceId);
  if (!slice) throw new Refused(`no slice ${sliceId} on canvas ${canvas.name}`, "not-found");
  const frame = canvas.frames.find((f) => f.id === slice.frameId);
  if (!frame) {
    throw new Refused(
      `The frame ${slice.name} sits in was removed. Undo the removal to export it.`,
      "not-found",
    );
  }
  // A frame that was narrowed since leaves less of the slice to show.
  const x = Math.min(Math.max(0, slice.x), frame.width - 1);
  const width = Math.min(slice.width, frame.width - x);
  await render.previews.ensure(open.design);
  const png = await render.screenshots.capture(
    render.previews.frameUrl(open.design.id, frame.source),
    frame.width,
    frame.height,
    { x, y: Math.max(0, slice.y), width, height: slice.height },
  );
  return { url: `data:image/png;base64,${Buffer.from(png).toString("base64")}` };
}
