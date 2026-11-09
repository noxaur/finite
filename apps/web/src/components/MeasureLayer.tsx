"use client";

import * as stylex from "@stylexjs/stylex";
import { drawFigure, type Figure } from "@finite/protocol";
import { type CSSProperties, useCallback, useMemo, useSyncExternalStore } from "react";
import { type CanvasEditor, type MeasureState, type Probe, sameElement } from "../canvas/editor";
import { colors } from "@/styles/tokens.stylex";

/** Pin and hover when they're two elements in one frame: the pair the distance is between. */
export function comparedPair({ hover, pin }: MeasureState): [Probe, Probe] | null {
  return pin && hover && pin.frameId === hover.frameId && !sameElement(pin, hover)
    ? [pin, hover]
    : null;
}

export function figuresOf(measure: MeasureState): { frameId: string; figure: Figure }[] {
  const pair = comparedPair(measure);
  if (pair) return [{ frameId: pair[0].frameId, figure: { target: pair[0].m, other: pair[1].m } }];
  const { hover, pin } = measure;
  const probes = pin && hover && sameElement(pin, hover) ? [pin] : [pin, hover];
  return probes
    .filter((p): p is Probe => p !== null)
    .map((p) => ({ frameId: p.frameId, figure: { target: p.m } }));
}

export function drawingsOf(measure: MeasureState, zoom: number) {
  return figuresOf(measure).map(({ frameId, figure }) => ({
    frameId,
    ...drawFigure(figure, zoom),
  }));
}

/** Camera zoom in quarter octaves: a pinch redraws about four times per doubling. */
export function zoomStepOf(zoom: number) {
  return 2 ** (Math.round(Math.log2(zoom) * 4) / 4);
}

export function useZoomStep(editor: CanvasEditor) {
  const { camera } = editor;
  const subscribe = useCallback(
    (fn: () => void) => {
      const off = camera.subscribe(fn);
      return () => void off();
    },
    [camera],
  );
  const step = useCallback(() => zoomStepOf(camera.view.zoom), [camera]);
  return useSyncExternalStore(subscribe, step, step);
}

const FIGURE_VARS = { "--measure": colors.measure, "--measure-on": colors.halo } as CSSProperties;

/**
 * Draws the measure tool's figures over the frames. It sits in the camera's world, so it pans and
 * zooms with them; screen-constant lines and pills use `--inv-zoom`.
 */
export function MeasureLayer({ editor, measure }: { editor: CanvasEditor; measure: MeasureState }) {
  const zoom = useZoomStep(editor);
  const drawings = useMemo(() => drawingsOf(measure, zoom), [measure, zoom]);
  return drawings.map(({ frameId, html }) => {
    const frame = editor.frame(frameId);
    if (!frame) return null;
    const box = editor.boxOf(frame);
    // Dynamic StyleX values come back in `style`, so the variables go in after it.
    const root = stylex.props(styles.root(box.x, box.y));
    return (
      <div
        key={frameId}
        data-measure={frameId}
        {...root}
        style={{ ...root.style, ...FIGURE_VARS }}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  });
}

const styles = stylex.create({
  root: (x: number, y: number) => ({
    position: "absolute",
    left: x,
    top: y,
    width: 0,
    height: 0,
    pointerEvents: "none",
  }),
});
