"use client";

import * as stylex from "@stylexjs/stylex";
import { Cause, Exit } from "effect";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Api, Refused } from "@/api/Api";
import { Camera, union, type View } from "@/design/camera";
import { type Hit, Renderer } from "@/design/renderer";
import { Replica } from "@/design/replica";
import { DesignSession, initialSessionState, type SessionState } from "@/design/session";
import { loadDesignModel } from "@/design/wasm";
import { mcpUrl } from "@/lib/mcp";
import { formatOf } from "@/lib/transfer";
import { localUser } from "@/lib/user";
import { timeAgo } from "@/lib/time";
import { runtime } from "@/runtime";
import { colors, radii, space } from "@/styles/tokens.stylex";
import { CommentLayer, type Draft, type Mode, pinPosition, ToolPill } from "./Comments";
import { CommentsPanel } from "./CommentsPanel";
import { PagesSidebar } from "./PagesSidebar";
import { SharedCssPanel } from "./SharedCss";
import { ExportMenu, ImportButton, ImportResultCard, type ImportState } from "./Transfer";

/** How long "show what changed" outlines stay up. */
const FLASH_MS = 1800;
/** A press that moves farther than this is a drag, not a click. */
const CLICK_SLOP = 4;

const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;

/**
 * A live view of one design. `DesignSession` streams it from the server and
 * the renderer patches the DOM; this component adds the camera, comments and
 * keyboard shortcuts. Users can't edit the design's artboards, but in comment
 * mode they pin comments that agents pick up over MCP, and they can edit the
 * shared CSS every artboard uses.
 */

/** Why a comment or edit didn’t go through: the server’s reason, or a connection problem. */
function unsent(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  if (error instanceof Refused) {
    const reason = error.reason.trim();
    return `${reason.charAt(0).toUpperCase()}${reason.slice(1)}.`;
  }
  return "Couldn’t send. Check the connection and try again.";
}
/**
 * Waits for finite.wasm, which holds the document rules. Returns `"ready"`,
 * `"loading"`, or why it failed. It starts loading with the page's code, so
 * it's usually ready by the time the canvas mounts.
 */
function useDesignModel(): "ready" | "loading" | Error {
  const [state, setState] = useState<"ready" | "loading" | Error>("loading");
  useEffect(() => {
    let cancelled = false;
    loadDesignModel().then(
      () => !cancelled && setState("ready"),
      (error: unknown) =>
        !cancelled && setState(error instanceof Error ? error : new Error(String(error))),
    );
    return () => {
      cancelled = true;
    };
  }, []);
  return state;
}

