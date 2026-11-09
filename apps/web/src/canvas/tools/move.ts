import type { Frame, Hit, LayerNode, Loc, Rect } from "@finite/protocol";
import { bridgeOf } from "../bridge";
import {
  chainOf,
  drillInto,
  flowAxis,
  type Handle,
  movedFrames,
  type Point,
  reorderBefore,
  resizedFrame,
  resizeEdit,
  resizeStyles,
  revsOf,
} from "../gestures";
import { childrenIn } from "../layers";
import { keyOf, type SelectionItem, selectionStore, toggleItem } from "../selection";
import type { Gesture, ToolDef, ToolHost } from "./host";
import { editText, textRootOf } from "./text";

/** What a press landed on, read off the DOM it hit. */
export function pressTargets(target: Element | null) {
  return {
    handle: target?.closest<HTMLElement>("[data-handle]") ?? null,
    titleId: target?.closest<HTMLElement>("[data-frame-title]")?.dataset.frameTitle,
    textId: target?.closest<HTMLElement>("[data-text-id]")?.dataset.textId,
  };
}

/** Selects, moves, resizes and reorders. */
export const select = {
  id: "select",
  group: "move",
  label: "Move",
  keys: { key: "v" },
  icon: "cursor",
  cursor: "",
  enabled: true,
  sticky: true,
  pan: "empty",
  hover: true,
  doubleClick: onDoubleClick,
  down(host, p) {
    const { target, world, screen, shift, deep, frame } = p;
    const { handle, titleId, textId } = pressTargets(target);
    if (handle) {
      const which = handle.dataset.handle as Handle;
      const key = handle.dataset.key!;
      return { begin: () => beginResize(host, key, which, screen), click: () => {} };
    }
    if (textId) {
      return {
        begin: async () => beginMoveText(host, textId, world),
        click: () => host.selectText(textId),
      };
    }
    if (titleId) {
      const f = host.frame(titleId)!;
      const item = host.frameItem(f.id);
      const selected = selectionStore.get().some((s) => s.loc === undefined && s.frameId === f.id);
      if (!selected) selectionStore.set(shift ? toggleItem(selectionStore.get(), item) : [item]);
      host.update({ selectedText: null });
      return {
        begin: async () => beginMoveFrames(host, world),
        click: () => {
          if (selected && shift) selectionStore.set(toggleItem(selectionStore.get(), item));
        },
      };
    }
    if (frame) {
      const q = host.local(frame, world);
      const bridge = bridgeOf(frame.id);
      const hit = bridge ? bridge.hit(q.x, q.y).catch(() => null) : Promise.resolve(null);
      host.update({ selectedText: null });
      return {
        begin: async () => beginDragInFrame(host, frame, await hit, world, deep),
        click: async () => clickInFrame(host, frame, await hit, shift, deep),
      };
    }
    // The empty canvas: the camera pans on a drag; a click clears the selection.
    return {
      passive: true,
      begin: async () => null,
      click: () => {
        if (!shift) selectionStore.set([]);
        host.update({ selectedText: null, editingLabel: null });
      },
    };
  },
} as const satisfies ToolDef<"select">;

async function onDoubleClick(host: ToolHost, e: MouseEvent, target: Element | null) {
  if (target?.closest("[data-canvas-ui]")) return;
  const textId = target?.closest<HTMLElement>("[data-text-id]")?.dataset.textId;
  if (textId) return host.update({ editingLabel: textId, selectedText: textId });
  const titleId = target?.closest<HTMLElement>("[data-frame-title]")?.dataset.frameTitle;
  if (titleId) return;
  const world = host.worldOf(e);
  const frame = host.frameAt(world);
  if (!frame) return;
  const bridge = bridgeOf(frame.id);
  const p = host.local(frame, world);
  const hit = await bridge?.hit(p.x, p.y).catch(() => null);
  if (!hit || !bridge) return;
  const selected = selectionStore.get().find((s) => s.frameId === frame.id);
  const sameEl =
    (selected?.loc === hit.loc && (selected.index ?? 0) === hit.index) ||
    selected?.loc === textRootOf(hit).loc;
  // On the selected element: type into its text, when it holds text.
  if (sameEl && (await editText(host, frame, hit))) return;
  const next = drillInto(hit, selected?.loc);
  if (!next) return;
  const chain = chainOf(hit);
  const i = chain.findIndex((c) => c.loc === next.loc);
  const path = chain.slice(0, i).reverse();
  const index = next.loc === hit.loc ? hit.index : 0;
  selectionStore.set([host.selectHit(frame.id, next, index, path)]);
}

