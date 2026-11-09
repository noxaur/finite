"use client";

import * as stylex from "@stylexjs/stylex";
import type { Canvas as CanvasDoc, Route } from "@finite/protocol";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { CommentLayer } from "@/components/Comments";
import { InspectCard } from "@/components/InspectCard";
import { SelectionLayer } from "@/components/SelectionLayer";
import { Camera } from "@/design/camera";
import { colors, fonts, radii, shadows, space } from "@/styles/tokens.stylex";
import { Button } from "@/components/Button";
import { Toolbar } from "@/components/Toolbar";
import { useDesignState } from "@/client/finite";
import { activeEditor, CanvasEditor, useEditorState } from "./editor";
import { SectionsLayer, SlicesLayer } from "./CanvasObjects";
import { FrameView } from "./FrameView";
import { MeasureOverlay } from "./MeasureOverlay";
import { useSelection } from "./selection";
import { RichTextEditor } from "./RichTextEditor";
import { TextLabels } from "./TextLabels";
import { ToolOverlays } from "./ToolOverlays";
import { toolOf } from "./tools/registry";
import { framesToMount } from "./virtualize";

/**
 * One canvas: its frames (live iframes of routes or components), the agent's text labels, and
 * comment pins, on a pan-and-zoom world. Trackpad scroll pans, pinch or ⌘-scroll zooms, Space-drag
 * pans anywhere, ⌘+ / ⌘− / ⌘0 zoom, Shift-1 fits everything and Shift-2 the selection. Only
 * the frames in view (plus a screen around it) keep a live iframe, at most 12; the rest show
 * their name until they come back into view.
 */
export function Canvas({
  canvas,
  ...props
}: {
  designId: string;
  /** No canvas yet (a new prototype before its first message): the empty canvas. */
  canvas: CanvasDoc | null | undefined;
  mode: "design" | "prototype" | "prototypes";
  /** Where the design's Vite server is; by default, the design state's preview url. */
  previewUrl?: string | undefined;
  /** The design's routes, to name the file a route frame renders; by default, the design state's. */
  routes?: readonly Route[];
}) {
  const view = useDesignState(props.designId);
  const previewUrl = props.previewUrl ?? view.state?.preview.url;
  const routes = props.routes ?? view.state?.routes ?? NO_ROUTES;
  return (
    <CanvasView
      {...props}
      canvas={canvas ?? EMPTY}
      mode={props.mode === "design" ? "design" : "prototype"}
      previewUrl={previewUrl}
      routes={routes}
    />
  );
}

const NO_ROUTES: readonly Route[] = [];
const EMPTY: CanvasDoc = {
  id: "",
  kind: "prototype",
  name: "",
  threadIds: [],
  frames: [],
  texts: [],
  comments: [],
  sections: [],
  slices: [],
  updatedAt: 0,
};