export function DesignCanvas({ id }: { id: string }) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<HTMLDivElement>(null);
  const framesRef = useRef<HTMLDivElement>(null);
  const pressRef = useRef<{ x: number; y: number } | null>(null);
  const hoverFrame = useRef(0);
  const pointerRef = useRef<{ x: number; y: number } | null>(null);
  const refreshHover = useRef(() => {});
  const cameraRef = useRef<Camera | null>(null);
  // The view the camera framed the artboards with, until the person moves it.
  const framedRef = useRef<View | null>(null);
  const rendererRef = useRef<Renderer | null>(null);
  const sessionRef = useRef<DesignSession | null>(null);

  // Re-rendering on every session update also moves pins with their artboards.
  const [session, setSession] = useState<SessionState>(initialSessionState);
  const { meta, presence, status, activity, comments, working, pages } = session;
  const [zoom, setZoom] = useState(1);
  const [missing, setMissing] = useState(false);
  const model = useDesignModel();
  const [, setTick] = useState(0);
  const [mode, setMode] = useState<Mode>("pointer");
  const [openId, setOpenId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [hover, setHover] = useState<Hit | null>(null);
  const [flash, setFlash] = useState<ReadonlyArray<string>>([]);
  // The page picked in the sidebar, or `null` for the first. A page that's
  // gone shows the first page, as the renderer does.
  const [pickedPage, setPickedPage] = useState<string | null>(null);
  const page = pages.find((p) => p.id === pickedPage) ?? pages[0];
  // The shared CSS, the comments list, the export menu and an import's result open in the
  // same place, one at a time.
  const [panel, setPanel] = useState<"css" | "comments" | "export" | "import" | null>(null);
  const togglePanel = (name: "css" | "comments" | "export") =>
    setPanel((open) => (open === name ? null : name));
  const [imported, setImported] = useState<ImportState | null>(null);

  // Whether a draft or thread is open, for the window key handler.
  const popupRef = useRef(false);
  popupRef.current = draft !== null || openId !== null;

  useEffect(() => {
    const viewport = viewportRef.current;
    const world = worldRef.current;
    const frames = framesRef.current;
    if (!viewport || !world || !frames || model !== "ready") return;

    const camera = new Camera(viewport, world);
    const replica = new Replica();
    framedRef.current = null;
    const renderer = new Renderer(frames, replica, {
      live: true,
      onWheel: (event) => camera.wheel(event),
      // An auto-height artboard with a script is measured inside its iframe,
      // so its real height arrives after the first frame. Frame it again,
      // unless the person has already panned or zoomed.
      onResize: () => {
        const view = camera.view;
        const framed = framedRef.current;
        if (!framed || framed.x !== view.x || framed.y !== view.y || framed.zoom !== view.zoom) {
          return;
        }
        const bounds = union(renderer.artboardBounds().values());
        if (!bounds) return;
        camera.fitTo(bounds);
        framedRef.current = camera.view;
      },
      // A sandboxed artboard answered: redo the hover test and redraw outlines.
      onLayout: () => {
        refreshHover.current();
        setTick((t) => t + 1);
      },
    });
    const session = new DesignSession(renderer, replica);
    sessionRef.current = session;
    rendererRef.current = renderer;
    cameraRef.current = camera;
    // Hide the artboards outside the view, before React re-renders for the zoom.
    camera.subscribe(() => renderer.setViewport(camera.visibleWorld()));
    camera.subscribe((view) => setZoom(view.zoom));
    const resize = new ResizeObserver(() => renderer.setViewport(camera.visibleWorld()));
    resize.observe(viewport);
    // A new renderer starts on the first page.
    setPickedPage(null);

    // Frame the artboards once, when the first ones appear.
    const unsubscribe = session.subscribe(() => {
      setSession(session.state);
      if (framedRef.current) return;
      const bounds = union(renderer.artboardBounds().values());
      if (bounds) {
        camera.fitTo(bounds);
        framedRef.current = camera.view;
      }
    });
    const close = session.connect(id);

    // The socket can't report a 404, so ask the API whether the design exists.
    const controller = new AbortController();
    void runtime
      .runPromiseExit(
        Api.use((api) => api.getDesign(id)),
        { signal: controller.signal },
      )
      .then((exit) => {
        if (!controller.signal.aborted && Exit.isFailure(exit)) setMissing(true);
      });

    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) {
        if (e.key === "Escape") {
          setDraft(null);
          setOpenId(null);
        }
        return;
      }
      if (e.key === "v" || e.key === "V") setMode("pointer");
      else if (e.key === "c" || e.key === "C") setMode("comment");
      else if (e.key === "Escape") {
        // Close the draft or thread first, then leave comment mode.
        if (!popupRef.current) setMode("pointer");
        setDraft(null);
        setOpenId(null);
      } else if (e.key === "!" || (e.shiftKey && e.code === "Digit1"))
        camera.fitTo(union(renderer.artboardBounds().values()));
      else if (e.key === "0" && !e.metaKey && !e.ctrlKey) camera.set({ ...camera.view, zoom: 1 });
      else if (e.key === "=" || e.key === "+") camera.zoomBy(1.25);
      else if (e.key === "-") camera.zoomBy(0.8);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);

    // Keeps "2 minutes ago" labels fresh.
    const ticker = setInterval(() => setTick((t) => t + 1), 15_000);

    return () => {
      unsubscribe();
      close();
      controller.abort();
      resize.disconnect();
      camera.dispose();
      renderer.dispose();
      // The document lives in WebAssembly memory, which isn't garbage collected.
      replica.free();
      window.removeEventListener("keydown", onKey);
      clearInterval(ticker);
      cancelAnimationFrame(hoverFrame.current);
      frames.replaceChildren();
    };
  }, [id, model]);

  // In comment mode the left button places comments instead of panning.
  useEffect(() => {
    const commenting = mode === "comment";
    if (cameraRef.current) cameraRef.current.dragToPan = !commenting;
    rendererRef.current?.setCommenting(commenting);
    if (!commenting) {
      setDraft(null);
      setHover(null);
    }
  }, [mode]);

  useEffect(() => {
    if (flash.length === 0) return;
    const timer = setTimeout(() => setFlash([]), FLASH_MS);
    return () => clearTimeout(timer);
  }, [flash]);

  const hoverAt = (clientX: number, clientY: number) => {
    const hit = rendererRef.current?.hitTest(clientX, clientY) ?? null;
    setHover((prev) =>
      prev?.nodeId === hit?.nodeId && prev?.artboardId === hit?.artboardId ? prev : hit,
    );
  };
  // Read by the renderer's onLayout callback, which outlives this render.
  refreshHover.current = () => {
    const pointer = pointerRef.current;
    if (mode === "comment" && !draft && pointer) hoverAt(pointer.x, pointer.y);
  };

  const onCanvasPointerMove = (e: React.PointerEvent) => {
    if (mode !== "comment" || draft) return;
    const { clientX, clientY } = e;
    pointerRef.current = { x: clientX, y: clientY };
    cancelAnimationFrame(hoverFrame.current);
    hoverFrame.current = requestAnimationFrame(() => hoverAt(clientX, clientY));
  };

  const onCanvasClick = (e: React.MouseEvent) => {
    const press = pressRef.current;
    pressRef.current = null;
    const moved = press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > CLICK_SLOP;
    if (moved || (e.target instanceof Element && e.target.closest("[data-camera-ignore]"))) return;
    // A click elsewhere closes the open thread or draft before it starts a new one.
    if (openId || draft) {
      setOpenId(null);
      setDraft(null);
      return;
    }
    const camera = cameraRef.current;
    const replica = sessionRef.current?.replica;
    if (mode !== "comment" || !camera || !replica) return;
    const point = camera.toWorld(e.clientX, e.clientY);
    const hit = rendererRef.current?.hitTest(e.clientX, e.clientY) ?? null;
    const board = hit ? replica.get(hit.artboardId) : undefined;
    setDraft(
      hit && board
        ? {
            artboardId: hit.artboardId,
            nodeId: hit.nodeId,
            x: point.x - (board.x ?? 0),
            y: point.y - (board.y ?? 0),
          }
        : { artboardId: null, nodeId: null, ...point },
    );
  };

  const postComment = async (body: string) => {
    if (!draft) return undefined;
    const exit = await runtime.runPromiseExit(
      Api.use((api) => api.createComment(id, { author: localUser(), body, ...draft })),
    );
    if (Exit.isFailure(exit)) return unsent(exit.cause);
    sessionRef.current?.upsertComment(exit.value);
    setDraft(null);
    return undefined;
  };

  const reply = async (commentId: string, body: string) => {
    const exit = await runtime.runPromiseExit(
      Api.use((api) => api.replyToComment(id, commentId, { author: localUser(), body })),
    );
    if (Exit.isFailure(exit)) return unsent(exit.cause);
    sessionRef.current?.upsertComment(exit.value);
    return undefined;
  };

  const editMessage = async (commentId: string, body: string) => {
    const exit = await runtime.runPromiseExit(
      Api.use((api) => api.editLastMessage(id, commentId, { author: localUser(), body })),
    );
    if (Exit.isFailure(exit)) return unsent(exit.cause);
    sessionRef.current?.upsertComment(exit.value);
    return undefined;
  };

  const deleteComment = (commentId: string) => {
    setOpenId(null);
    void runtime.runPromiseExit(Api.use((api) => api.deleteComment(id, commentId))).then((exit) => {
      if (Exit.isSuccess(exit)) sessionRef.current?.removeComment(commentId);
    });
  };

  /** Shows the artboards on one page, framed in the viewport. */
  const showPage = (pageId: string) => {
    setPickedPage(pageId);
    const renderer = rendererRef.current;
    if (!renderer) return;
    renderer.setPage(pageId);
    const bounds = union(renderer.artboardBounds().values());
    if (bounds) cameraRef.current?.fitTo(bounds);
    // So auto-height artboards reframe it as they grow, and an empty page
    // frames its first artboard when one arrives.
    framedRef.current = bounds ? (cameraRef.current?.view ?? null) : null;
    setDraft(null);
    setOpenId(null);
    setHover(null);
  };

  // From the comments list: open the thread and bring its pin into view,
  // on its artboard's page.
  const showComment = (commentId: string) => {
    const comment = comments.get(commentId);
    const replica = sessionRef.current?.replica;
    const board = comment?.artboardId ? replica?.get(comment.artboardId) : undefined;
    if (board?.parent === null && replica && replica.pageOf(board) !== page?.id) {
      setPickedPage(replica.pageOf(board));
      rendererRef.current?.setPage(replica.pageOf(board));
    }
    const at = comment && replica ? pinPosition(replica, comment) : null;
    if (at) cameraRef.current?.centerOn(at.x, at.y);
    setDraft(null);
    setOpenId(commentId);
  };

  const saveCss = async (css: string) => {
    const exit = await runtime.runPromiseExit(
      Api.use((api) => api.setSharedCss(id, localUser(), css)),
    );
    return Exit.isFailure(exit) ? unsent(exit.cause) : undefined;
  };

  // The new artboards arrive over the socket, so all this shows is how the import went.
  const importFile = async (file: File) => {
    const format = formatOf(file.name);
    if (!format) {
      setImported({
        status: "failed",
        message: "Pick an .html, .htm, .finite or .figma.json file.",
      });
      setPanel("import");
      return;
    }
    setImported({ status: "working" });
    const bytes = new Uint8Array(await file.arrayBuffer());
    const exit = await runtime.runPromiseExit(
      // Onto the page being looked at, so the new artboards show at once.
      Api.use((api) => api.importFile(id, { name: file.name, format, bytes }, page.id)),
    );
    setImported(
      Exit.isSuccess(exit)
        ? { status: "done", result: exit.value }
        : { status: "failed", message: unsent(exit.cause) },
    );
    setPanel("import");
  };

  const resolve = (commentId: string, resolved: boolean) => {
    void runtime
      .runPromiseExit(Api.use((api) => api.setCommentResolved(id, commentId, resolved)))
      .then((exit) => {
        if (Exit.isSuccess(exit)) sessionRef.current?.upsertComment(exit.value);
      });
  };

  // Outline what a comment points at: the draft's target, the open thread's
  // node, or whatever is under the pointer in comment mode. Rects are
  // converted to canvas coordinates so they pan and zoom with the design.
  const openComment = openId ? comments.get(openId) : undefined;
  const target =
    draft?.nodeId ?? openComment?.nodeId ?? (mode === "comment" ? hover?.nodeId : undefined);
  const canvasRect = (nodeId: string) => {
    const rect = rendererRef.current?.nodeRect(nodeId);
    const camera = cameraRef.current;
    if (!rect || !camera) return null;
    const a = camera.toWorld(rect.left, rect.top);
    const b = camera.toWorld(rect.right, rect.bottom);
    return { x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y };
  };
  const outlines = [
    ...(target ? [{ key: "target", rect: canvasRect(target), flash: false }] : []),
    ...flash.map((nodeId) => ({ key: `flash:${nodeId}`, rect: canvasRect(nodeId), flash: true })),
  ];

  const openCount = [...comments.values()].filter((c) => !c.resolved).length;

  const fitAll = () => {
    const renderer = rendererRef.current;
    if (renderer) cameraRef.current?.fitTo(union(renderer.artboardBounds().values()));
  };

  if (model instanceof Error) {
    return (
      <main {...stylex.props(styles.notFound)}>
        <p>The viewer couldn’t start: {model.message}</p>
        <Link href="/" {...stylex.props(styles.link)}>
          Back to designs
        </Link>
      </main>
    );
  }

  if (missing) {
    return (
      <main {...stylex.props(styles.notFound)}>
        <p>This design doesn’t exist.</p>
        <Link href="/" {...stylex.props(styles.link)}>
          Back to designs
        </Link>
      </main>
    );
  }

  return (
    <main {...stylex.props(styles.page)}>
      <div
        ref={viewportRef}
        onPointerDown={(e) => {
          pressRef.current = { x: e.clientX, y: e.clientY };
        }}
        onPointerMove={onCanvasPointerMove}
        onPointerLeave={() => setHover(null)}
        onClick={onCanvasClick}
        {...stylex.props(styles.viewport, mode === "comment" && styles.commenting)}
      >
        <div ref={worldRef} {...stylex.props(styles.world)}>
          <div ref={framesRef} />
          {outlines.map(
            ({ key, rect, flash }) =>
              rect && (
                <div
                  key={key}
                  data-outline={flash ? "flash" : "target"}
                  {...stylex.props(
                    styles.outline(rect.x, rect.y, rect.width, rect.height),
                    flash && styles.flash,
                  )}
                />
              ),
          )}
          {sessionRef.current && page && (
            <CommentLayer
              replica={sessionRef.current.replica}
              page={page.id}
              comments={comments}
              openId={openId}
              draft={draft}
              working={working}
              onOpen={(commentId) => {
                setDraft(null);
                setOpenId(commentId);
              }}
              onPost={postComment}
              onCancelDraft={() => setDraft(null)}
              onReply={reply}
              onResolve={resolve}
              onEdit={editMessage}
              onDelete={deleteComment}
              onShowChange={(nodeIds) => setFlash([...nodeIds])}
            />
          )}
        </div>
      </div>

      <header {...stylex.props(styles.bar, styles.top)}>
        <Link href="/" {...stylex.props(styles.link)}>
          ← Designs
        </Link>
        <span {...stylex.props(styles.name)}>{meta?.name ?? "…"}</span>
        <span {...stylex.props(styles.muted)} title="Pass this to agents as designId">
          <code {...stylex.props(styles.code)}>{id}</code>
        </span>
        <span {...stylex.props(styles.spacer)} />
        <button
          type="button"
          aria-pressed={panel === "css"}
          onClick={() => togglePanel("css")}
          {...stylex.props(styles.tool)}
          title="CSS every artboard uses"
        >
          Shared CSS
        </button>
        <button
          type="button"
          aria-pressed={panel === "comments"}
          onClick={() => togglePanel("comments")}
          {...stylex.props(styles.tool)}
          title="Every comment, open and resolved"
        >
          Comments{openCount > 0 && <span {...stylex.props(styles.count)}>{openCount}</span>}
        </button>
        <ImportButton
          busy={imported?.status === "working"}
          onFile={(file) => void importFile(file)}
        />
        <button
          type="button"
          aria-pressed={panel === "export"}
          onClick={() => togglePanel("export")}
          {...stylex.props(styles.tool)}
          title="Download an artboard or the whole design"
        >
          Export
        </button>
        {presence.map((p) => (
          <span key={p.actor} {...stylex.props(styles.chip)} title={p.status ?? undefined}>
            {p.name}
          </span>
        ))}
        <span
          {...stylex.props(styles.dot, status === "open" ? styles.online : styles.offline)}
          title={status === "open" ? "Live" : "Reconnecting…"}
        />
      </header>

      {pages.length > 0 && page && (
        <PagesSidebar pages={pages} current={page.id} onSelect={showPage} />
      )}

      {meta && session.artboardCount > 0 && page?.artboardCount === 0 && (
        <div {...stylex.props(styles.empty)}>
          <p {...stylex.props(styles.emptyTitle)}>No artboards on this page</p>
          <p {...stylex.props(styles.muted)}>Ask an agent to add some, or pick another page.</p>
        </div>
      )}

      {meta && session.artboardCount === 0 && (
        <div {...stylex.props(styles.empty)}>
          <p {...stylex.props(styles.emptyTitle)}>No artboards yet</p>
          <p {...stylex.props(styles.muted)}>
            Connect an agent to <code {...stylex.props(styles.code)}>{mcpUrl()}</code> and ask it to
            design something in <code {...stylex.props(styles.code)}>{id}</code>.
          </p>
        </div>
      )}

      {activity.length > 0 && (
        <ol aria-label="Recent changes" {...stylex.props(styles.bar, styles.activity)}>
          {activity.map((a) => (
            <li key={a.seq} {...stylex.props(styles.activityItem)}>
              <span {...stylex.props(styles.actor)}>{a.actor}</span> {a.label}{" "}
              <span {...stylex.props(styles.muted)}>{timeAgo(a.at)}</span>
            </li>
          ))}
        </ol>
      )}

      {panel === "css" && (
        <SharedCssPanel css={session.css} onSave={saveCss} onClose={() => setPanel(null)} />
      )}
      {panel === "comments" && sessionRef.current && (
        <CommentsPanel
          replica={sessionRef.current.replica}
          comments={comments}
          working={working}
          openId={openId}
          onSelect={showComment}
          onClose={() => setPanel(null)}
        />
      )}

      {panel === "export" && sessionRef.current && (
        <ExportMenu
          designId={id}
          artboards={sessionRef.current.replica
            .artboards()
            .map((board) => ({ id: board.id, name: board.name ?? "Artboard" }))}
          onClose={() => setPanel(null)}
        />
      )}
      {panel === "import" && imported && (
        <ImportResultCard
          designId={id}
          state={imported}
          nameOf={(nodeId) => sessionRef.current?.replica.get(nodeId)?.name ?? undefined}
          onClose={() => setPanel(null)}
        />
      )}

      <ToolPill mode={mode} onMode={setMode} />

      <div {...stylex.props(styles.bar, styles.zoom)}>
        <button
          type="button"
          onClick={() => cameraRef.current?.zoomBy(0.8)}
          {...stylex.props(styles.tool)}
          aria-label="Zoom out"
        >
          −
        </button>
        <button
          type="button"
          onClick={() => cameraRef.current?.set({ ...cameraRef.current.view, zoom: 1 })}
          {...stylex.props(styles.tool, styles.percent)}
          title="Zoom to 100% (0)"
        >
          {Math.round(zoom * 100)}%
        </button>
        <button
          type="button"
          onClick={() => cameraRef.current?.zoomBy(1.25)}
          {...stylex.props(styles.tool)}
          aria-label="Zoom in"
        >
          +
        </button>
        <button
          type="button"
          onClick={fitAll}
          {...stylex.props(styles.tool)}
          title="Zoom to fit (Shift+1)"
        >
          Fit
        </button>
      </div>
    </main>
  );
}

