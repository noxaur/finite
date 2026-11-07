import type { FrameSource } from "./model.ts";

/**
 * The URL path a route frame loads: `routePath` with its dynamic segments filled from `params`.
 *
 * Understands React Router (`:id`, optional `:id?`, splat `*`), TanStack Router (`$id`, `{$id}`,
 * optional `{-$id}`, splat `$` filled by `_splat`) and Next.js (`[id]`, catch-all `[...slug]`,
 * optional catch-all `[[...slug]]`). Values are percent-encoded, except a splat's slashes. An unfilled optional segment is dropped; an unfilled required one stays as
 * written, so the app's own 404 shows rather than a wrong page.
 */
export function routeHref(routePath: string, params: Readonly<Record<string, string>>): string {
  const segments = routePath.split("/").flatMap((segment) => {
    const param = parseSegment(segment);
    if (!param) return [segment];
    const value = params[param.name];
    if (value === undefined || value === "") return param.optional ? [] : [segment];
    return [param.splat ? encodeURI(value) : encodeURIComponent(value)];
  });
  const path = segments.join("/");
  return path.startsWith("/") ? path : `/${path}`;
}

/**
 * The URL a frame's iframe loads from a design's preview URL: the route's path with its params
 * filled in by `routeHref`, or the plugin's frame page for one file's export. The preview URL may
 * end in a base path (a Next.js `basePath`), and the frame's path goes under it.
 */
export function frameHref(previewUrl: string, source: FrameSource): string {
  const base = previewUrl.replace(/\/+$/, "");
  if (source.kind === "file") {
    const query = new URLSearchParams({ file: source.file });
    if (source.exportName !== undefined) query.set("export", source.exportName);
    return `${base}/__finite/frame?${query.toString()}`;
  }
  const href = routeHref(source.path, source.params ?? {});
  // Next redirects `<basePath>/` to `<basePath>`, so the home route is the base itself.
  return href === "/" && new URL(base).pathname !== "/" ? base : base + href;
}

function parseSegment(
  segment: string,
): { name: string; optional: boolean; splat: boolean } | undefined {
  if (segment === "*") return { name: "*", optional: true, splat: true };
  if (segment === "$") return { name: "_splat", optional: true, splat: true };
  const colon = /^:([^?]+)(\?)?$/.exec(segment);
  if (colon) return { name: colon[1]!, optional: colon[2] === "?", splat: false };
  const braced = /^\{(-)?\$([^}]+)\}$/.exec(segment);
  if (braced) return { name: braced[2]!, optional: braced[1] === "-", splat: false };
  const optionalCatchAll = /^\[\[\.\.\.([^\]]+)\]\]$/.exec(segment);
  if (optionalCatchAll) return { name: optionalCatchAll[1]!, optional: true, splat: true };
  const bracket = /^\[(\.\.\.)?([^\]]+)\]$/.exec(segment);
  if (bracket) return { name: bracket[2]!, optional: false, splat: Boolean(bracket[1]) };
  const dollar = /^\$(.+)$/.exec(segment);
  if (dollar) return { name: dollar[1]!, optional: false, splat: false };
  return undefined;
}
