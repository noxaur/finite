"use client";

import * as stylex from "@stylexjs/stylex";
import { Cause, Exit } from "effect";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Api, Refused } from "@/api/Api";
import { Camera, mostVisible, union, type View } from "@/design/camera";
import { Editor } from "@/design/editing/editor";
import { type Hit, Renderer } from "@/design/renderer";
import { Replica } from "@/design/replica";
import type { Audience } from "@/design/schema";
import { knownAgents } from "@/lib/audience";
import { DesignSession, initialSessionState, type SessionState } from "@/design/session";
import { loadDesignModel } from "@/design/wasm";
import { mcpUrl } from "@/lib/mcp";
import { formatOf } from "@/lib/transfer";
import { loadPlace, savePlace } from "@/lib/place";
import { localUser } from "@/lib/user";
import { timeAgo } from "@/lib/time";
import { runtime } from "@/runtime";
import { colors, radii, space } from "@/styles/tokens.stylex";
import {
  CommentLayer,
  type Draft,
  type Mode,
  pinPosition,
  selectionOf,
  ToolPill,
  toggleInDraft,
} from "./Comments";
import { CommentsPanel } from "./CommentsPanel";
import { Icon } from "./Icons";
import { PagesSidebar } from "./PagesSidebar";
import { Inspector } from "./Inspector";
import { EditorNotice, SelectionLayer } from "./SelectionLayer";
import { type TokensActions, TokensPanel } from "./TokensPanel";
import { Preview } from "./Preview";
import { ExportMenu, ImportButton, ImportResultCard, type ImportState } from "./Transfer";

/** An instance or component under the pointer: what to outline and what to call it. */
interface Part {
  /** The instance's root, or the component's. */
  readonly id: string;
  readonly label: string;
}

/** The instance `nodeId` is shown in, or the component it belongs to, if any. */
function partOf(replica: Replica, nodeId: string): Part | null {
  const info = replica.componentInfo(nodeId);
  if (!info) return null;
  const name = info.componentName ?? "a missing component";
  if (info.instance) return { id: info.instance, label: `Instance of ${name}` };
  if (!info.component) return null;
  const count = `${info.instances} instance${info.instances === 1 ? "" : "s"}`;
  return { id: info.component, label: `Component ${name} · ${count}` };
}

/**
 * Stands in for a framing when the view came from a saved place. It never
 * equals the camera's view, so nothing reframes over the restored one.
 */
const RESTORED: View = { x: NaN, y: NaN, zoom: NaN };

/** How long the view rests before it's saved. */
const SAVE_PLACE_MS = 300;

/** How long "show what changed" outlines stay up. */
const FLASH_MS = 1800;
/** How long the view rests before the focused artboard is worked out again. */
const FOCUS_DELAY_MS = 100;
/** A press that moves farther than this is a drag, not a click. */
const CLICK_SLOP = 4;

const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;

