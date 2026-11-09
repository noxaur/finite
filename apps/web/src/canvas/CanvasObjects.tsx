"use client";

import * as stylex from "@stylexjs/stylex";
import { clampInside, MIN_OBJECT, type Rect, type Section, type Slice } from "@finite/protocol";
import { useEffect, useRef, useState } from "react";
import { finite } from "@/client/finite";
import { colors, fonts, radii, shadows, space } from "@/styles/tokens.stylex";
import type { CanvasEditor, EditorState } from "./editor";
import { CORNERS, HANDLES, resizeBox, type Handle, type Point } from "./gestures";
import { membersOf, movedWith, rounded } from "./objects";
import type { Gesture, PressPlan, ToolHost } from "./tools/host";

/** A second click on a title this soon after the first renames the section. */
const DOUBLE_MS = 400;

const CURSORS: Record<Handle, string> = {
  n: "ns-resize",
  s: "ns-resize",
  e: "ew-resize",
  w: "ew-resize",
  ne: "nesw-resize",
  sw: "nesw-resize",
  nw: "nwse-resize",
  se: "nwse-resize",
};

const boxOfSection = (s: Section): Rect => ({
  x: s.x,
  y: s.y,
  width: s.width,
  height: s.height,
});

/** Drags a section with the frames and labels inside it, as one `moveSection` step. */
function moveSectionGesture(host: ToolHost, section: Section, from: Point): Gesture {
  const { frameIds, textIds } = membersOf(
    section,
    host.frames.map((f) => ({ id: f.id, ...host.boxOf(f) })),
    host.texts,
  );
  const frames = host.frames.filter((f) => frameIds.includes(f.id));
  const texts = host.texts.filter((t) => textIds.includes(t.id));
  const base = new Map(frames.map((f) => [f.id, host.boxOf(f)]));
  let moved = movedWith(section, frames, texts, { x: 0, y: 0 });
  const clear = () => host.update({ frameOverrides: {}, textOverrides: {}, objectOverrides: {} });
  return {
    move: (_screen, world) => {
      moved = movedWith(section, frames, texts, { x: world.x - from.x, y: world.y - from.y });
      host.update({
        frameOverrides: Object.fromEntries(
          moved.frames.map((m) => [m.id, { ...base.get(m.id)!, x: m.x, y: m.y }]),
        ),
        textOverrides: Object.fromEntries(moved.texts.map((m) => [m.id, { x: m.x, y: m.y }])),
        objectOverrides: { [section.id]: { ...boxOfSection(section), x: moved.x, y: moved.y } },
      });
    },
    end: async (commit) => {
      if (commit && (moved.x !== section.x || moved.y !== section.y)) {
        await host.patch({
          op: "moveSection",
          sectionId: section.id,
          x: moved.x,
          y: moved.y,
          frames: moved.frames,
          texts: moved.texts,
        });
      }
      clear();
    },
  };
}

/** Drags a handle of a box: `commit` gets the box it ended on. */
function resizeGesture(
  host: ToolHost,
  id: string,
  start: Rect,
  handle: Handle,
  from: Point,
  fit: (box: Rect) => Rect,
  commit: (box: Rect) => Promise<void>,
): Gesture {
  let box = start;
  return {
    move: (_screen, world) => {
      box = fit(resizeBox(start, handle, { x: world.x - from.x, y: world.y - from.y }, MIN_OBJECT));
      host.update({ objectOverrides: { [id]: box } });
    },
    end: async (ok) => {
      if (ok && JSON.stringify(box) !== JSON.stringify(start)) await commit(box);
      host.update({ objectOverrides: {} });
    },
  };
}

/** Drags a slice inside its frame, in the frame's own pixels. */
function moveSliceGesture(host: ToolHost, slice: Slice, bounds: Rect, from: Point): Gesture {
  let box: Rect = slice;
  return {
    move: (_screen, world) => {
      box = rounded(
        clampInside(
          { ...slice, x: slice.x + world.x - from.x, y: slice.y + world.y - from.y },
          bounds,
        ),
      );
      host.update({ objectOverrides: { [slice.id]: box } });
    },
    end: async (commit) => {
      if (commit && (box.x !== slice.x || box.y !== slice.y)) {
        await host.patch({ op: "setSlice", slice: { ...slice, ...box } });
      }
      host.update({ objectOverrides: {} });
    },
  };
}

