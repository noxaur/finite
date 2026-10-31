"use client";

import * as stylex from "@stylexjs/stylex";
import { useEffect, useRef, useState } from "react";
import { Api } from "@/api/Api";
import { fit, union } from "@/design/camera";
import { Renderer } from "@/design/renderer";
import { Replica } from "@/design/replica";
import { runtime } from "@/runtime";
import { colors } from "@/styles/tokens.stylex";

/**
 * A static preview of a design. It loads the snapshot once the card scrolls
 * into view, and again when `seq` changes.
 */
export function Thumbnail({ id, seq }: { id: string; seq: number }) {
  const frameRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [empty, setEmpty] = useState(false);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) {
        setVisible(true);
        observer.disconnect();
      }
    });
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const frame = frameRef.current;
    const world = worldRef.current;
    if (!visible || !frame || !world) return;
    const controller = new AbortController();
    let renderer: Renderer | undefined;
    // Agents edit in bursts; wait for a pause before re-rendering.
    const timer = setTimeout(() => {
      void runtime
        .runPromise(
          Api.use((api) => api.getDesign(id)),
          { signal: controller.signal },
        )
        .then(
          (snapshot) => {
            const replica = new Replica();
            replica.load(snapshot);
            // Not live: thumbnails never run an artboard's scripts.
            renderer = new Renderer(world, replica);
            world.replaceChildren();
            renderer.reset();
            const bounds = union(renderer.artboardBounds().values());
            setEmpty(bounds === null);
            if (!bounds) return;
            const view = fit(bounds, frame.clientWidth, frame.clientHeight, 12);
            world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`;
            world.style.setProperty("--inv-zoom", "0");
          },
          () => {},
        );
    }, 300);
    return () => {
      clearTimeout(timer);
      controller.abort();
      renderer?.dispose();
    };
  }, [id, seq, visible]);

  return (
    <div ref={frameRef} {...stylex.props(styles.frame)}>
      <div ref={worldRef} {...stylex.props(styles.world)} />
      {empty && <span {...stylex.props(styles.empty)}>Empty</span>}
    </div>
  );
}

const styles = stylex.create({
  frame: {
    position: "relative",
    aspectRatio: "16 / 10",
    overflow: "hidden",
    backgroundColor: colors.canvas,
    pointerEvents: "none",
  },
  world: {
    position: "absolute",
    left: 0,
    top: 0,
    transformOrigin: "0 0",
  },
  empty: {
    position: "absolute",
    inset: 0,
    display: "grid",
    placeItems: "center",
    fontSize: 13,
    color: colors.muted,
  },
});