/**
 * A live view of one design. `DesignSession` streams it from the server and
 * the renderer patches the DOM; this component adds the camera, comments and
 * keyboard shortcuts. With the pointer, people edit the design through the
 * `Editor`; in comment mode they pin comments that agents pick up over MCP,
 * and they can edit the design's tokens, which every artboard uses.
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
  const pointerRef = useRef<{ x: number; y: number; shift: boolean } | null>(null);
  const refreshHover = useRef(() => {});
  const refocusRef = useRef(() => {});
  const cameraRef = useRef<Camera | null>(null);
  // The view the camera framed the artboards with, until the person moves it.
  const framedRef = useRef<View | null>(null);
  const rendererRef = useRef<Renderer | null>(null);
  const sessionRef = useRef<DesignSession | null>(null);
  const editorRef = useRef<Editor | null>(null);

  // Re-rendering on every session update also moves pins with their artboards.
  const [session, setSession] = useState<SessionState>(initialSessionState);
  const { meta, presence, status, activity, comments, working, pages } = session;
  // The zoom percentage, written by the camera so zooming doesn't re-render the canvas.
  const zoomLabelRef = useRef<HTMLButtonElement>(null);
  const [missing, setMissing] = useState(false);
  const model = useDesignModel();
  const [, setTick] = useState(0);
  const [mode, setMode] = useState<Mode>("pointer");
  const [openId, setOpenId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [hover, setHover] = useState<Hit | null>(null);
  // The instance or component under the pointer, in either mode.
  const [part, setPart] = useState<Part | null>(null);
  const partFrame = useRef(0);
  const [flash, setFlash] = useState<ReadonlyArray<string>>([]);
  // The page picked in the sidebar, or `null` for the first. A page that's
  // gone shows the first page, as the renderer does.
  const [pickedPage, setPickedPage] = useState<string | null>(null);
  // The last view of each page, by page id, so going back to a page shows it as it was left.
  const viewsRef = useRef<Record<string, View>>({});
  // The page whose view the camera holds, or `null` before it holds one.
  const viewedPageRef = useRef<string | null>(null);
  const rememberPlace = useRef(() => {});
  const pickPage = (pageId: string) => {
    setPickedPage(pageId);
    viewedPageRef.current = pageId;
    rememberPlace.current();
  };
  const page = pages.find((p) => p.id === pickedPage) ?? pages[0];
  // The tokens, the comments list, the export menu and an import's result open in the
  // same place, one at a time.
  const [panel, setPanel] = useState<"tokens" | "comments" | "export" | "import" | null>(null);
  const togglePanel = (name: "tokens" | "comments" | "export") =>
    setPanel((open) => (open === name ? null : name));
  const [imported, setImported] = useState<ImportState | null>(null);
  // The artboard that fills most of the viewport, which the play buttons preview.
  const [focused, setFocused] = useState<string | null>(null);
  // The artboard shown in preview mode, or `null` on the canvas.
  const [previewId, setPreviewId] = useState<string | null>(null);
  const previewRef = useRef(false);

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
    // Open where this browser last was in the design, or frame the artboards.
    const saved = loadPlace(id);
    viewsRef.current = { ...saved?.views };
    const savedView = saved?.page ? saved.views[saved.page] : undefined;
    if (savedView) camera.set(savedView);
    framedRef.current = savedView ? RESTORED : null;
    viewedPageRef.current = savedView ? (saved?.page ?? null) : null;
    const renderer = new Renderer(frames, replica, {
      live: true,
      toPage: (x, y) => camera.toPage(x, y),
      onPreview: setPreviewId,
      onWheel: (event) => camera.wheel(event),
      // An auto-height artboard with a script is measured inside its iframe,
      // so its real height arrives after the first frame. Frame it again,
      // unless the person has already panned or zoomed.
      onResize: () => {
        // Outlines on the artboard follow its new size.
        setTick((t) => t + 1);
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
    const session = new DesignSession(renderer, replica, Date.now, localUser);
    sessionRef.current = session;
    const editor = new Editor(viewport, session, renderer, () => camera.view.zoom);
    editorRef.current = editor;
    rendererRef.current = renderer;
    cameraRef.current = camera;
    // Hide the artboards outside the view.
    camera.subscribe(() => renderer.setViewport(camera.visibleWorld()));
    const showZoom = (view: View) => {
      if (zoomLabelRef.current)
        zoomLabelRef.current.textContent = `${Math.round(view.zoom * 100)}%`;
    };
    camera.subscribe(showZoom);
    showZoom(camera.view);
    let saveTimer: ReturnType<typeof setTimeout> | undefined;
    const savePlaceNow = () => {
      clearTimeout(saveTimer);
      // Until the document loads, the views are the saved ones and there's nothing to prune.
      if (replica.pages.length === 0) return;
      // Forget pages that were deleted, so the saved views don't pile up.
      const views: Record<string, View> = {};
      for (const { id: pageId } of replica.pages) {
        const view = viewsRef.current[pageId];
        if (view) views[pageId] = view;
      }
      savePlace(id, { page: renderer.shownPage(), views });
    };
    rememberPlace.current = () => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(savePlaceNow, SAVE_PLACE_MS);
    };
    camera.subscribe((view) => {
      if (viewedPageRef.current) viewsRef.current[viewedPageRef.current] = view;
      rememberPlace.current();
    });
    // A reload can come before the timer fires.
    window.addEventListener("pagehide", savePlaceNow);
    const resize = new ResizeObserver(() => renderer.setViewport(camera.visibleWorld()));
    resize.observe(viewport);
    let focusTimer: ReturnType<typeof setTimeout> | undefined;
    const refocus = () => {
      clearTimeout(focusTimer);
      focusTimer = setTimeout(() => {
        const next = mostVisible(renderer.artboardBounds(), camera.visibleWorld(0));
        renderer.setFocused(next);
        setFocused(next);
      }, FOCUS_DELAY_MS);
    };
    refocusRef.current = refocus;
    camera.subscribe(refocus);
    // A new renderer starts on the saved page, or the first.
    renderer.setPage(saved?.page ?? null);
    setPickedPage(saved?.page ?? null);

    // Frame the artboards once, when the first ones appear.
    const unsubscribe = session.subscribe(() => {
      setSession(session.state);
      // The camera holds no page's view yet, or the page it held was deleted
      // and the renderer moved to the first: show that page as it was left,
      // or frame it.
      const shown = replica.pages.length > 0 ? renderer.shownPage() : null;
      if (shown && shown !== viewedPageRef.current) {
        viewedPageRef.current = shown;
        const seen = viewsRef.current[shown];
        if (seen) camera.set(seen);
        framedRef.current = seen ? RESTORED : null;
      }
      refocus();
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
      // Preview mode handles its own keys.
      if (previewRef.current) return;
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
    window.addEventListener("resize", refocus);

    // Keeps "2 minutes ago" labels fresh.
    const ticker = setInterval(() => setTick((t) => t + 1), 15_000);

    return () => {
      savePlaceNow();
      window.removeEventListener("pagehide", savePlaceNow);
      rememberPlace.current = () => {};
      unsubscribe();
      close();
      controller.abort();
      resize.disconnect();
      editor.dispose();
      editorRef.current = null;
      camera.dispose();
      renderer.dispose();
      // The document lives in WebAssembly memory, which isn't garbage collected.
      replica.free();
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", refocus);
      clearInterval(ticker);
      clearTimeout(focusTimer);
      cancelAnimationFrame(hoverFrame.current);
      cancelAnimationFrame(partFrame.current);
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
    if (mode === "comment" && pointer && (!draft || pointer.shift)) hoverAt(pointer.x, pointer.y);
  };

  // Names the component part under the pointer: people can't tell from the
  // design which parts follow a component, and agents edit them differently.
  const partAt = (clientX: number, clientY: number) => {
    const hit = rendererRef.current?.hitTest(clientX, clientY) ?? null;
    const replica = sessionRef.current?.replica;
    const next = hit && replica ? partOf(replica, hit.nodeId) : null;
    setPart((prev) => (prev?.id === next?.id && prev?.label === next?.label ? prev : next));
  };

  const onCanvasPointerMove = (e: React.PointerEvent) => {
    const { clientX: x, clientY: y } = e;
    cancelAnimationFrame(partFrame.current);
    // Not while dragging to pan.
    if (pressRef.current) setPart(null);
    else partFrame.current = requestAnimationFrame(() => partAt(x, y));
    if (mode !== "comment") return;
    const { clientX, clientY, shiftKey } = e;
    pointerRef.current = { x: clientX, y: clientY, shift: shiftKey };
    // With a draft open, outline only what a shift-click would add.
    if (draft && !shiftKey) {
      setHover(null);
      return;
    }
    cancelAnimationFrame(hoverFrame.current);
    hoverFrame.current = requestAnimationFrame(() => hoverAt(clientX, clientY));
  };

  const onCanvasClick = (e: React.MouseEvent) => {
    const press = pressRef.current;
    pressRef.current = null;
    const moved = press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > CLICK_SLOP;
    if (moved || (e.target instanceof Element && e.target.closest("[data-camera-ignore]"))) return;
    // Shift-click adds an element in the draft's artboard, or takes it out.
    // Only on a sure answer: a stale one could take out the wrong element.
    if (mode === "comment" && draft?.nodeId && e.shiftKey) {
      const hit = rendererRef.current?.hitTest(e.clientX, e.clientY, true) ?? null;
      if (hit?.artboardId === draft.artboardId) setDraft(toggleInDraft(draft, hit.nodeId));
      return;
    }
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
            extraNodeIds: [],
            x: point.x - (board.x ?? 0),
            y: point.y - (board.y ?? 0),
          }
        : { artboardId: null, nodeId: null, extraNodeIds: [], ...point },
    );
  };

  const postComment = async (body: string, audience: Audience) => {
    if (!draft) return undefined;
    // Leave out elements an agent deleted or moved away while the person typed.
    const replica = sessionRef.current?.replica;
    const [nodeId = null, ...extraNodeIds] = selectionOf(draft).filter(
      (node) => replica?.artboardOf(node)?.id === draft.artboardId,
    );
    const pin = { ...draft, nodeId, extraNodeIds };
    const exit = await runtime.runPromiseExit(
      Api.use((api) => api.createComment(id, { author: localUser(), body, audience, ...pin })),
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

  /** Shows the artboards on one page, as it was last seen, or framed in the viewport. */
  const showPage = (pageId: string) => {
    pickPage(pageId);
    const renderer = rendererRef.current;
    if (!renderer) return;
    renderer.setPage(pageId);
    setDraft(null);
    setOpenId(null);
    setHover(null);
    // An empty page moves neither the camera nor the session.
    refocusRef.current();
    const seen = viewsRef.current[pageId];
    if (seen) {
      cameraRef.current?.set(seen);
      framedRef.current = RESTORED;
      return;
    }
    const bounds = union(renderer.artboardBounds().values());
    if (bounds) cameraRef.current?.fitTo(bounds);
    // So auto-height artboards reframe it as they grow, and an empty page
    // frames its first artboard when one arrives.
    framedRef.current = bounds ? (cameraRef.current?.view ?? null) : null;
  };

  // From the comments list: open the thread and bring its pin into view,
  // on its artboard's page.
  const showComment = (commentId: string) => {
    const comment = comments.get(commentId);
    const replica = sessionRef.current?.replica;
    const board = comment?.artboardId ? replica?.get(comment.artboardId) : undefined;
    if (board?.parent === null && replica && replica.pageOf(board) !== page?.id) {
      pickPage(replica.pageOf(board));
      rendererRef.current?.setPage(replica.pageOf(board));
    }
    const at = comment && replica ? pinPosition(replica, comment) : null;
    if (at) cameraRef.current?.centerOn(at.x, at.y);
    setDraft(null);
    setOpenId(commentId);
  };

  const tokenActions: TokensActions = {
    save: async (change) => {
      const exit = await runtime.runPromiseExit(
        Api.use((api) => api.setTokens(id, localUser(), change)),
      );
      return Exit.isFailure(exit) ? unsent(exit.cause) : undefined;
    },
    deleteMode: async (modeId) => {
      const exit = await runtime.runPromiseExit(
        Api.use((api) => api.deleteMode(id, localUser(), modeId)),
      );
      return Exit.isFailure(exit) ? unsent(exit.cause) : undefined;
    },
    setArtboardMode: async (boardId, modeId) => {
      const exit = await runtime.runPromiseExit(
        Api.use((api) => api.setArtboardMode(id, localUser(), [boardId], modeId)),
      );
      return Exit.isFailure(exit) ? unsent(exit.cause) : undefined;
    },
  };

  // The new artboards arrive over the socket, so all this shows is how the import went.
  const importFile = async (file: File) => {
    const format = formatOf(file.name);
    if (!format) {
      setImported({
        status: "failed",
        message: "Pick an .html, .htm, .finite, .figma.json or .tar file.",
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

  const setAudience = (commentId: string, audience: Audience) => {
    void runtime
      .runPromiseExit(Api.use((api) => api.setCommentAudience(id, commentId, audience)))
      .then((exit) => {
        if (Exit.isSuccess(exit)) sessionRef.current?.upsertComment(exit.value);
      });
  };

  const resolve = (commentId: string, resolved: boolean) => {
    void runtime
      .runPromiseExit(Api.use((api) => api.setCommentResolved(id, commentId, resolved)))
      .then((exit) => {
        if (Exit.isSuccess(exit)) sessionRef.current?.upsertComment(exit.value);
      });
  };

  // Outline what a comment points at: the draft's elements, the open
  // thread's, and whatever is under the pointer in comment mode. Rects are
  // converted to canvas coordinates so they pan and zoom with the design.
  const openComment = openId ? comments.get(openId) : undefined;
  const targets = new Set([
    ...(draft ? selectionOf(draft) : openComment ? selectionOf(openComment) : []),
    ...(mode === "comment" && !openComment && hover ? [hover.nodeId] : []),
  ]);
  const canvasRect = (nodeId: string) => {
    const rect = rendererRef.current?.nodeRect(nodeId);
    const camera = cameraRef.current;
    if (!rect || !camera) return null;
    const a = camera.toWorld(rect.left, rect.top);
    const b = camera.toWorld(rect.right, rect.bottom);
    return { x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y };
  };
  const outlines = [
    ...[...targets].map((nodeId) => ({
      key: `target:${nodeId}`,
      rect: canvasRect(nodeId),
      flash: false,
    })),
    ...flash.map((nodeId) => ({ key: `flash:${nodeId}`, rect: canvasRect(nodeId), flash: true })),
  ];

  const openCount = [...comments.values()].filter((c) => !c.resolved).length;

  // Preview mode steps through the shown page's artboards in reading order.
  const replica = sessionRef.current?.replica;
  const pageBoards =
    replica && page
      ? replica
          .artboards()
          .filter((board) => replica.pageOf(board) === page.id)
          .sort((a, b) => (a.y ?? 0) - (b.y ?? 0) || (a.x ?? 0) - (b.x ?? 0))
          .map((board) => board.id)
      : [];
  // An artboard deleted or moved to another page while previewed closes the preview.
  const previewing = previewId !== null && pageBoards.includes(previewId) ? previewId : null;
  previewRef.current = previewing !== null;
  useEffect(() => {
    if (previewId !== null && previewing === null) setPreviewId(null);
  }, [previewId, previewing]);
  // People edit the canvas only in pointer mode, and not behind the preview,
  // whose arrow keys and Escape would move or deselect what's selected.
  useEffect(() => {
    editorRef.current?.setEnabled(mode !== "comment" && previewing === null);
  }, [mode, previewing]);

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
        // Keeps the draft's text box focused through a shift-click.
        onMouseDown={(e) => {
          const onCanvas = !(
            e.target instanceof Element && e.target.closest("[data-camera-ignore]")
          );
          if (draft && e.shiftKey && onCanvas) e.preventDefault();
        }}
        onPointerMove={onCanvasPointerMove}
        onPointerLeave={() => {
          setHover(null);
          setPart(null);
          cancelAnimationFrame(partFrame.current);
        }}
        onClick={onCanvasClick}
        {...stylex.props(styles.viewport, mode === "comment" && styles.commenting)}
      >
        <div ref={worldRef} {...stylex.props(styles.world)}>
          <div ref={framesRef} />
          {editorRef.current && rendererRef.current && cameraRef.current && (
            <SelectionLayer
              editor={editorRef.current}
              renderer={rendererRef.current}
              camera={cameraRef.current}
              version={session.version}
            />
          )}
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
          {part &&
            (() => {
              const rect = canvasRect(part.id);
              return (
                rect && (
                  <div
                    data-outline="component"
                    {...stylex.props(
                      styles.outline(rect.x, rect.y, rect.width, rect.height),
                      styles.part,
                    )}
                  >
                    <span {...stylex.props(styles.partLabel)}>{part.label}</span>
                  </div>
                )
              );
            })()}
          {sessionRef.current && page && (
            <CommentLayer
              replica={sessionRef.current.replica}
              page={page.id}
              comments={comments}
              openId={openId}
              draft={draft}
              working={working}
              agents={knownAgents(comments, presence)}
              onOpen={(commentId) => {
                setDraft(null);
                setOpenId(commentId);
              }}
              onPost={postComment}
              onCancelDraft={() => setDraft(null)}
              onReply={reply}
              onResolve={resolve}
              onAudience={setAudience}
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
          disabled={!focused}
          onClick={() => setPreviewId(focused)}
          {...stylex.props(styles.tool, styles.play)}
          title="Preview the artboard in view"
        >
          <Icon name="play" size={10} />
          Preview
        </button>
        <button
          type="button"
          aria-pressed={panel === "tokens"}
          onClick={() => togglePanel("tokens")}
          {...stylex.props(styles.tool)}
          title="CSS variables every artboard uses, in each mode"
        >
          Tokens
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

      {panel === "tokens" && sessionRef.current && (
        <TokensPanel
          table={session.tokens}
          artboards={sessionRef.current.replica
            .artboards()
            .filter((board) => sessionRef.current?.replica.pageOf(board) === page?.id)}
          modeOf={(board) => sessionRef.current?.replica.modeOf(board) ?? ""}
          actions={tokenActions}
          onClose={() => setPanel(null)}
        />
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
      {editorRef.current && <EditorNotice editor={editorRef.current} />}
      {editorRef.current && rendererRef.current && sessionRef.current && mode === "pointer" && (
        <Inspector
          editor={editorRef.current}
          renderer={rendererRef.current}
          replica={sessionRef.current.replica}
          version={session.version}
        />
      )}

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
          ref={zoomLabelRef}
          onClick={() => cameraRef.current?.set({ ...cameraRef.current.view, zoom: 1 })}
          {...stylex.props(styles.tool, styles.percent)}
          title="Zoom to 100% (0)"
        />
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

      {previewing && replica && (
        <Preview
          replica={replica}
          boards={pageBoards}
          current={previewing}
          version={session.version}
          onSelect={setPreviewId}
          onClose={() => setPreviewId(null)}
        />
      )}
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
  part: {
    outlineColor: colors.component,
    outlineStyle: "dashed",
  },
  partLabel: {
    position: "absolute",
    left: 0,
    bottom: "100%",
    marginBottom: 2,
    paddingInline: 6,
    paddingBlock: 1,
    borderRadius: 4,
    backgroundColor: colors.component,
    color: "white",
    fontSize: 11,
    lineHeight: 1.4,
    whiteSpace: "nowrap",
    transform: "scale(var(--inv-zoom, 1))",
    transformOrigin: "bottom left",
  },
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
  play: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    ":disabled": { color: colors.muted, cursor: "default" },
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