/** The sections, behind the frames: a tinted box, a title above it, and handles when picked. */
export function SectionsLayer({ editor, state }: { editor: CanvasEditor; state: EditorState }) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const lastClick = useRef<{ id: string; at: number } | null>(null);
  const live = state.tool === "select" && !state.editingText;
  return (
    <>
      {editor.sections.map((section) => {
        const box = state.objectOverrides[section.id] ?? boxOfSection(section);
        const selected =
          state.selectedObject?.kind === "section" && state.selectedObject.id === section.id;
        const pick = () => editor.selectObject({ kind: "section", id: section.id });
        const titlePlan = (e: PointerEvent): PressPlan => {
          const from = editor.worldOf(e);
          return {
            begin: async () => {
              pick();
              return moveSectionGesture(editor, section, from);
            },
            click: () => {
              pick();
              const last = lastClick.current;
              const now = performance.now();
              if (last && last.id === section.id && now - last.at < DOUBLE_MS) {
                lastClick.current = null;
                setRenaming(section.id);
              } else lastClick.current = { id: section.id, at: now };
            },
          };
        };
        return (
          <div
            key={section.id}
            data-section={section.id}
            {...stylex.props(styles.section(box), selected && styles.sectionSelected)}
          >
            {renaming === section.id ? (
              <RenameField
                value={section.name}
                onDone={(name) => {
                  setRenaming(null);
                  if (name && name !== section.name)
                    void editor.patch({ op: "setSection", section: { ...section, name } });
                }}
              />
            ) : (
              <div
                data-section-title={section.id}
                data-canvas-ui=""
                data-camera-ignore=""
                onPointerDown={(e) => {
                  if (e.button === 0 && live) editor.press(e.nativeEvent, titlePlan(e.nativeEvent));
                }}
                {...stylex.props(styles.title, selected && styles.titleSelected)}
              >
                {section.name}
              </div>
            )}
            {selected && live && (
              <Handles
                onPress={(e, handle) => {
                  const from = editor.worldOf(e);
                  editor.press(e, {
                    click: () => {},
                    begin: async () =>
                      resizeGesture(
                        editor,
                        section.id,
                        boxOfSection(section),
                        handle,
                        from,
                        rounded,
                        (next) =>
                          editor.patch({ op: "setSection", section: { ...section, ...next } }),
                      ),
                  });
                }}
              />
            )}
          </div>
        );
      })}
    </>
  );
}

/** The slices, over the frames: a dashed box in the frame, a name above it, and Export when picked. */
export function SlicesLayer({ editor, state }: { editor: CanvasEditor; state: EditorState }) {
  const live = state.tool === "select" && !state.editingText;
  return (
    <>
      {editor.slices.map((slice) => {
        const frame = editor.frame(slice.frameId);
        if (!frame) return null;
        const bounds = editor.boxOf(frame);
        const local = state.objectOverrides[slice.id] ?? slice;
        const at = clampInside(local, bounds);
        const box = { ...at, x: bounds.x + at.x, y: bounds.y + at.y };
        const selected =
          state.selectedObject?.kind === "slice" && state.selectedObject.id === slice.id;
        const pick = () => editor.selectObject({ kind: "slice", id: slice.id });
        return (
          <div
            key={slice.id}
            data-slice={slice.id}
            {...stylex.props(styles.slice(box), selected && styles.sliceSelected)}
          >
            <div
              data-slice-title={slice.id}
              data-canvas-ui=""
              data-camera-ignore=""
              onPointerDown={(e) => {
                if (e.button !== 0 || !live) return;
                const from = editor.worldOf(e.nativeEvent);
                editor.press(e.nativeEvent, {
                  click: pick,
                  begin: async () => {
                    pick();
                    return moveSliceGesture(editor, slice, bounds, from);
                  },
                });
              }}
              {...stylex.props(styles.title, styles.sliceTitle)}
            >
              {slice.name}
            </div>
            {selected && live && (
              <>
                <Handles
                  onPress={(e, handle) => {
                    const from = editor.worldOf(e);
                    editor.press(e, {
                      click: () => {},
                      begin: async () =>
                        resizeGesture(
                          editor,
                          slice.id,
                          at,
                          handle,
                          from,
                          (next) => rounded(clampInside(next, bounds)),
                          (next) => editor.patch({ op: "setSlice", slice: { ...slice, ...next } }),
                        ),
                    });
                  }}
                />
                <ExportButton editor={editor} slice={slice} />
              </>
            )}
          </div>
        );
      })}
    </>
  );
}

/** Renders the slice in Chrome and saves the PNG. */
function ExportButton({ editor, slice }: { editor: CanvasEditor; slice: Slice }) {
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      const { url } = await finite.request("canvas.exportSlice", {
        designId: editor.designId,
        canvasId: editor.canvasId,
        sliceId: slice.id,
      });
      const link = document.createElement("a");
      link.href = url;
      link.download = `${slice.name}.png`;
      link.click();
    } catch (e) {
      editor.say(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      type="button"
      data-slice-export={slice.id}
      data-canvas-ui=""
      data-camera-ignore=""
      disabled={busy}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={() => void run()}
      {...stylex.props(styles.export)}
    >
      {busy ? "Exporting…" : "Export PNG"}
    </button>
  );
}

