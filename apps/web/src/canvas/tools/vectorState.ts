import type { FrameBridge, LayerNode, Loc, Rev } from "@finite/protocol";
import { joinPicked, type Ref, setMode } from "../../design/vector/edit";
import {
  type HandleMode,
  parsePath,
  type Point,
  printPath,
  type SubPath,
} from "../../design/vector/path";
import { fileOf, revsOf } from "../gestures";
import { createStore } from "../selection";
import type { ToolHost } from "./host";

/** How long an edit may take to reach the frame, in milliseconds. */
const LANDING_MS = 3000;
const LANDING_STEP_MS = 50;

/** The `<path>` being edited point by point. The `d` in the source stays the only store of it. */
export type VectorEditing = {
  frameId: string;
  loc: Loc;
  index: number;
  rev: Rev;
  /** From the path's coordinates to its frame's CSS pixels. */
  ctm: readonly [number, number, number, number, number, number];
  paths: SubPath[];
  picked: Ref[];
  /** The `d` that's in the file, or on its way there. */
  printed: string;
};

export const vectorEditing = createStore<VectorEditing | null>(null);
/** The pen's unfinished path, in canvas units. */
export const penDraft = createStore<SubPath | null>(null);
/** The pencil's stroke so far, in canvas units. */
export const pencilStroke = createStore<readonly Point[] | null>(null);

/** The path's coordinates in canvas units. */
export function worldMap(host: ToolHost, s: VectorEditing): ((p: Point) => Point) | null {
  const frame = host.frame(s.frameId);
  if (!frame) return null;
  const box = host.boxOf(frame);
  const [a, b, c, d, e, f] = s.ctm;
  return (p) => ({ x: box.x + a * p.x + c * p.y + e, y: box.y + b * p.x + d * p.y + f });
}

/** The inverse: a canvas point in the path's coordinates. */
export function userPoint(host: ToolHost, s: VectorEditing, world: Point): Point | null {
  const frame = host.frame(s.frameId);
  if (!frame) return null;
  const box = host.boxOf(frame);
  const [a, b, c, d, e, f] = s.ctm;
  const det = a * d - b * c;
  if (det === 0) return null;
  const x = world.x - box.x - e;
  const y = world.y - box.y - f;
  return { x: (d * x - c * y) / det, y: (-b * x + a * y) / det };
}

export const update = (patch: Partial<VectorEditing>) => {
  const s = vectorEditing.get();
  if (s) vectorEditing.set({ ...s, ...patch });
};

export const previewPath = (bridge: FrameBridge | undefined, loc: Loc, paths: SubPath[]) =>
  bridge?.preview(loc, { d: `path("${printPath(paths)}")` });

let gestures = 0;
export const gestureStarted = () => void gestures++;
export const gestureEnded = () => void gestures--;
/** Edits go one at a time, each after the last reached the frame, so each carries a fresh rev. */
let queue: Promise<void> = Promise.resolve();
let pending = 0;
export const editPending = () => pending > 0;

/** Waits for the frame to show a new rev after an edit, and takes it. */
async function landed(host: ToolHost, s: VectorEditing, before: string) {
  const bridge = host.bridge(s.frameId);
  for (const end = performance.now() + LANDING_MS; performance.now() < end;) {
    const now = await bridge?.inspect(s.loc, s.index).catch(() => null);
    if (now && now.rev !== before) {
      if (vectorEditing.get()?.loc === s.loc) update({ rev: now.rev });
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, LANDING_STEP_MS));
  }
}

/** Sends `paths` as the path's new `d`. On refusal, shows the file's `d` again. */
export function commit(host: ToolHost, paths: SubPath[], picked: Ref[]) {
  const s = vectorEditing.get();
  if (!s) return;
  const d = printPath(paths);
  if (paths.length === 0) return void removeShape(host, s);
  update({ paths, picked });
  if (d === s.printed) return host.bridge(s.frameId)?.preview(s.loc, null);
  update({ printed: d });
  pending++;
  queue = queue.then(async () => {
    try {
      const now = vectorEditing.get() ?? s;
      const done = await host.edit([
        {
          kind: "attr",
          loc: now.loc,
          name: "d",
          value: d,
          revs: revsOf([{ loc: now.loc, rev: now.rev }]),
        },
      ]);
      if (done) await landed(host, now, now.rev);
      else host.bridge(now.frameId)?.preview(now.loc, null);
    } finally {
      pending--;
    }
    await syncVector(host);
  });
}

