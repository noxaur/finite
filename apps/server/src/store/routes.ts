import { randomUUID } from "node:crypto";
import type { Actor, Canvas, Frame, OpenDesign, Route } from "@finite/protocol";
import { paramSets, readWorkspace } from "./workspace.ts";

/** The page that shows one frame per route of the app. */
export const ROUTES_PAGE = "Routes";
/** The size a route's frame opens at. */
export const ROUTE_FRAME = { width: 1440, height: 900 };
const COLUMNS = 4;
const GAP_X = 160;
const GAP_Y = 240;
/** What a dynamic segment is filled with until someone picks a real value. */
const SAMPLE_PARAM = "1";

const FINITE: Actor = { kind: "person", id: "finite", name: "Finite" };

/**
 * `/` → Home, `/users/:userId` with `{ userId: "1" }` → `Users · userId=1`. Next's bracket
 * segments stay as written, so `/docs/[...slug]` → `Docs / [...slug]`.
 */
export function routeFrameName(path: string, params: Record<string, string> = {}): string {
  const words = path
    .split("/")
    .filter((s) => s && !/^[:$]|^\{-?\$|^\*$/.test(s))
    .map((s) => (s.startsWith("[") ? s : s.replace(/[-_.]+/g, " ")));
  const base = words.length ? words.join(" / ") : "Home";
  const name = base.charAt(0).toUpperCase() + base.slice(1);
  const filled = Object.entries(params).map(([k, v]) => `${k}=${v}`);
  return filled.length ? `${name} · ${filled.join(", ")}` : name;
}

/** Slot `i` of the grid routes are laid out in, left to right, then down. */
function slot(i: number): { x: number; y: number } {
  return {
    x: (i % COLUMNS) * (ROUTE_FRAME.width + GAP_X),
    y: Math.floor(i / COLUMNS) * (ROUTE_FRAME.height + GAP_Y),
  };
}

function overlaps(a: { x: number; y: number }, frames: readonly Frame[]): boolean {
  return frames.some(
    (f) =>
      a.x < f.x + f.width &&
      f.x < a.x + ROUTE_FRAME.width &&
      a.y < f.y + f.height &&
      f.y < a.y + ROUTE_FRAME.height,
  );
}

/** One frame's worth of a route: its path and the values for its dynamic segments. */
export type RouteView = { path: string; params: Record<string, string> };

/** `apps.<name>.routes` from `finite.json`: params for a route path, or several. */
export type ConfiguredRoutes = Record<string, Record<string, string> | Record<string, string>[]>;

/**
 * The frames the Routes page should show: each reported route with its configured params (one view
 * per params object) or the sample value, then each configured path the router doesn't report.
 */
export function routeViews(
  routes: readonly Route[],
  configured: ConfiguredRoutes = {},
): RouteView[] {
  const views: RouteView[] = [];
  const add = (path: string) => {
    for (const params of paramSets(configured[path]!)) views.push({ path, params });
  };
  for (const route of routes) {
    if (configured[route.path]) add(route.path);
    else {
      const params = Object.fromEntries(route.params.map((p) => [p, SAMPLE_PARAM]));
      views.push({ path: route.path, params });
    }
  }
  const reported = new Set(routes.map((r) => r.path));
  for (const path of Object.keys(configured)) if (!reported.has(path)) add(path);
  return views;
}

/** What a route frame matches by: its path and params, in a stable order. */
function viewKey(path: string, params: Record<string, string> = {}): string {
  return JSON.stringify([path, Object.entries(params).sort(([a], [b]) => (a < b ? -1 : 1))]);
}

/** A frame for each view, each at the first grid slot nothing sits in. */
export function routeFrames(views: readonly RouteView[], existing: readonly Frame[]): Frame[] {
  const taken = [...existing];
  const out: Frame[] = [];
  let i = 0;
  for (const { path, params } of views) {
    while (overlaps(slot(i), taken)) i++;
    const frame: Frame = {
      id: randomUUID(),
      name: routeFrameName(path, params),
      ...slot(i),
      ...ROUTE_FRAME,
      source: { kind: "route", path, ...(Object.keys(params).length ? { params } : {}) },
    };
    taken.push(frame);
    out.push(frame);
  }
  return out;
}

/**
 * The Routes page after the app's routes or its `finite.json` routes changed: a frame for each new
 * path and params, and frames neither source gives any more marked `gone` (kept where people put
 * them). `undefined` when nothing changes.
 */
export function syncedRoutesPage(
  page: Canvas,
  routes: readonly Route[],
  configured: ConfiguredRoutes = {},
): Canvas | undefined {
  const views = routeViews(routes, configured);
  const wanted = new Set(views.map((v) => viewKey(v.path, v.params)));
  const shown = new Set(
    page.frames.flatMap((f) =>
      f.source.kind === "route" ? [viewKey(f.source.path, f.source.params)] : [],
    ),
  );
  let changed = false;
  const frames = page.frames.map((f) => {
    if (f.source.kind !== "route") return f;
    const gone = !wanted.has(viewKey(f.source.path, f.source.params));
    if (gone === (f.gone === true)) return f;
    changed = true;
    if (gone) return { ...f, gone: true };
    const { gone: _gone, ...rest } = f;
    return rest;
  });
  const added = routeFrames(
    views.filter((v) => !shown.has(viewKey(v.path, v.params))),
    frames,
  );
  if (!changed && added.length === 0) return undefined;
  return { ...page, frames: [...frames, ...added] };
}

/**
 * Keeps the design's Routes page in step with the routes its dev server reports and, for a
 * workspace app, the `routes` its `finite.json` lists (read again each time). An unreadable
 * `finite.json` leaves the page as it is.
 */
export async function syncRoutes(open: OpenDesign, routes: readonly Route[]): Promise<void> {
  const page = (await open.canvases()).find(
    (c) => c.kind === "page" && c.name === ROUTES_PAGE && c.removedAt === undefined,
  );
  if (!page) return;
  const { workspace, app } = open.design;
  let configured: ConfiguredRoutes = {};
  if (workspace && app) {
    const read = await readWorkspace(workspace).catch(() => undefined);
    if (!read) return;
    configured = read.apps[app]?.routes ?? {};
  }
  await open.updateCanvas(page.id, (c) => syncedRoutesPage(c, routes, configured) ?? c, FINITE);
}
