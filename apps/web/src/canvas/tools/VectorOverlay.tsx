"use client";

import * as stylex from "@stylexjs/stylex";
import { type ComponentType, useEffect, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/Button";
import { Segments } from "@/components/inspector/controls";
import { hitTest, isEndpoint, visibleHandles } from "@/design/vector/edit";
import {
  boundsOf,
  type HandleMode,
  mapPaths,
  type Point,
  printPath,
  type SubPath,
} from "@/design/vector/path";
import { colors, shadows, radii, space } from "@/styles/tokens.stylex";
import type { EditorState } from "../editor";
import type { ToolHost } from "./host";
import {
  joinSelected,
  penDraft,
  pencilStroke,
  setHandleMode,
  syncVector,
  vectorEditing,
  worldMap,
} from "./vectorState";

const useStore = <T,>(store: { get: () => T; subscribe: (f: () => void) => () => void }) =>
  useSyncExternalStore(store.subscribe, store.get, store.get);

/** Where the pointer is on the canvas, once it's moved. */
function usePointer(host: ToolHost): Point | null {
  const [at, setAt] = useState<Point | null>(null);
  useEffect(() => {
    const onMove = (e: PointerEvent) => setAt(host.worldOf(e));
    window.addEventListener("pointermove", onMove);
    return () => window.removeEventListener("pointermove", onMove);
  }, [host]);
  return at;
}

const MODES: ReadonlyArray<readonly [HandleMode, null, string, string]> = [
  ["none", null, "No mirroring: each handle moves on its own", "None"],
  ["angle", null, "Mirror angle: handles stay opposite, each its own length", "Angle"],
  ["mirror", null, "Mirror angle and length", "Length"],
];

/** Lines drawn in canvas units, staying the same width on screen. */
function Lines({ d, ghost }: { d: string; ghost?: boolean }) {
  return (
    <svg aria-hidden {...stylex.props(styles.lines)}>
      <path d={d} {...stylex.props(styles.line, ghost && styles.ghostLine)} />
    </svg>
  );
}

function handleLines(paths: readonly SubPath[], refs: ReturnType<typeof visibleHandles>): string {
  return refs
    .flatMap((ref) => {
      const a = paths[ref.sub]!.anchors[ref.i]!;
      return [a.in, a.out].flatMap((h) => (h ? [`M${a.p.x} ${a.p.y}L${h.x} ${h.y}`] : []));
    })
    .join("");
}

/** Points and handles of the path being edited, and the bar that sets handle modes. */
export function VectorEditOverlay({ host, state }: { host: ToolHost; state: EditorState }) {
  const s = useStore(vectorEditing);
  const pointer = usePointer(host);
  useEffect(() => {
    void syncVector(host);
  }, [host, state.updates]);
  const map = s && worldMap(host, s);
  if (!s || !map) return null;
  const world = mapPaths(s.paths, map);
  const handles = visibleHandles(world, s.picked);
  const within = 7 / host.camera.view.zoom;
  const hover = pointer ? hitTest(world, s.picked, pointer, within) : null;
  const ghost = hover?.kind === "segment" && !state.dragging ? hover.at : null;
  const bounds = boundsOf(world);
  const modes = new Set(s.picked.map((r) => s.paths[r.sub]?.anchors[r.i]?.mode ?? "none"));
  const mode = modes.size === 1 ? [...modes][0]! : null;
  const canJoin =
    s.picked.length === 1
      ? s.paths[s.picked[0]!.sub]?.closed === false
      : s.picked.length === 2 &&
        s.picked.every((r) => {
          const sub = s.paths[r.sub];
          return sub && isEndpoint(sub, r.i);
        });
  const joinLabel = s.picked.length === 1 ? "Close path" : "Join";
  return (
    <>
      <Lines d={printPath(world)} />
      {handles.length > 0 && <Lines d={handleLines(world, handles)} ghost />}
      {handles.flatMap((ref) => {
        const a = world[ref.sub]!.anchors[ref.i]!;
        return (["in", "out"] as const).flatMap((which) => {
          const h = a[which];
          return h
            ? [
                <div
                  key={`h${ref.sub}:${ref.i}:${which}`}
                  {...stylex.props(styles.handle(h.x, h.y))}
                />,
              ]
            : [];
        });
      })}
      {world.flatMap((sub, si) =>
        sub.anchors.map((a, i) => (
          <div
            key={`${si}:${i}`}
            data-vector-point={`${si}:${i}`}
            {...stylex.props(
              styles.point(a.p.x, a.p.y),
              s.picked.some((r) => r.sub === si && r.i === i) && styles.picked,
            )}
          />
        )),
      )}
      {ghost && <div aria-hidden {...stylex.props(styles.adding(ghost.x, ghost.y))} />}
      {bounds && (
        <div {...stylex.props(styles.spot(bounds.x, bounds.y))}>
          <div
            role="toolbar"
            aria-label="Point editing"
            data-canvas-ui=""
            data-camera-ignore=""
            {...stylex.props(styles.bar)}
          >
            {s.picked.length > 0 && (
              <div {...stylex.props(styles.modes)}>
                <Segments
                  label="Handle mode"
                  value={mode}
                  options={MODES}
                  onPick={(m) => setHandleMode(host, m)}
                />
              </div>
            )}
            {canJoin && (
              <Button size="small" onClick={() => joinSelected(host)}>
                {joinLabel}
              </Button>
            )}
            <Button size="small" variant="ghost" onClick={() => host.setTool("select")}>
              Done
            </Button>
          </div>
        </div>
      )}
    </>
  );
}

/** The pen's path as it's being placed, the segment to the pointer, and the pencil's stroke. */
export function PenOverlay({ host }: { host: ToolHost; state: EditorState }) {
  const draft = useStore(penDraft);
  const stroke = useStore(pencilStroke);
  const pointer = usePointer(host);
  const anchors = draft?.anchors ?? [];
  const last = anchors.at(-1);
  const closing =
    anchors.length >= 2 && pointer
      ? Math.hypot(anchors[0]!.p.x - pointer.x, anchors[0]!.p.y - pointer.y) <=
        9 / host.camera.view.zoom
      : false;
  return (
    <>
      {stroke && <Lines d={`M${stroke.map((p) => `${p.x} ${p.y}`).join("L")}`} />}
      {draft && <Lines d={printPath([draft])} />}
      {last && pointer && !closing && (
        <Lines
          ghost
          d={`M${last.p.x} ${last.p.y}${
            last.out ? `C${last.out.x} ${last.out.y} ${pointer.x} ${pointer.y} ` : "L"
          }${pointer.x} ${pointer.y}`}
        />
      )}
      {last?.out && (
        <Lines
          d={`M${last.in?.x ?? last.p.x} ${last.in?.y ?? last.p.y}L${last.out.x} ${last.out.y}`}
          ghost
        />
      )}
      {anchors.map((a, i) => (
        <div
          key={i}
          data-pen-anchor={i}
          {...stylex.props(
            styles.point(a.p.x, a.p.y),
            ((closing && i === 0) || i === anchors.length - 1) && styles.picked,
          )}
        />
      ))}
    </>
  );
}

/** Tool overlays by id; kept out of the tool files so they stay free of the UI. */
export const VECTOR_OVERLAYS: Readonly<
  Record<string, ComponentType<{ host: ToolHost; state: EditorState }>>
> = { pen: PenOverlay, pencil: PenOverlay, vectorEdit: VectorEditOverlay };

const styles = stylex.create({
  lines: {
    position: "absolute",
    left: 0,
    top: 0,
    width: 1,
    height: 1,
    overflow: "visible",
    pointerEvents: "none",
  },
  line: {
    fill: "none",
    stroke: colors.hover,
    strokeWidth: "calc(1.5px * var(--inv-zoom, 1))",
  },
  ghostLine: {
    opacity: 0.6,
    strokeWidth: "calc(1px * var(--inv-zoom, 1))",
  },
  point: (x: number, y: number) => ({
    position: "absolute",
    left: x,
    top: y,
    width: "calc(7px * var(--inv-zoom, 1))",
    height: "calc(7px * var(--inv-zoom, 1))",
    transform: "translate(-50%, -50%)",
    boxSizing: "border-box",
    borderWidth: "calc(1.5px * var(--inv-zoom, 1))",
    borderStyle: "solid",
    borderColor: colors.hover,
    backgroundColor: colors.surface,
    pointerEvents: "none",
  }),
  picked: { backgroundColor: colors.hover },
  handle: (x: number, y: number) => ({
    position: "absolute",
    left: x,
    top: y,
    width: "calc(6px * var(--inv-zoom, 1))",
    height: "calc(6px * var(--inv-zoom, 1))",
    transform: "translate(-50%, -50%)",
    borderRadius: "50%",
    backgroundColor: colors.hover,
    pointerEvents: "none",
  }),
  adding: (x: number, y: number) => ({
    position: "absolute",
    left: x,
    top: y,
    width: "calc(7px * var(--inv-zoom, 1))",
    height: "calc(7px * var(--inv-zoom, 1))",
    transform: "translate(-50%, -50%)",
    borderRadius: "50%",
    borderWidth: "calc(1.5px * var(--inv-zoom, 1))",
    borderStyle: "solid",
    borderColor: colors.hover,
    backgroundColor: "rgba(149, 206, 215, 0.35)",
    pointerEvents: "none",
  }),
  spot: (x: number, y: number) => ({
    position: "absolute",
    left: x,
    top: y,
    zIndex: 3,
  }),
  bar: {
    position: "absolute",
    left: 0,
    bottom: "100%",
    display: "flex",
    alignItems: "center",
    gap: space.xs,
    width: "max-content",
    marginBottom: 12,
    padding: space.xs,
    transform: "scale(var(--inv-zoom, 1))",
    transformOrigin: "0 100%",
    borderRadius: radii.md,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: colors.surface,
    boxShadow: shadows.raised,
  },
  modes: { width: 180 },
});