const styles = stylex.create({
  page: {
    position: "fixed",
    inset: 0,
    overflow: "hidden",
    backgroundColor: colors.canvas,
    color: colors.text,
    fontFamily: "ui-sans-serif, system-ui, sans-serif",
    fontSize: 13,
  },
  viewport: {
    position: "absolute",
    inset: 0,
    overflow: "hidden",
    cursor: "var(--cursor-grab, grab)",
    touchAction: "none",
    userSelect: "none",
  },
  // The draft pin, with its tail tip as the hotspot.
  commenting: { cursor: "var(--cursor-comment, crosshair)" },
  world: {
    position: "absolute",
    left: 0,
    top: 0,
    transformOrigin: "0 0",
  },
  outline: (x: number, y: number, width: number, height: number) => ({
    position: "absolute",
    left: x,
    top: y,
    width,
    height,
    outline: `calc(1.5px * var(--inv-zoom, 1)) solid ${colors.ink}`,
    boxShadow: `0 0 0 calc(3px * var(--inv-zoom, 1)) ${colors.halo}`,
    pointerEvents: "none",
  }),
  flash: {
    backgroundColor: "rgba(21, 128, 61, 0.12)",
    outlineColor: colors.ok,
    outlineWidth: "calc(2px * var(--inv-zoom, 1))",
  },
  bar: {
    position: "absolute",
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    padding: space.xs,
    paddingInline: space.sm,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  top: {
    top: space.sm,
    left: space.sm,
    right: space.sm,
  },
  spacer: { flexGrow: 1 },
  link: {
    color: colors.muted,
    textDecoration: { default: "none", ":hover": "underline" },
  },
  name: { fontWeight: 500 },
  muted: { margin: 0, color: colors.muted },
  code: {
    fontFamily: "ui-monospace, monospace",
    fontSize: 12,
    userSelect: "all",
  },
  chip: {
    paddingInline: 6,
    paddingBlock: 1,
    borderRadius: 4,
    backgroundColor: colors.accent,
    color: colors.onAccent,
    fontSize: 12,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: "50%",
  },
  online: { backgroundColor: colors.ok },
  offline: { backgroundColor: colors.danger },
  empty: {
    position: "absolute",
    top: "50%",
    left: "50%",
    transform: "translate(-50%, -50%)",
    maxWidth: 420,
    textAlign: "center",
    pointerEvents: "none",
  },
  emptyTitle: {
    margin: 0,
    marginBottom: space.xs,
    fontSize: 15,
    fontWeight: 500,
  },
  activity: {
    left: space.sm,
    bottom: space.sm,
    flexDirection: "column",
    alignItems: "flex-start",
    gap: 2,
    margin: 0,
    maxWidth: 360,
    listStyle: "none",
  },
  activityItem: {
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    maxWidth: "100%",
  },
  actor: { fontWeight: 500 },
  zoom: {
    right: space.sm,
    bottom: space.sm,
    gap: 2,
  },
  tool: {
    minWidth: 28,
    height: 24,
    paddingInline: 6,
    borderWidth: 0,
    borderRadius: 4,
    backgroundColor: { default: "transparent", ":hover": colors.bg },
    color: "inherit",
    font: "inherit",
    cursor: "var(--cursor-pointer, pointer)",
  },
  count: {
    marginLeft: 6,
    color: colors.muted,
    fontVariantNumeric: "tabular-nums",
  },
  percent: {
    minWidth: 48,
    fontVariantNumeric: "tabular-nums",
  },
  notFound: {
    minHeight: "100vh",
    display: "grid",
    placeContent: "center",
    gap: space.sm,
    textAlign: "center",
    backgroundColor: colors.bg,
    color: colors.text,
    fontFamily: "ui-sans-serif, system-ui, sans-serif",
  },
});
