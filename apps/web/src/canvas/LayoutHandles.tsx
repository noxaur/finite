"use client";

import * as stylex from "@stylexjs/stylex";
import type { LayerNode, Rect } from "@finite/protocol";
import type { PointerEvent as ReactPointerEvent } from "react";
import { useCallback, useEffect, useState } from "react";
import {
  changedPadding,
  draggedPadding,
  gapBands,
  type PaddingSide,
  type Sides,
} from "@/design/editing/autoLayout";
import {
  type Axis,
  type SizeMode,
  sizeContextOf,
  sizeModeOf,
  sizeModeStyles,
} from "@/design/editing/sizing";
import { colors, fonts, radii, shadows } from "@/styles/tokens.stylex";
import type { EditorState } from "./editor";
import { type Point, revsOf } from "./gestures";
import { childrenIn } from "./layers";
import { keyOf, useSelection } from "./selection";
import type { Gesture, ToolHost } from "./tools/host";

type Read = {
  computed: Record<string, string>;
  parent: Record<string, string> | null;
  flex: boolean;
  /** Stamped children's boxes, in the frame's CSS pixels. */
  children: Rect[];
};

/** What's being dragged or pointed at: a side's padding or the gap. */
type Part = { kind: "padding"; side: PaddingSide } | { kind: "gap"; index: number };

const SIDES: readonly PaddingSide[] = ["top", "right", "bottom", "left"];
const num = (v: string | undefined) => parseFloat(v ?? "") || 0;
const paddingOf = (c: Record<string, string>): Sides => ({
  top: num(c.paddingTop),
  right: num(c.paddingRight),
  bottom: num(c.paddingBottom),
  left: num(c.paddingLeft),
});

/**
 * The padding and gap handles over a selected auto layout element, previewed through the bridge
 * and sent as one style edit on release, and its Hug and Fill controls.
 */