function CanvasView({
  designId,
  canvas,
  mode,
  previewUrl,
  routes,
}: {
  designId: string;
  canvas: CanvasDoc;
  mode: "design" | "prototype";
  previewUrl: string | undefined;
  routes: readonly Route[];
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const world = useRef<HTMLDivElement>(null);
  const [editor, setEditor] = useState<CanvasEditor | null>(null);
  const [mounted, setMounted] = useState<string[]>([]);
  const state = useEditorState(editor);
  const selection = useSelection();
  const latest = useRef(canvas);
  latest.current = canvas;

  useLayoutEffect(() => {
    const v = viewport.current;
    const w = world.current;
    if (!v || !w) return;
    const camera = new Camera(v, w);
    const ed = new CanvasEditor(designId, latest.current, mode, v, camera);
    setEditor(ed);
    activeEditor.set(ed);
    if (latest.current.frames.length > 0) ed.fitAll();
    return () => {
      ed.dispose();
      camera.dispose();
      if (activeEditor.get() === ed) activeEditor.set(null);
    };
  }, [designId, canvas.id, mode]);

  useEffect(() => editor?.setCanvas(canvas), [editor, canvas]);

  // A canvas that opened empty (routes not reported yet, a prototype before its first frame)
  // fits its first frames when they arrive.
  const hasFrames = canvas.frames.length > 0;
  const wasEmpty = useRef(!hasFrames);
  useEffect(() => {
    if (!editor || !hasFrames || !wasEmpty.current) return;
    wasEmpty.current = false;
    requestAnimationFrame(() => editor.fitAll());
  }, [editor, hasFrames]);

  useEffect(() => {
    if (!editor) return;
    editor.routeFile = (frame) =>
      frame?.source.kind === "route"
        ? routes.find((r) => r.path === (frame.source as { path: string }).path)?.file
        : undefined;
  }, [editor, routes]);

  // Which frames keep a live iframe: recomputed as the view moves, once a frame.
  useEffect(() => {
    if (!editor) return;
    let raf = 0;
    const compute = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const boxes = editor.frames.map((f) => ({ id: f.id, ...editor.boxOf(f) }));
        const pinned = new Set(selection.map((s) => s.frameId));
        const inspectPin = editor.state.inspect.pin;
        if (inspectPin) pinned.add(inspectPin.frameId);
        setMounted((prev) => {
          const next = framesToMount(boxes, editor.camera.visibleWorld(1), prev, pinned);
          return next.length === prev.length && next.every((id, i) => id === prev[i]) ? prev : next;
        });
      });
    };
    compute();
    const off = editor.camera.subscribe(compute);
    return () => {
      off();
      cancelAnimationFrame(raf);
    };
  }, [editor, canvas.frames, selection]);

  const selectedFrames = new Set(selection.map((s) => s.frameId));
  const cursor = state ? toolOf(state.tool).cursor : undefined;

  return (
    <div
      ref={viewport}
      data-canvas=""
      {...stylex.props(
        styles.viewport,
        cursor !== undefined && cursor !== "" && styles.toolCursor(cursor),
      )}
    >
      <div ref={world} {...stylex.props(styles.world)}>
        {editor && state && (
          <>
            <SectionsLayer editor={editor} state={state} />
            <TextLabels editor={editor} state={state} />
            {canvas.frames.map((frame) => {
              const box = editor.boxOf(frame);
              return (
                <div
                  key={frame.id}
                  data-frame={frame.id}
                  {...stylex.props(styles.frame(box.x, box.y, box.width, box.height))}
                >
                  <div
                    data-frame-title={frame.id}
                    {...stylex.props(
                      styles.title,
                      selectedFrames.has(frame.id) && styles.titleSelected,
                    )}
                    style={{ maxWidth: `calc(${box.width}px / var(--inv-zoom, 1))` }}
                  >
                    {frame.name}
                    {frame.gone && (
                      <span
                        title="This route isn't in the app any more. Remove the frame when you're done with it."
                        {...stylex.props(styles.gone)}
                      >
                        {" · route removed"}
                      </span>
                    )}
                  </div>
                  <FrameView
                    designId={designId}
                    frame={frame}
                    width={box.width}
                    height={box.height}
                    previewUrl={previewUrl}
                    mounted={mounted.includes(frame.id)}
                    interact={state.tool === "interact"}
                    editor={editor}
                  />
                </div>
              );
            })}
            <SlicesLayer editor={editor} state={state} />
            <SelectionLayer editor={editor} state={state} selection={selection} />
            <ToolOverlays editor={editor} state={state} />
            {state.tool === "measure" && <MeasureOverlay host={editor} state={state} />}
            <CommentLayer
              designId={designId}
              canvasId={canvas.id}
              comments={canvas.comments}
              editor={editor}
              state={state}
            />
            {state.editingText && <RichTextEditor editor={editor} editing={state.editingText} />}
            {state.notice && (
              <div {...stylex.props(styles.noticeSpot(state.notice.at.x, state.notice.at.y))}>
                <div
                  role="status"
                  data-canvas-ui=""
                  data-camera-ignore=""
                  {...stylex.props(styles.notice)}
                >
                  <span>{state.notice.text}</span>
                  {state.notice.action && (
                    <Button size="small" variant="brand" onClick={state.notice.action.run}>
                      {state.notice.action.label}
                    </Button>
                  )}
                </div>
              </div>
            )}
          </>
        )}
      </div>
      {editor && state && <Toolbar editor={editor} state={state} />}
      {editor && state?.tool === "inspect" && (
        <InspectCard editor={editor} inspect={state.inspect} />
      )}
    </div>
  );
}

const styles = stylex.create({
  viewport: {
    position: "relative",
    width: "100%",
    height: "100%",
    overflow: "hidden",
    backgroundColor: colors.canvas,
    touchAction: "none",
    userSelect: "none",
    fontFamily: fonts.sans,
    outline: "none",
  },
  // A tool's cursor, kept off the inline `cursor` the camera sets while it pans.
  toolCursor: (cursor: string) => ({ cursor }),
  world: {
    position: "absolute",
    left: 0,
    top: 0,
    width: 0,
    height: 0,
    transformOrigin: "0 0",
  },
  frame: (x: number, y: number, width: number, height: number) => ({
    position: "absolute",
    left: x,
    top: y,
    width,
    height,
  }),
  // The frame's name keeps its screen size, just above its top-left corner.
  title: {
    position: "absolute",
    left: 0,
    bottom: "100%",
    paddingBottom: 6,
    transform: "scale(var(--inv-zoom, 1))",
    transformOrigin: "0 100%",
    color: colors.muted,
    fontSize: 12,
    lineHeight: "15px",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    cursor: "default",
  },
  titleSelected: { color: colors.hover },
  gone: { color: colors.danger },
  noticeSpot: (x: number, y: number) => ({
    position: "absolute",
    left: x,
    top: y,
    zIndex: 3,
  }),
  notice: {
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    width: "max-content",
    maxWidth: 420,
    marginTop: space.sm,
    transform: "scale(var(--inv-zoom, 1))",
    transformOrigin: "0 0",
    paddingBlock: space.xs,
    paddingInline: space.sm,
    borderRadius: radii.md,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: colors.surface,
    color: colors.text,
    boxShadow: shadows.raised,
    fontSize: 13,
    lineHeight: 1.4,
  },
});
