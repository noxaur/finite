import { type FrameSource, routeHref } from "@finite/protocol";

/**
 * Where a frame's iframe loads from on the design's Vite server: the route's path with its
 * params filled in by `routeHref` (the same formatter the server uses), or the plugin's frame page
 * for one file's export.
 */
export function frameSrc(previewUrl: string, source: FrameSource): string {
  if (source.kind === "route") {
    return new URL(routeHref(source.path, source.params ?? {}), previewUrl).href;
  }
  const url = new URL("/__finite/frame", previewUrl);
  url.searchParams.set("file", source.file);
  if (source.exportName !== undefined) url.searchParams.set("export", source.exportName);
  return url.href;
}
