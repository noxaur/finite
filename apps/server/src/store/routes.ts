import { randomUUID } from "node:crypto";
import type { Actor, Canvas, Frame, OpenDesign, Route } from "@finite/protocol";

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

/** `/` → Home, `/users/:userId` with `{ userId: "1" }` → `Users · userId=1`. */
export function routeFrameName(path: string, params: Record<string, string> = {}): string {
  const words = path
    .split("/")
    .filter((s) => s && !/^[:$]|^\{-?\$|^\*$/.test(s))
    .map((s) => s.replace(/[-_.]+/g, " "));
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

/** A frame for a route at the first grid slot nothing sits in. */
export function routeFrames(routes: readonly Route[], existing: readonly Frame[]): Frame[] {
  const taken = [...existing];
  const out: Frame[] = [];
  let i = 0;
  for (const route of routes) {
    while (overlaps(slot(i), taken)) i++;
    const params = Object.fromEntries(route.params.map((p) => [p, SAMPLE_PARAM]));
    const frame: Frame = {
      id: randomUUID(),
      name: routeFrameName(route.path, params),
      ...slot(i),
      ...ROUTE_FRAME,
      source: {
        kind: "route",
        path: route.path,
        ...(route.params.length ? { params } : {}),
      },
    };
    taken.push(frame);
    out.push(frame);
  }
  return out;
}

/**
 * The Routes page after the app's routes changed: a frame for each new route, and frames whose
 * route went away marked `gone` (kept where people put them). `undefined` when nothing changes.
 */
export function syncedRoutesPage(page: Canvas, routes: readonly Route[]): Canvas | undefined {
  const paths = new Set(routes.map((r) => r.path));
  const shown = new Set(
    page.frames.flatMap((f) => (f.source.kind === "route" ? [f.source.path] : [])),
  );
  let changed = false;
  const frames = page.frames.map((f) => {
    if (f.source.kind !== "route") return f;
    const gone = !paths.has(f.source.path);
    if (gone === (f.gone === true)) return f;
    changed = true;
    if (gone) return { ...f, gone: true };
    const { gone: _gone, ...rest } = f;
    return rest;
  });
  const added = routeFrames(
    routes.filter((r) => !shown.has(r.path)),
    frames,
  );
  if (!changed && added.length === 0) return undefined;
  return { ...page, frames: [...frames, ...added] };
}

/** Keeps the design's Routes page in step with the routes its dev server reports. */
export async function syncRoutes(open: OpenDesign, routes: readonly Route[]): Promise<void> {
  const page = (await open.canvases()).find(
    (c) => c.kind === "page" && c.name === ROUTES_PAGE && c.removedAt === undefined,
  );
  if (!page) return;
  await open.updateCanvas(page.id, (c) => syncedRoutesPage(c, routes) ?? c, FINITE);
}