function clickInFrame(
  host: ToolHost,
  frame: Frame,
  hit: Hit | null,
  shift: boolean,
  deep: boolean,
) {
  let item: SelectionItem = host.frameItem(frame.id);
  const current = selectionStore.get();
  if (hit) {
    // A press on the selected element's ancestor chain keeps the selected one, unless ⌘.
    const selectedInChain =
      !deep &&
      !shift &&
      current.find(
        (s) =>
          s.frameId === frame.id &&
          s.loc !== undefined &&
          chainOf(hit).some((c) => c.loc === s.loc),
      );
    item = selectedInChain || host.selectHit(frame.id, hit, hit.index, hit.path);
  }
  selectionStore.set(shift ? toggleItem(current, item) : [item]);
}

async function beginMoveFrames(host: ToolHost, from: Point): Promise<Gesture | null> {
  const ids = new Set(
    selectionStore
      .get()
      .filter((s) => s.loc === undefined)
      .map((s) => s.frameId),
  );
  const frames = host.frames.filter((f) => ids.has(f.id));
  if (frames.length === 0) return null;
  let d = { x: 0, y: 0 };
  return {
    move: (_, world) => {
      d = { x: world.x - from.x, y: world.y - from.y };
      const frameOverrides: Record<string, Rect> = {};
      for (const f of frames) {
        const b = host.boxOf({ ...f });
        frameOverrides[f.id] = { ...b, x: Math.round(f.x + d.x), y: Math.round(f.y + d.y) };
      }
      host.update({ frameOverrides });
    },
    end: async (commit) => {
      if (commit && (d.x !== 0 || d.y !== 0)) {
        await host.patch({ op: "moveFrames", frames: movedFrames(frames, d) });
      }
      host.update({ frameOverrides: {} });
    },
  };
}

async function beginMoveText(host: ToolHost, id: string, from: Point): Promise<Gesture | null> {
  const text = host.texts.find((t) => t.id === id);
  if (!text) return null;
  host.selectText(id);
  let at = { x: text.x, y: text.y };
  return {
    move: (_, world) => {
      at = { x: Math.round(text.x + world.x - from.x), y: Math.round(text.y + world.y - from.y) };
      host.update({ textOverrides: { [id]: at } });
    },
    end: async (commit) => {
      if (commit && (at.x !== text.x || at.y !== text.y)) {
        await host.patch({ op: "setText", text: { ...text, ...at } });
      }
      host.update({ textOverrides: {} });
    },
  };
}

