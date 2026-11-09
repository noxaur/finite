import type { Loc } from "@finite/protocol";
import {
  bendSegment,
  deleteAnchors,
  hitTest,
  insertPoint,
  isEndpoint,
  joinEnds,
  moveAnchors,
  moveHandle,
  pullHandles,
  type Ref,
  snapAngle,
  toCorner,
} from "../../design/vector/edit";
import { mapPaths, parsePath, type Point, type SubPath } from "../../design/vector/path";
import { keyOf, selectionStore } from "../selection";
import type { CommandDef } from "./commands";
import type { Gesture, PressPlan, ToolDef, ToolHost } from "./host";
import {
  commit,
  editPending,
  findNode,
  gestureEnded,
  gestureStarted,
  joinSelected,
  previewPath,
  syncVector,
  update,
  userPoint,
  type VectorEditing,
  vectorEditing,
  worldMap,
} from "./vectorState";

/** How near a point, handle or segment a press lands on it, in screen pixels. */
const HIT_PX = 7;
const SNAP_PX = 10;

/** Opens a `<path>` for point editing. */
export async function enterVector(host: ToolHost, frameId: string, loc: Loc, index: number) {
  const bridge = host.bridge(frameId);
  if (!bridge) return;
  const [info, inspection] = await Promise.all([
    bridge.vector(loc, index).catch(() => null),
    bridge.inspect(loc, index).catch(() => null),
  ]);
  if (!info || !inspection) return host.say("Only a path can be edited point by point.");
  let paths: SubPath[];
  try {
    paths = parsePath(info.d);
  } catch {
    return host.say("This path's geometry can't be read as points. Ask the agent to change it.");
  }
  if (paths.length === 0)
    return host.say("This path has nothing to edit. Ask the agent to give it a shape.");
  host.setTool("vectorEdit");
  vectorEditing.set({
    frameId,
    loc,
    index,
    rev: inspection.rev,
    ctm: info.ctm,
    paths,
    picked: [],
    printed: info.d,
  });
}

const isPicked = (picked: readonly Ref[], ref: Ref) =>
  picked.some((r) => r.sub === ref.sub && r.i === ref.i);
const toggled = (picked: readonly Ref[], ref: Ref) =>
  isPicked(picked, ref)
    ? picked.filter((r) => r.sub !== ref.sub || r.i !== ref.i)
    : [...picked, ref];

/** A gesture over a copy of the paths: every move recomputes from the press and previews. */
function gestureOver(
  host: ToolHost,
  s: VectorEditing,
  apply: (origin: SubPath[], to: Point, e: PointerEvent) => SubPath[],
  atEnd?: (now: SubPath[], picked: Ref[]) => { paths: SubPath[]; picked: Ref[] },
): Gesture {
  const origin = s.paths;
  let moved = false;
  gestureStarted();
  const bridge = host.bridge(s.frameId);
  return {
    move: (_, world, e) => {
      const now = vectorEditing.get();
      const to = now && userPoint(host, now, world);
      if (!now || !to) return;
      moved = true;
      const paths = apply(origin, to, e);
      update({ paths });
      previewPath(bridge, now.loc, paths);
    },
    end: (done) => {
      gestureEnded();
      const now = vectorEditing.get();
      if (!now) return;
      if (!done || !moved) {
        update({ paths: origin });
        if (moved) bridge?.preview(now.loc, null);
        return void syncVector(host);
      }
      const final = atEnd ? atEnd(now.paths, now.picked) : { paths: now.paths, picked: now.picked };
      commit(host, final.paths, final.picked);
    },
  };
}

