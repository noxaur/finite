"use client";

import type { Rect } from "@finite/protocol";
import { useEffect, useRef, useState } from "react";
import { type CanvasEditor, useActiveEditor } from "./editor";
import { keyOf, selectionStore } from "./selection";

/** A canvas box (`world`) on the page, in client pixels, under the camera's view now. */
function toScreen(editor: CanvasEditor, world: Rect): Rect {
  const a = editor.camera.toPage(world.x, world.y);
  const b = editor.camera.toPage(world.x + world.width, world.y + world.height);
  return { x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y };
}

const same = (a: Rect | null, b: Rect | null) =>
  a === b ||
  (!!a && !!b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height);

/** Follows `measure` through camera moves, edits and selection changes on the canvas on screen. */
function useScreenRect(
  measure: (editor: CanvasEditor) => Rect | null,
  dep: unknown = null,
): Rect | null {
  const editor = useActiveEditor();
  const [rect, setRect] = useState<Rect | null>(null);
  const latest = useRef(measure);
  latest.current = measure;
  useEffect(() => {
    if (!editor) return setRect(null);
    const update = () => {
      const world = latest.current(editor);
      const next = world && toScreen(editor, world);
      setRect((prev) => (same(prev, next) ? prev : next));
    };
    update();
    const offs = [
      editor.camera.subscribe(update),
      editor.store.subscribe(update),
      selectionStore.subscribe(update),
    ];
    return () => offs.forEach((off) => off());
  }, [editor, dep]);
  return rect;
}

/** Where a frame is on screen, in client pixels: for the ✱ button at its top-right corner. */
export function useFrameRect(frameId: string | null): Rect | null {
  return useScreenRect((editor) => {
    const frame = frameId === null ? undefined : editor.frame(frameId);
    return frame ? editor.boxOf(frame) : null;
  }, frameId);
}

/** Where the selection is on screen (the box around all of it), in client pixels; `null` when empty. */
export function useSelectionRect(): Rect | null {
  return useScreenRect((editor) => {
    const boxes: Rect[] = [];
    for (const item of selectionStore.get()) {
      const frame = editor.frame(item.frameId);
      const local = editor.state.rects[keyOf(item)];
      if (!frame || !local) continue;
      const b = editor.boxOf(frame);
      boxes.push({ x: b.x + local.x, y: b.y + local.y, width: local.width, height: local.height });
    }
    if (boxes.length === 0) return null;
    const x = Math.min(...boxes.map((b) => b.x));
    const y = Math.min(...boxes.map((b) => b.y));
    const right = Math.max(...boxes.map((b) => b.x + b.width));
    const bottom = Math.max(...boxes.map((b) => b.y + b.height));
    return { x, y, width: right - x, height: bottom - y };
  });
}