async function beginResize(
  host: ToolHost,
  key: string,
  handle: Handle,
  from: Point,
): Promise<Gesture | null> {
  const item = selectionStore.get().find((s) => keyOf(s) === key);
  const frame = item && host.frame(item.frameId);
  if (!item || !frame) return null;
  const zoom = () => host.camera.view.zoom;
  if (item.loc === undefined) {
    let d = { x: 0, y: 0 };
    const start = host.boxOf(frame);
    return {
      move: (screen) => {
        d = { x: (screen.x - from.x) / zoom(), y: (screen.y - from.y) / zoom() };
        const r = resizedFrame({ ...frame, ...start }, handle, d);
        host.update({ frameOverrides: { [frame.id]: r } });
      },
      end: async (commit) => {
        if (commit && (d.x !== 0 || d.y !== 0)) {
          await host.patch({
            op: "resizeFrames",
            frames: [resizedFrame({ ...frame, ...start }, handle, d)],
          });
        }
        host.update({ frameOverrides: {} });
        void host.refreshSelection();
      },
    };
  }
  const facts = host.facts.get(key);
  const rect = host.state.rects[key];
  const bridge = bridgeOf(frame.id);
  if (!facts || !rect || !bridge) return null;
  const el = { loc: item.loc, rev: facts.rev, tag: facts.tag };
  let d = { x: 0, y: 0 };
  return {
    move: (screen) => {
      d = { x: (screen.x - from.x) / zoom(), y: (screen.y - from.y) / zoom() };
      bridge.preview(item.loc!, resizeStyles(rect, handle, d));
      void bridge.rects([item.loc!]).then((r) => {
        const now = r[item.loc!]?.[item.index ?? 0];
        if (now) host.update({ rects: { ...host.state.rects, [key]: now } });
      });
    },
    end: async (commit) => {
      const edit = commit ? resizeEdit(el, rect, handle, d) : null;
      if (edit) await host.edit([edit]);
      else bridge.preview(item.loc!, null);
      void host.refreshSelection();
    },
  };
}

/** A drag that starts inside a frame: reorders the selected element within its flex or grid parent. */
async function beginDragInFrame(
  host: ToolHost,
  frame: Frame,
  hit: Hit | null,
  from: Point,
  deep: boolean,
): Promise<Gesture | null> {
  const selected = selectionStore.get();
  const frameSelected = selected.some((s) => s.loc === undefined && s.frameId === frame.id);
  if (!hit) return frameSelected ? beginMoveFrames(host, from) : null;
  const chain = chainOf(hit);
  let item = deep
    ? undefined
    : selected.find(
        (s) => s.frameId === frame.id && s.loc !== undefined && chain.some((c) => c.loc === s.loc),
      );
  if (!item) {
    item = host.selectHit(frame.id, hit, hit.index, hit.path);
    selectionStore.set([item]);
  }
  const bridge = bridgeOf(frame.id);
  const facts = host.facts.get(keyOf(item));
  if (!bridge || !facts || item.loc === undefined) return null;
  const loc = item.loc;
  const inspection = await bridge.inspect(loc, item.index ?? 0).catch(() => null);
  const axis = inspection ? flowAxis(inspection.parent) : null;
  if (!axis) {
    host.say("Only children of a flex or grid layout can be dragged into a new order.");
    return null;
  }
  const parent = facts.path[0];
  const layers = await bridge.layers().catch(() => [] as LayerNode[]);
  const siblingNodes = childrenIn(layers, parent ? { loc: parent.loc, index: 0 } : null) ?? [];
  const locs = [...new Set(siblingNodes.map((n) => n.loc))];
  const rects = await bridge.rects(locs).catch(() => ({}) as Record<string, Rect[]>);
  const siblings = locs
    .map((l) => ({ loc: l, rect: rects[l]?.[0] }))
    .filter((s): s is { loc: Loc; rect: Rect } => s.rect !== undefined);
  let before: Loc | null | undefined;
  return {
    move: (_, world) => {
      const p = host.local(frame, world);
      before = reorderBefore(loc, siblings, p, axis);
      if (before === undefined) return host.update({ dropLine: null });
      const target =
        before === null ? siblings.at(-1)?.rect : siblings.find((s) => s.loc === before)?.rect;
      if (!target) return host.update({ dropLine: null });
      const edge = before === null;
      const line =
        axis === "x"
          ? {
              x: edge ? target.x + target.width : target.x,
              y: target.y,
              width: 0,
              height: target.height,
            }
          : {
              x: target.x,
              y: edge ? target.y + target.height : target.y,
              width: target.width,
              height: 0,
            };
      host.update({ dropLine: { frameId: frame.id, rect: line } });
    },
    end: async (commit) => {
      host.update({ dropLine: null });
      if (!commit || before === undefined) return;
      await host.edit([
        { kind: "reorder", loc, tag: facts.tag, before, revs: revsOf([{ loc, rev: facts.rev }]) },
      ]);
    },
  };
}
