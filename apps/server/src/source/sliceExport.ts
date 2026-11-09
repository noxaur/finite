import { clampInside, type OpenDesign, type Previews, Refused } from "@finite/protocol";
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
  // A frame that was narrowed or shortened since leaves less of the slice to show, kept by the
  // same rule the page draws it with. A hugging frame has no fixed height here, so only its
  // width bounds the slice.
  const box = clampInside(slice, {
    width: frame.width,
    height: frame.hug ? Infinity : frame.height,
  });
  await render.previews.ensure(open.design);
  const png = await render.screenshots.capture(
    render.previews.frameUrl(open.design.id, frame.source),
    frame.width,
    frame.height,
    box,
  );
  return { url: `data:image/png;base64,${Buffer.from(png).toString("base64")}` };
}