export function LayoutHandles({ host, state }: { host: ToolHost; state: EditorState }) {
  const selection = useSelection();
  const item = selection.length === 1 && selection[0]!.loc !== undefined ? selection[0]! : null;
  const key = item ? keyOf(item) : null;
  const [read, setRead] = useState<Read | null>(null);
  const [part, setPart] = useState<Part | null>(null);
  const [value, setValue] = useState<number | null>(null);
  const [active, setActive] = useState(false);

  const measure = useCallback(async (): Promise<Read | null> => {
    if (!item) return null;
    const bridge = host.bridge(item.frameId);
    const index = item.index ?? 0;
    const inspection = await bridge?.inspect(item.loc!, index).catch(() => null);
    if (!bridge || !inspection) return null;
    const up = host.facts.get(keyOf(item))?.path[0];
    const parent = up ? await bridge.inspect(up.loc, 0).catch(() => null) : null;
    const flex = inspection.computed.display?.includes("flex") ?? false;
    if (!flex && !parent?.computed.display?.includes("flex")) {
      return {
        computed: inspection.computed,
        parent: parent?.computed ?? null,
        flex,
        children: [],
      };
    }
    const layers = await bridge.layers().catch(() => [] as LayerNode[]);
    const kids = childrenIn(layers, { loc: item.loc!, index }) ?? [];
    const rects = await bridge
      .rects([...new Set(kids.map((k) => k.loc))])
      .catch(() => ({}) as Record<string, Rect[]>);
    return {
      computed: inspection.computed,
      parent: parent?.computed ?? null,
      flex,
      children: kids.flatMap((k) => {
        const r = rects[k.loc]?.[k.index];
        return r ? [r] : [];
      }),
    };
    // `item` is keyed by `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host, key]);

  useEffect(() => {
    let live = true;
    void measure().then((r) => live && setRead(r));
    return () => {
      live = false;
    };
    // Measured again when the selection, its box or the frame changes.
  }, [measure, state.updates, key && state.rects[key]?.width, key && state.rects[key]?.height]);

  const rect = key ? state.rects[key] : null;
  const frame = item ? host.frame(item.frameId) : undefined;
  const facts = key ? host.facts.get(key) : undefined;
  if (!item || !rect || !frame || !facts || !read || (state.dragging && !active)) return null;
  const box = host.boxOf(frame);
  const world = (r: Rect): Rect => ({ ...r, x: box.x + r.x, y: box.y + r.y });
  const loc = item.loc!;
  const padding = paddingOf(read.computed);
  const row = read.computed.flexDirection?.startsWith("row") ?? true;
  const axis = row ? ("x" as const) : ("y" as const);
  const gap = num(row ? read.computed.columnGap : read.computed.rowGap);
  const edge = {
    top: rect.y + num(read.computed.borderTopWidth),
    left: rect.x + num(read.computed.borderLeftWidth),
    right: rect.x + rect.width - num(read.computed.borderRightWidth),
    bottom: rect.y + rect.height - num(read.computed.borderBottomWidth),
  };
  const bandOf = (side: PaddingSide): Rect => {
    const across = { x: edge.left, width: edge.right - edge.left };
    const down = { y: edge.top, height: edge.bottom - edge.top };
    if (side === "top") return { ...across, y: edge.top, height: padding.top };
    if (side === "bottom")
      return { ...across, y: edge.bottom - padding.bottom, height: padding.bottom };
    if (side === "left") return { ...down, x: edge.left, width: padding.left };
    return { ...down, x: edge.right - padding.right, width: padding.right };
  };
  const bands = read.flex ? gapBands(read.children, axis) : [];

  const send = async (styles: Record<string, string | null>) => {
    await host.edit([
      {
        kind: "style",
        locs: [loc],
        tag: facts.tag,
        styles,
        revs: revsOf([{ loc, rev: facts.rev }]),
      },
    ]);
    void host.refreshSelection();
  };

  const beginDrag = (which: Part, from: Point): Gesture | null => {
    const bridge = host.bridge(item.frameId);
    if (!bridge) return null;
    setActive(true);
    setPart(which);
    const zoom = () => host.camera.view.zoom;
    const remeasure = () => void measure().then((r) => r && setRead(r));
    let styles: Record<string, string> = {};
    return {
      move: (screen, _, e) => {
        const d = { x: (screen.x - from.x) / zoom(), y: (screen.y - from.y) / zoom() };
        if (which.kind === "padding") {
          const inward = { top: d.y, bottom: -d.y, left: d.x, right: -d.x }[which.side];
          const next = draggedPadding(padding, which.side, inward, {
            alt: e.altKey,
            shift: e.shiftKey,
          });
          styles = changedPadding(padding, next);
          setValue(next[which.side]);
        } else {
          const next = Math.max(0, Math.round(gap + (axis === "x" ? d.x : d.y)));
          styles = next === gap ? {} : { gap: `${next}px` };
          setValue(next);
        }
        bridge.preview(loc, styles);
        remeasure();
      },
      end: async (commit) => {
        setActive(false);
        setPart(null);
        setValue(null);
        if (commit && Object.keys(styles).length > 0) await send(styles);
        else bridge.preview(loc, null);
      },
    };
  };

  const onPress = (which: Part) => (e: ReactPointerEvent<HTMLDivElement>) => {
    const from = { x: e.clientX, y: e.clientY };
    host.press(e.nativeEvent, {
      begin: async () => beginDrag(which, from),
      click: () => {},
    });
  };

  const handle = (which: Part, band: Rect, vertical: boolean, label: number) => {
    const shown =
      which.kind === "gap"
        ? part?.kind === "gap"
        : part?.kind === "padding" && part.side === which.side;
    const at = world(band);
    const center = { x: at.x + at.width / 2, y: at.y + at.height / 2 };
    return (
      <div key={which.kind === "gap" ? `gap-${which.index}` : which.side}>
        {shown && <div {...stylex.props(styles.band(world(band)))} />}
        <div
          data-canvas-ui
          data-camera-ignore
          data-layout-handle={which.kind === "gap" ? "gap" : which.side}
          onPointerEnter={() => !state.dragging && setPart(which)}
          onPointerLeave={() => !state.dragging && setPart(null)}
          onPointerDown={onPress(which)}
          {...stylex.props(styles.hit(center.x, center.y), vertical ? styles.ew : styles.ns)}
        >
          <div {...stylex.props(styles.bar, vertical ? styles.barTall : styles.barWide)} />
          {shown && <span {...stylex.props(styles.tag)}>{value ?? label}</span>}
        </div>
      </div>
    );
  };

  const context = sizeContextOf(
    read.computed as never,
    read.parent ? (read.parent as never) : null,
  );
  const modeOf = (a: Axis) => sizeModeOf(a, {}, context);
  const cycle = (a: Axis) => {
    // Fill needs a parent's layout to fill: an out-of-flow element has none.
    const order: SizeMode[] =
      context.parent === "none" ? ["fixed", "hug"] : ["fixed", "hug", "fill"];
    const mode = modeOf(a);
    const next = order[(order.indexOf(mode) + 1) % order.length]!;
    void send(
      sizeModeStyles(a, next, {}, context, Math.round(a === "width" ? rect.width : rect.height)),
    );
  };
  const showSizes = read.flex || read.parent?.display?.includes("flex");

  return (
    <>
      {read.flex &&
        SIDES.map((side) =>
          handle(
            { kind: "padding", side },
            bandOf(side),
            side === "left" || side === "right",
            padding[side],
          ),
        )}
      {bands.map((band, index) => handle({ kind: "gap", index }, band, row, gap))}
      {showSizes && !state.dragging && (
        <div
          {...stylex.props(styles.sizes(world(rect), state.label ? 30 : 6))}
          data-layout-sizes
          data-canvas-ui
          data-camera-ignore
        >
          {(["width", "height"] as const).map((a) => (
            <button
              key={a}
              type="button"
              title={`${a === "width" ? "Width" : "Height"}: ${modeName(modeOf(a))}. Click to change.`}
              aria-label={`${a === "width" ? "Width" : "Height"}: ${modeName(modeOf(a))}`}
              onClick={() => cycle(a)}
              {...stylex.props(styles.size)}
            >
              {a === "width" ? "W" : "H"} {modeName(modeOf(a))}
            </button>
          ))}
        </div>
      )}
    </>
  );
}

const modeName = (mode: SizeMode) => ({ fixed: "Fixed", hug: "Hug", fill: "Fill" })[mode];

const styles = stylex.create({
  band: (r: Rect) => ({
    position: "absolute",
    left: r.x,
    top: r.y,
    width: r.width,
    height: r.height,
    backgroundColor: colors.hover,
    opacity: 0.28,
    pointerEvents: "none",
  }),
  hit: (x: number, y: number) => ({
    position: "absolute",
    left: x,
    top: y,
    width: 20,
    height: 20,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    transform: "translate(-50%, -50%) scale(var(--inv-zoom, 1))",
    zIndex: 2,
    pointerEvents: "auto",
  }),
  ns: { cursor: "ns-resize" },
  ew: { cursor: "ew-resize" },
  bar: {
    borderRadius: radii.sm,
    backgroundColor: colors.hover,
    boxShadow: `0 0 0 1px ${colors.halo}`,
  },
  barWide: { width: 16, height: 3 },
  barTall: { width: 3, height: 16 },
  tag: {
    position: "absolute",
    left: "50%",
    bottom: "100%",
    transform: "translate(-50%, -2px)",
    padding: "1px 5px",
    borderRadius: radii.sm,
    backgroundColor: colors.hover,
    color: colors.halo,
    boxShadow: shadows.raised,
    fontFamily: fonts.sans,
    fontSize: 11,
    lineHeight: "14px",
    whiteSpace: "nowrap",
    pointerEvents: "none",
  },
  sizes: (r: Rect, offset: number) => ({
    position: "absolute",
    left: r.x + r.width / 2,
    top: r.y + r.height,
    display: "flex",
    gap: 2,
    transform: `translate(-50%, calc(${offset}px * var(--inv-zoom, 1))) scale(var(--inv-zoom, 1))`,
    transformOrigin: "50% 0",
    zIndex: 2,
    pointerEvents: "auto",
  }),
  size: {
    borderWidth: 0,
    borderStyle: "none",
    padding: "1px 6px",
    borderRadius: radii.sm,
    backgroundColor: colors.hover,
    color: colors.halo,
    boxShadow: shadows.raised,
    fontFamily: fonts.sans,
    fontSize: 11,
    lineHeight: "14px",
    whiteSpace: "nowrap",
    cursor: "pointer",
  },
});
