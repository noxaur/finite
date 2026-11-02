"use client";

import * as stylex from "@stylexjs/stylex";
import { useEffect, useRef, useState } from "react";
import { Api } from "@/api/Api";
import { fit, union } from "@/design/camera";
import { Renderer } from "@/design/renderer";
import { Replica } from "@/design/replica";
import { loadDesignModel } from "@/design/wasm";
import { runtime } from "@/runtime";
import { colors } from "@/styles/tokens.stylex";

/** Agents edit in bursts: wait for a pause this long before re-rendering... */
const PAUSE_MS = 300;
/** ...and fetch at most this often while a design keeps changing. */
const MIN_INTERVAL_MS = 2000;
/**
 * Designs bigger than this show their size instead of a preview. A preview
 * fetches the whole snapshot and builds every node, and refetches while
 * agents edit: a 100,000-node design is about 15 MB every 2 seconds.
 */
export const PREVIEW_NODES = 5000;

/**
 * A static preview of a design. It loads the snapshot once the card scrolls
 * into view, and again when `seq` changes.
 */
export function Thumbnail({ id, seq, nodeCount }: { id: string; seq: number; nodeCount: number }) {
  if (nodeCount > PREVIEW_NODES) {
    return (
      <div {...stylex.props(styles.frame)}>
        <span {...stylex.props(styles.empty)}>
          {nodeCount.toLocaleString()} nodes, too many to preview
        </span>
      </div>
    );
  }
  return <Preview id={id} seq={seq} />;
}

function Preview({ id, seq }: { id: string; seq: number }) {
  const frameRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [empty, setEmpty] = useState(false);
  const lastFetch = useRef(0);

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
    let replica: Replica | undefined;
    let observer: ResizeObserver | undefined;
    const wait = Math.max(PAUSE_MS, lastFetch.current + MIN_INTERVAL_MS - Date.now());
    const timer = setTimeout(() => {
      lastFetch.current = Date.now();
      void runtime
        .runPromise(
          Api.use((api) => api.getDesign(id)),
          { signal: controller.signal },
        )
        // The document rules run in WebAssembly, so wait for the module too.
        .then((snapshot) => loadDesignModel().then(() => snapshot))
        .then(
          (snapshot) => {
            if (controller.signal.aborted) return;
            replica = new Replica();
            replica.load(snapshot);
            // Not live: thumbnails never run an artboard's scripts.
            renderer = new Renderer(world, replica);
            world.replaceChildren();
            renderer.reset();
            const place = () => {
              const bounds = union(renderer!.artboardBounds().values());
              setEmpty(bounds === null);
              if (!bounds) return;
              const view = fit(bounds, frame.clientWidth, frame.clientHeight, 12);
              world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`;
              world.style.setProperty("--inv-zoom", "0");
            };
            place();
            // An auto-height artboard grows as its images and fonts load.
            if (typeof ResizeObserver !== "undefined") {
              observer = new ResizeObserver(place);
              for (const board of world.children) observer.observe(board);
            }
          },
          () => {},
        );
    }, wait);
    return () => {
      clearTimeout(timer);
      controller.abort();
      observer?.disconnect();
      renderer?.dispose();
      // The document lives in WebAssembly memory, which isn't garbage collected.
      replica?.free();
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
