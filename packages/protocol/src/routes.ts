/**
 * The URL path a route frame loads: `routePath` with its dynamic segments filled from `params`.
 *
 * Understands React Router (`:id`, optional `:id?`, splat `*`) and TanStack Router (`$id`,
 * `{$id}`, optional `{-$id}`, splat `$` filled by `_splat`). Values are percent-encoded, except a
 * splat's slashes. An unfilled optional segment is dropped; an unfilled required one stays as
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

function parseSegment(
  segment: string,
): { name: string; optional: boolean; splat: boolean } | undefined {
  if (segment === "*") return { name: "*", optional: true, splat: true };
  if (segment === "$") return { name: "_splat", optional: true, splat: true };
  const colon = /^:([^?]+)(\?)?$/.exec(segment);
  if (colon) return { name: colon[1]!, optional: colon[2] === "?", splat: false };
  const braced = /^\{(-)?\$([^}]+)\}$/.exec(segment);
  if (braced) return { name: braced[2]!, optional: braced[1] === "-", splat: false };
  const dollar = /^\$(.+)$/.exec(segment);
  if (dollar) return { name: dollar[1]!, optional: false, splat: false };
  return undefined;
}