function RenameField({ value, onDone }: { value: string; onDone: (name: string) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <input
      ref={ref}
      defaultValue={value}
      aria-label="Section name"
      data-canvas-ui=""
      data-camera-ignore=""
      onPointerDown={(e) => e.stopPropagation()}
      onBlur={(e) => onDone(e.currentTarget.value.trim())}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") e.currentTarget.blur();
        else if (e.key === "Escape") onDone("");
      }}
      {...stylex.props(styles.title, styles.rename)}
    />
  );
}

/** Eight resize handles on a box, each the same size on screen at any zoom. */
function Handles({ onPress }: { onPress: (e: PointerEvent, handle: Handle) => void }) {
  return (
    <>
      {HANDLES.map((handle) => (
        <div
          key={handle}
          data-object-handle={handle}
          data-canvas-ui=""
          data-camera-ignore=""
          onPointerDown={(e) => {
            if (e.button === 0) onPress(e.nativeEvent, handle);
          }}
          {...stylex.props(styles.handle(handle), CORNERS.includes(handle) && styles.corner)}
        />
      ))}
    </>
  );
}

const spot = (handle: Handle) => ({
  x: handle.includes("w") ? 0 : handle.includes("e") ? 1 : 0.5,
  y: handle.startsWith("n") ? 0 : handle.startsWith("s") ? 1 : 0.5,
});

const styles = stylex.create({
  section: (r: Rect) => ({
    position: "absolute",
    left: r.x,
    top: r.y,
    width: r.width,
    height: r.height,
    boxSizing: "border-box",
    backgroundColor: colors.hoverFill,
    outline: `calc(1px * var(--inv-zoom, 1)) solid ${colors.borderStrong}`,
    pointerEvents: "none",
  }),
  sectionSelected: {
    outline: `calc(1.5px * var(--inv-zoom, 1)) solid ${colors.hover}`,
  },
  // The name keeps its screen size, just above the box's top-left corner.
  title: {
    position: "absolute",
    left: 0,
    bottom: "100%",
    marginBottom: 4,
    transform: "scale(var(--inv-zoom, 1))",
    transformOrigin: "0 100%",
    paddingBlock: 1,
    paddingInline: space.xs,
    borderRadius: radii.sm,
    color: colors.muted,
    fontFamily: fonts.sans,
    fontSize: 12,
    lineHeight: "15px",
    whiteSpace: "nowrap",
    cursor: "default",
    pointerEvents: "auto",
  },
  titleSelected: { color: colors.hover },
  // Over a frame, so it needs a face to read on any artboard.
  sliceTitle: { backgroundColor: colors.hover, color: colors.halo },
  rename: {
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.hover,
    backgroundColor: colors.surface,
    color: colors.text,
    outline: "none",
    cursor: "text",
  },
  slice: (r: Rect) => ({
    position: "absolute",
    left: r.x,
    top: r.y,
    width: r.width,
    height: r.height,
    boxSizing: "border-box",
    outline: `calc(1px * var(--inv-zoom, 1)) dashed ${colors.hover}`,
    pointerEvents: "none",
  }),
  sliceSelected: {
    outline: `calc(1.5px * var(--inv-zoom, 1)) dashed ${colors.hover}`,
  },
  handle: (handle: Handle) => ({
    position: "absolute",
    left: `${spot(handle).x * 100}%`,
    top: `${spot(handle).y * 100}%`,
    width: "calc(8px * var(--inv-zoom, 1))",
    height: "calc(8px * var(--inv-zoom, 1))",
    transform: "translate(-50%, -50%)",
    boxSizing: "border-box",
    borderWidth: "calc(1.5px * var(--inv-zoom, 1))",
    borderStyle: "solid",
    borderColor: colors.hover,
    backgroundColor: colors.halo,
    cursor: CURSORS[handle],
    pointerEvents: "auto",
  }),
  corner: {
    width: "calc(10px * var(--inv-zoom, 1))",
    height: "calc(10px * var(--inv-zoom, 1))",
  },
  // Below the box's bottom-left corner, at screen size.
  export: {
    position: "absolute",
    left: 0,
    top: "100%",
    marginTop: space.sm,
    transform: "scale(var(--inv-zoom, 1))",
    transformOrigin: "0 0",
    paddingBlock: 2,
    paddingInline: space.sm,
    borderWidth: 0,
    borderRadius: radii.sm,
    backgroundColor: colors.hover,
    color: colors.halo,
    boxShadow: shadows.raised,
    fontFamily: fonts.sans,
    fontSize: 12,
    lineHeight: "16px",
    whiteSpace: "nowrap",
    cursor: "pointer",
    pointerEvents: "auto",
  },
});