/** Deleting every point removes the path, and its `<svg>` when nothing else is in it. */
async function removeShape(host: ToolHost, s: VectorEditing) {
  const bridge = host.bridge(s.frameId);
  const layers = await bridge?.layers().catch(() => null);
  const parent = layers && parentOf(layers, s.loc, s.index);
  const lone = parent?.tag === "svg" && parent.children.length === 1;
  const target = lone ? parent : { loc: s.loc, rev: s.rev };
  host.setTool("select");
  host.select([host.frameItem(s.frameId)]);
  await host.edit([
    {
      kind: "remove",
      locs: [target.loc],
      revs: revsOf([{ loc: target.loc, rev: target.rev }]),
    },
  ]);
}

function parentOf(nodes: readonly LayerNode[], loc: Loc, index: number): LayerNode | null {
  for (const n of nodes) {
    if (n.children.some((c) => c.loc === loc && c.index === index)) return n;
    const found = parentOf(n.children, loc, index);
    if (found) return found;
  }
  return null;
}

/** The layer at `loc` and `index`, anywhere in the tree. */
export function findNode(nodes: readonly LayerNode[], loc: Loc, index: number): LayerNode | null {
  for (const n of nodes) {
    if (n.loc === loc && n.index === index) return n;
    const found = findNode(n.children, loc, index);
    if (found) return found;
  }
  return null;
}

/** A frame updated: reads the path again, unless a gesture or edit is under way (they sync after). */
export async function syncVector(host: ToolHost) {
  const s = vectorEditing.get();
  if (!s || gestures > 0 || pending > 0) return;
  const bridge = host.bridge(s.frameId);
  if (!bridge) return;
  let info = await bridge.vector(s.loc, s.index).catch(() => null);
  let loc = s.loc;
  // Someone else's edit moved it in the file. A path whose `d` didn't change is still findable.
  if (!info) {
    const found = await findMoved(bridge, s);
    if (!found) {
      host.setTool("select");
      return host.say("This path changed in the file. Double-click it to edit its points again.");
    }
    info = found.info;
    loc = found.loc;
  }
  const inspection = await bridge.inspect(loc, s.index).catch(() => null);
  const now = vectorEditing.get();
  if (!inspection || !now || now.frameId !== s.frameId || gestures > 0 || pending > 0) return;
  const patch: Partial<VectorEditing> = { rev: inspection.rev, ctm: info.ctm, loc };
  if (info.d !== now.printed) {
    let paths: SubPath[];
    try {
      paths = parsePath(info.d);
    } catch {
      host.setTool("select");
      return host.say("This path's geometry can't be read as points any more.");
    }
    if (paths.length === 0) return host.setTool("select");
    const same =
      paths.length === now.paths.length &&
      paths.every((p, i) => p.anchors.length === now.paths[i]!.anchors.length);
    patch.paths = paths;
    patch.printed = info.d;
    if (!same) patch.picked = [];
  }
  vectorEditing.set({ ...now, ...patch });
  if (loc !== s.loc) {
    host.select([
      host.selectHit(s.frameId, { loc, rev: inspection.rev, tag: inspection.tag }, s.index, []),
    ]);
  }
}

async function findMoved(bridge: FrameBridge, s: VectorEditing) {
  const file = fileOf(s.loc);
  const nodes: LayerNode[] = [];
  const visit = (list: readonly LayerNode[]) => {
    for (const n of list) {
      if (n.tag === "path" && fileOf(n.loc) === file) nodes.push(n);
      visit(n.children);
    }
  };
  visit(await bridge.layers().catch(() => []));
  for (const n of nodes) {
    const info = await bridge.vector(n.loc, n.index).catch(() => null);
    if (info && info.d === s.printed) return { loc: n.loc, info };
  }
  return null;
}

/** Closes the picked end's path, or joins the two picked ends. */
export function joinSelected(host: ToolHost) {
  const s = vectorEditing.get();
  if (!s) return;
  const joined = joinPicked(s.paths, s.picked);
  if (joined) commit(host, joined, []);
  else host.say("Pick one end of an open path to close it, or two ends to join them.");
}

/** Sets the picked anchors' handle mode. */
export function setHandleMode(host: ToolHost, mode: HandleMode) {
  const s = vectorEditing.get();
  if (!s || s.picked.length === 0) return;
  const paths = s.picked.reduce((all, ref) => setMode(all, ref, mode), s.paths);
  commit(host, paths, s.picked);
}