export const vectorEdit = {
  id: "vectorEdit",
  group: "pen",
  label: "Edit points",
  keys: null,
  icon: "pen",
  cursor: "",
  enabled: true,
  hidden: true,
  sticky: true,
  pan: "empty",
  activate(host) {
    offSelection?.();
    offSelection = selectionStore.subscribe(() => {
      const s = vectorEditing.get();
      if (!s || selectionStore.get().some((i) => i.frameId === s.frameId && i.loc === s.loc))
        return;
      host.setTool("select");
    });
  },
  deactivate(host) {
    offSelection?.();
    offSelection = null;
    const s = vectorEditing.get();
    if (s && !editPending()) host.bridge(s.frameId)?.preview(s.loc, null);
    vectorEditing.set(null);
  },
  down(host, p): PressPlan | "pass" {
    const s = vectorEditing.get();
    const map = s && worldMap(host, s);
    if (!s || !map) return "pass";
    const world = mapPaths(s.paths, map);
    const within = HIT_PX / host.camera.view.zoom;
    const hit = hitTest(world, s.picked, p.world, within);
    if (!hit) {
      return {
        passive: true,
        begin: async () => null,
        click: () => host.setTool("select"),
      };
    }
    if (hit.kind === "handle") {
      return {
        click: () => {},
        begin: async () =>
          gestureOver(host, s, (o, to, e) =>
            moveHandle(
              o,
              hit.ref,
              hit.which,
              e.shiftKey ? snapAngle(o[hit.ref.sub]!.anchors[hit.ref.i]!.p, to) : to,
              e.altKey,
            ),
          ),
      };
    }
    if (hit.kind === "segment") {
      return {
        click: () => {
          const added = insertPoint(s.paths, hit.seg, hit.t);
          commit(host, added.paths, [added.ref]);
        },
        begin: async () => gestureOver(host, s, (o, to) => bendSegment(o, hit.seg, hit.t, to)),
      };
    }
    const { ref } = hit;
    if (p.deep) {
      return {
        click: () => commit(host, toCorner(s.paths, ref), [ref]),
        begin: async () => gestureOver(host, s, (o, to) => pullHandles(o, ref, to)),
      };
    }
    const already = isPicked(s.picked, ref);
    const picked = p.shift ? toggled(s.picked, ref) : already ? s.picked : [ref];
    update({ picked });
    return {
      click: () => {
        if (!p.shift && already) update({ picked: [ref] });
      },
      begin: async () => {
        const from = userPoint(host, s, p.world);
        if (!from) return null;
        const moving = picked.length > 0 ? picked : [ref];
        return gestureOver(
          host,
          s,
          (o, to, e) => {
            const a = o[ref.sub]!.anchors[ref.i]!.p;
            const snapped = e.shiftKey ? snapAngle(a, to) : to;
            return moveAnchors(o, moving, {
              x: snapped.x - (e.shiftKey ? a.x : from.x),
              y: snapped.y - (e.shiftKey ? a.y : from.y),
            });
          },
          // A dragged end let go on another end joins them.
          (now, nowPicked) => {
            if (moving.length !== 1) return { paths: now, picked: nowPicked };
            const at = now[ref.sub]!.anchors[ref.i]!.p;
            const m = worldMap(host, s);
            if (!m) return { paths: now, picked: nowPicked };
            const atWorld = m(at);
            const snap = SNAP_PX / host.camera.view.zoom;
            for (const [si, sp] of now.entries()) {
              for (const i of sp.closed ? [] : [0, sp.anchors.length - 1]) {
                if (si === ref.sub && i === ref.i) continue;
                const q = m(sp.anchors[i]!.p);
                if (Math.hypot(q.x - atWorld.x, q.y - atWorld.y) > snap) continue;
                if (!isEndpoint(now[ref.sub]!, ref.i)) continue;
                const onto = moveAnchors(now, [ref], {
                  x: sp.anchors[i]!.p.x - at.x,
                  y: sp.anchors[i]!.p.y - at.y,
                });
                const joined = joinEnds(onto, ref, { sub: si, i });
                if (joined) return { paths: joined, picked: [] };
              }
            }
            return { paths: now, picked: nowPicked };
          },
        );
      },
    };
  },
  key(host, e) {
    const s = vectorEditing.get();
    if (!s) return false;
    const mod = e.metaKey || e.ctrlKey;
    if (e.key === "Escape" || (!mod && e.key === "Enter")) {
      host.setTool("select");
      return true;
    }
    if (e.key === "Backspace" || e.key === "Delete") {
      if (s.picked.length > 0) commit(host, deleteAnchors(s.paths, s.picked), []);
      return true;
    }
    if (mod && !e.shiftKey && e.key.toLowerCase() === "j") {
      joinSelected(host);
      return true;
    }
    return false;
  },
} as const satisfies ToolDef<"vectorEdit">;

let offSelection: (() => void) | null = null;

/** Point editing on a selected path. */
export const vectorCommands: readonly CommandDef[] = [
  {
    id: "enterVector",
    keys: [{ key: "enter" }],
    enabled: true,
    when: (env) => !env.vector,
    run(host) {
      void enterSelected(host);
    },
  },
];

async function enterSelected(host: ToolHost) {
  const [item, ...rest] = selectionStore.get();
  if (!item || rest.length > 0 || item.loc === undefined) return;
  const facts = host.facts.get(keyOf(item));
  if (!facts) return;
  if (facts.tag === "path") return enterVector(host, item.frameId, item.loc, item.index ?? 0);
  if (facts.tag !== "svg") return;
  const bridge = host.bridge(item.frameId);
  const layers = await bridge?.layers().catch(() => null);
  const svg = layers && findNode(layers, item.loc, item.index ?? 0);
  const paths = svg?.children.filter((c) => c.tag === "path") ?? [];
  if (paths.length !== 1) return;
  const [only] = paths;
  host.select([host.selectHit(item.frameId, only!, only!.index, [])]);
  return enterVector(host, item.frameId, only!.loc, only!.index);
}
