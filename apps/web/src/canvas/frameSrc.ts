import type { FrameSource } from "@finite/protocol";

/**
 * Where a frame's iframe loads from on the design's Vite server: the route's path with its
 * params filled in (`:id` and `$id` both), or the plugin's frame page for one file's export.
 */
export function frameSrc(previewUrl: string, source: FrameSource): string {
  if (source.kind === "route") {
    const params = source.params ?? {};
    const path = source.path.replace(/[:$]([A-Za-z_][\w]*)/g, (whole, name: string) =>
      params[name] !== undefined ? encodeURIComponent(params[name]) : whole,
    );
    return new URL(path.startsWith("/") ? path : `/${path}`, previewUrl).href;
  }
  const url = new URL("/__finite/frame", previewUrl);
  url.searchParams.set("file", source.file);
  if (source.exportName !== undefined) url.searchParams.set("export", source.exportName);
  return url.href;
}
