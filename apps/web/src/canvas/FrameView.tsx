"use client";

import * as stylex from "@stylexjs/stylex";
import type { Frame } from "@finite/protocol";
import { useEffect, useRef } from "react";
import { colors, radii, space } from "@/styles/tokens.stylex";
import { connectFrame } from "./bridge";
import { finite } from "@/client/finite";
import type { CanvasEditor } from "./editor";
import { frameSrc } from "./frameSrc";

/**
 * One frame's body on the canvas: the live iframe when it's mounted, else a quiet card with its
 * name. The iframe never takes the pointer (the editor hit-tests through the bridge) unless
 * Interact is on. Its bridge reports the content's size (hug frames), HMR updates (the selection
 * is measured again), keys (canvas shortcuts work with focus inside) and errors (to the server,
 * for the agent's `frame_errors`).
 */
export function FrameView({
  designId,
  frame,
  width,
  height,
  previewUrl,
  mounted,
  interact,
  editor,
}: {
  designId: string;
  frame: Frame;
  width: number;
  height: number;
  previewUrl: string | undefined;
  mounted: boolean;
  interact: boolean;
  editor: CanvasEditor;
}) {
  const ref = useRef<HTMLIFrameElement>(null);
  const src = previewUrl ? frameSrc(previewUrl, frame.source) : undefined;
  const hug = frame.hug ?? false;

  useEffect(() => {
    const iframe = ref.current;
    if (!iframe || !src || !mounted) return;
    const bridge = connectFrame(iframe, frame.id);
    const off = bridge.on((event) => {
      switch (event.type) {
        case "size":
          if (hug) editor.setSize(frame.id, Math.max(20, Math.round(event.height)));
          break;
        case "updated":
          editor.frameChanged();
          break;
        case "key":
          editor.key({
            key: event.key,
            code: event.code,
            metaKey: event.meta,
            ctrlKey: event.ctrl,
            shiftKey: event.shift,
            altKey: event.alt,
          });
          break;
        case "error":
          void finite
            .request("frame.error", {
              designId,
              frameId: frame.id,
              kind: event.kind,
              message: event.message,
              ...(event.stack === undefined ? {} : { stack: event.stack }),
            })
            .catch(() => {});
          break;
      }
    });
    // Measure the selection once the frame can answer.
    void bridge.layers().then(
      () => editor.frameChanged(),
      () => {},
    );
    return () => {
      off();
      bridge.close();
    };
  }, [designId, frame.id, src, hug, editor, mounted]);

  if (!mounted || !src) {
    return (
      <div {...stylex.props(styles.card)} style={{ width, height }}>
        <span {...stylex.props(styles.cardName)}>{src ? frame.name : "Starting preview…"}</span>
      </div>
    );
  }
  return (
    <iframe
      ref={ref}
      src={src}
      title={frame.name}
      data-frame-id={frame.id}
      {...stylex.props(styles.iframe, interact ? styles.live : styles.still)}
      style={{ width, height }}
    />
  );
}

const styles = stylex.create({
  iframe: {
    display: "block",
    maxWidth: "none",
    flexShrink: 0,
    borderWidth: 0,
    backgroundColor: colors.halo,
  },
  still: { pointerEvents: "none" },
  live: { pointerEvents: "auto" },
  card: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.borderSoft,
    borderRadius: radii.sm,
    pointerEvents: "none",
  },
  cardName: {
    color: colors.faint,
    fontSize: "calc(14px * var(--inv-zoom, 1))",
    paddingInline: space.md,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
});
