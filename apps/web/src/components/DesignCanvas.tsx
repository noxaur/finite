"use client";

import * as stylex from "@stylexjs/stylex";
import { Cause, Exit } from "effect";
import Link from "next/link";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Api, Refused } from "@/api/Api";
import { Camera, union, type View } from "@/design/camera";
import { Editor } from "@/design/editing/editor";
import { LayerModel } from "@/design/editing/layers";
import { pixelSize } from "@/design/html";
import { Presenter, type PresenterState } from "@/design/presenter";
import { type FrameKey, type Hit, Renderer } from "@/design/renderer";
import { Replica } from "@/design/replica";
import type { Audience } from "@/design/schema";
import { knownAgents } from "@/lib/audience";
import { DesignSession, initialSessionState, type SessionState } from "@/design/session";
import { loadDesignModel } from "@/design/wasm";
import { mcpUrl } from "@/lib/mcp";
import { formatOf } from "@/lib/transfer";
import { loadPlace, savePlace } from "@/lib/place";
import { loadSidebarsOpen, saveSidebarsOpen } from "@/lib/sidebars";
import { pageStorage } from "@/lib/pageStorage";
import { closeTab, tabsStore } from "@/lib/tabs";
import { localUser } from "@/lib/user";
import { runtime } from "@/runtime";
import { hideMode } from "@/styles/hideMode";
import { colors, fonts, radii, shadows, size, space } from "@/styles/tokens.stylex";
import {
  CommentLayer,
  type Draft,
  type Mode,
  pinPosition,
  selectionOf,
  toggleInDraft,
} from "./Comments";
import { buttonStyle } from "./Button";
import { CommentsPanel } from "./CommentsPanel";
import { Icon } from "./Icons";
import { Inspector } from "./inspector/Inspector";
import { pageCanvasColor } from "./inspector/PagePanel";
import { LayersTree } from "./LayersTree";
import { type LeftMode, LeftSidebar } from "./LeftSidebar";
import { ToolRail } from "./ToolRail";
import { UserAvatar } from "./UserAvatar";
import { EditorNotice, SelectionLayer } from "./SelectionLayer";
import { type TokensActions, TokensPanel } from "./TokensPanel";
import { InteractivePill } from "./InteractivePill";
import { TabBar } from "./TabBar";
import { ExportMenu, ImportResultCard, type ImportState } from "./Transfer";

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
/** A press that moves farther than this is a drag, not a click. */
const CLICK_SLOP = 4;
/** How long "Updated by …" stays in interactive mode's pill. */
const UPDATED_MS = 1800;
/** How long the sidebars take to slide back in: `hideMode.panel`'s 280ms. */
const SIDEBARS_IN_MS = 280;
/** How long a notice, like a link to a missing artboard, stays up. */
const NOTICE_MS = 2400;

/** Whether a key event is typing into a field, in a shadow-root artboard too. */
const isTyping = (e: Event) => {
  const target = e.composedPath()[0] ?? e.target;
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
};

/** The artboards a selection is in, once each, in selection order. */
function boardsOf(replica: Replica, selection: ReadonlyArray<string>): string[] {
  const boards: string[] = [];
  for (const id of selection) {
    const board = replica.artboardOf(id)?.id;
    if (board && !boards.includes(board)) boards.push(board);
  }
  return boards;
}

/**
 * The part of the viewport no app chrome covers, in viewport coordinates:
 * chrome along an edge (sidebars, panels, the pill) takes that edge.
 */
function freeRect(viewport: HTMLElement): { x: number; y: number; width: number; height: number } {
  const box = viewport.getBoundingClientRect();
  let [left, top, right, bottom] = [box.left, box.top, box.right, box.bottom];
  const near = 24;
  for (const el of document.querySelectorAll("[data-canvas-chrome]")) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const tall = r.height > r.width;
    if (tall && r.left - box.left < near) left = Math.max(left, r.right);
    else if (tall && box.right - r.right < near) right = Math.min(right, r.left);
    else if (r.top - box.top < near) top = Math.max(top, r.bottom);
    else if (box.bottom - r.bottom < near) bottom = Math.min(bottom, r.top);
  }
  return {
    x: left - box.left,
    y: top - box.top,
    width: Math.max(right - left, 1),
    height: Math.max(bottom - top, 1),
  };
}

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
  /** Where the last press started, and the artboard interactive mode showed then. */
  const pressRef = useRef<{ x: number; y: number; shown: string | null } | null>(null);
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
  const layersRef = useRef<LayerModel | null>(null);
  const presenterRef = useRef<Presenter | null>(null);

  // Re-rendering on every session update also moves pins with their artboards.
  const [session, setSession] = useState<SessionState>(initialSessionState);
  const { meta, presence, listening, activity, comments, working, pages } = session;
  // The zoom percentage, written by the camera so zooming doesn't re-render the canvas.
  const zoomLabelRef = useRef<HTMLSpanElement>(null);
  // In hide mode the avatar lands just left of the zoom, which is as wide as its label.
  const avatarRef = useRef<HTMLSpanElement>(null);
  const zoomGroupRef = useRef<HTMLDivElement>(null);
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
  // The export menu and an import's result open in the same place, one at a time.
  const [panel, setPanel] = useState<"export" | "import" | null>(null);
  // The left sidebar's pages and layers, or its tokens.
  const [leftMode, setLeftMode] = useState<LeftMode>("design");
  // Whether both sidebars are shown; without them the canvas is in hide mode,
  // with a few small panels floating over it. `instant` skips the slide: on
  // load, and for ⌘\, which people press too often to wait for.
  const [sidebars, setSidebars] = useState({ open: true, instant: true });
  const leftOpen = sidebars.open;
  const setLeftOpen = (open: boolean, instant = false) => {
    setSidebars({ open, instant });
    saveSidebarsOpen(open);
  };
  // Read once mounted, before the first paint: the server has no storage,
  // and its HTML shows the sidebars.
  useLayoutEffect(() => {
    if (!loadSidebarsOpen()) setSidebars({ open: false, instant: true });
  }, []);
  // For ⌘\, whose listener is set up once.
  const toggleSidebars = useRef(() => {});
  toggleSidebars.current = () => setLeftOpen(!leftOpen, true);
  // The canvas runs under the sidebars' columns in hide mode, and while they
  // slide back in over it, so nothing on it is cut off before they arrive.
  const [wide, setWide] = useState(false);
  useLayoutEffect(() => {
    if (!leftOpen) setWide(true);
    else if (sidebars.instant) setWide(false);
    else {
      const timer = setTimeout(() => setWide(false), SIDEBARS_IN_MS);
      return () => clearTimeout(timer);
    }
  }, [leftOpen, sidebars.instant]);
  const [imported, setImported] = useState<ImportState | null>(null);
  // Interactive mode: the artboard zoomed onto, running as a page.
  const [presented, setPresented] = useState<PresenterState | null>(null);
  const presenting = presented !== null && presented.phase !== "idle" ? presented.board : null;
  // Held down in interactive mode, C shows the pins and places comments.
  const [commentHold, setCommentHold] = useState(false);
  // What's selected, for which artboard P opens.
  const [selection, setSelection] = useState<ReadonlyArray<string>>([]);
  // The artboard last used with the Interact tool.
  const lastUsedRef = useRef<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [updated, setUpdated] = useState<{ board: string; text: string } | null>(null);
  // The tool in effect: interactive mode's own, or comments while C is held.
  const tool: Mode = commentHold ? "comment" : presenting ? "interact" : mode;
  // Read by listeners set up once, which outlive this render.
  const live = useRef({ mode, tool, presenting, commentHold });
  live.current = { mode, tool, presenting, commentHold };
  const actions = useRef<{
    enter: () => void;
    enterOn: (boardId: string) => void;
    /** Handles a key, from the app or forwarded from a page. Returns whether it was used. */
    key: (key: FrameKey, typing: boolean) => boolean;
  }>({ enter: () => {}, enterOn: () => {}, key: () => false });

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
      onPreview: (boardId) => actions.current.enterOn(boardId),
      // A page's own wheel never moves a locked camera.
      onWheel: (event) => !camera.locked && camera.wheel(event),
      storage: pageStorage(id),
      onGoto: (from, link) => {
        // A route's artboard at the width closest to this one's: a link
        // drawn on the desktop cart opens the mobile cart from mobile.
        const board = replica.get(from);
        const target = (board && replica.flowTarget(link, pixelSize(board).width)) ?? link;
        const presenter = presenterRef.current;
        if (presenter && live.current.presenting === from) {
          if (!presenter.goto(target)) setNotice("That link goes to an artboard that isn’t there.");
          return;
        }
        // With the Interact tool, a link flies the camera to its artboard.
        const bounds = renderer.artboardBounds().get(target);
        if (!bounds) setNotice("That link goes to an artboard that isn’t on this page.");
        else {
          const v = camera.view;
          void camera.animateTo(
            {
              ...v,
              x: viewport.clientWidth / 2 - (bounds.x + bounds.width / 2) * v.zoom,
              y: viewport.clientHeight / 2 - (bounds.y + bounds.height / 2) * v.zoom,
            },
            350,
          );
        }
      },
      onFrameKey: (_boardId, key) => {
        actions.current.key(key, false);
      },
      onFramePan: () => {
        if (live.current.presenting) void presenterRef.current?.exit();
      },
      onFrameBlur: () => {
        setCommentHold(false);
        camera.space = false;
        renderer.setPanning(false);
      },
      onUsed: (boardId) => {
        if (lastUsedRef.current === boardId) return;
        lastUsedRef.current = boardId;
        // P and the play buttons may open a different artboard now.
        setTick((t) => t + 1);
      },
      onUpdated: (boardId, actor, held) => {
        if (boardId !== live.current.presenting) return;
        const by = actor ? `Updated by ${actor}` : "Updated";
        setUpdated({ board: boardId, text: held ? `${by}. Let go to see it` : by });
      },
      onNetwork: () => setTick((t) => t + 1),
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
    const layers = new LayerModel(replica);
    layersRef.current = layers;
    const unwatchDoc = session.subscribeDoc((change) => layers.apply(change));
    rendererRef.current = renderer;
    cameraRef.current = camera;
    const unwatchSelection = editor.subscribe(() => setSelection(editor.state.selection));
    const presenter = new Presenter({
      camera,
      renderer,
      freeRect: () => freeRect(viewport),
      origin: () => {
        const { left, top } = viewport.getBoundingClientRect();
        return { x: left, y: top };
      },
      // React commits the chrome hiding before the next frame; the second one has its layout.
      layout: () =>
        new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))),
      pageBoards: () => {
        const page = renderer.shownPage();
        return replica
          .artboards()
          .filter((board) => replica.pageOf(board) === page)
          .sort((a, b) => (a.y ?? 0) - (b.y ?? 0) || (a.x ?? 0) - (b.x ?? 0))
          .map((board) => board.id);
      },
      reveal: (boardId) => {
        const board = replica.get(boardId);
        if (!board || board.parent !== null) return false;
        const pageId = replica.pageOf(board);
        if (pageId !== renderer.shownPage()) {
          pickPage(pageId);
          renderer.setPage(pageId);
        }
        return true;
      },
      page: () => renderer.shownPage(),
      showPage: (pageId) => {
        if (!replica.pages.some((p) => p.id === pageId)) return false;
        pickPage(pageId);
        renderer.setPage(pageId);
        return true;
      },
    });
    presenterRef.current = presenter;
    const unwatchPresenter = presenter.subscribe(() => {
      setPresented(presenter.state);
      // While it runs, the view isn't the person's: don't save it or frame over it.
      if (presenter.state.phase !== "idle") framedRef.current = RESTORED;
    });
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
      if (presenter.state.phase !== "idle") return;
      if (viewedPageRef.current) viewsRef.current[viewedPageRef.current] = view;
      rememberPlace.current();
    });
    // A reload can come before the timer fires.
    window.addEventListener("pagehide", savePlaceNow);
    const resize = new ResizeObserver(() => {
      renderer.setViewport(camera.visibleWorld());
      presenter.refit();
    });
    resize.observe(viewport);
    // The play buttons follow what P would open, which changes with the selection.
    const refocus = () => setTick((t) => t + 1);
    refocusRef.current = refocus;
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

    // Space hands every press to the camera, over pages too.
    const setSpace = (held: boolean) => {
      camera.space = held;
      renderer.setPanning(held);
    };
    /**
     * Keys pressed in the app or forwarded from inside a page. Returns
     * whether one was used. In interactive mode Escape leaves, the arrows
     * step, ⌘[ goes back, R restarts, P leaves, and holding C comments.
     */
    actions.current.key = ({ key, phase, meta, repeat }, typing) => {
      const { presenting: shown } = live.current;
      if (key === " ") {
        if (!typing) setSpace(phase === "down");
        return false;
      }
      if (phase === "up") {
        if (key === "c" || key === "C") setCommentHold(false);
        return false;
      }
      if (shown) {
        if (key === "Escape") {
          // Close a comment first, then leave.
          if (popupRef.current) {
            setDraft(null);
            setOpenId(null);
          } else void presenter.exit();
        } else if (typing) return false;
        else if (meta && key === "[") presenter.back();
        else if (meta) return false;
        else if (key === "ArrowLeft") presenter.step(-1);
        else if (key === "ArrowRight") presenter.step(1);
        else if (key === "c" || key === "C") {
          if (!repeat) setCommentHold(true);
        } else if (key === "p" || key === "P") void presenter.exit();
        else if (key === "r" || key === "R") presenter.restart();
        else return false;
        return true;
      }
      // ⌘\ (Ctrl+\) hides the sidebars or brings them back.
      if (meta && !typing && key === "\\") {
        toggleSidebars.current();
        return true;
      }
      if (typing || meta) {
        if (key === "Escape") {
          setDraft(null);
          setOpenId(null);
        }
        return false;
      }
      if (key === "v" || key === "V") setMode("pointer");
      else if (key === "i" || key === "I") setMode("interact");
      else if (key === "c" || key === "C") setMode("comment");
      else if (key === "p" || key === "P") actions.current.enter();
      else if (key === "Escape") {
        // Close the draft or thread first, then go back to the pointer.
        if (!popupRef.current) setMode("pointer");
        setDraft(null);
        setOpenId(null);
      } else return false;
      return true;
    };
    const onKey = (e: KeyboardEvent) => {
      const key: FrameKey = {
        key: e.key,
        phase: "down",
        meta: e.metaKey || e.ctrlKey || e.altKey,
        repeat: e.repeat,
      };
      if (e.key === " " && !isTyping(e)) e.preventDefault();
      if (actions.current.key(key, isTyping(e))) {
        e.preventDefault();
        return;
      }
      if (live.current.presenting || isTyping(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "!" || (e.shiftKey && e.code === "Digit1"))
        camera.fitTo(union(renderer.artboardBounds().values()));
      else if (e.key === "0") camera.set({ ...camera.view, zoom: 1 });
      else if (e.key === "=" || e.key === "+") camera.zoomBy(1.25);
      else if (e.key === "-") camera.zoomBy(0.8);
      else return;
      e.preventDefault();
    };
    const onKeyUp = (e: KeyboardEvent) => {
      actions.current.key({ key: e.key, phase: "up", meta: false, repeat: false }, isTyping(e));
    };
    const onBlur = () => {
      setSpace(false);
      setCommentHold(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);

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
      unwatchDoc();
      layersRef.current = null;
      camera.dispose();
      renderer.dispose();
      // The document lives in WebAssembly memory, which isn't garbage collected.
      replica.free();
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      unwatchSelection();
      unwatchPresenter();
      presenterRef.current = null;
      clearInterval(ticker);
      cancelAnimationFrame(hoverFrame.current);
      cancelAnimationFrame(partFrame.current);
      frames.replaceChildren();
    };
  }, [id, model]);

  // In comment mode the left button places comments instead of panning.
  // With the Interact tool a press on a page is the page's, and a wheel over
  // something that scrolls in it scrolls it.
  useEffect(() => {
    const camera = cameraRef.current;
    const renderer = rendererRef.current;
    const commenting = tool === "comment";
    if (camera && renderer) {
      camera.dragToPan = !commenting;
      camera.mayPan = (e) => tool !== "interact" || renderer.boardOf(e) === null;
      camera.routeWheel = (e) => {
        if (tool === "interact" && renderer.scrollsPage(e)) return "native";
        // Interactive mode's camera is locked, so this does nothing there.
        return "camera";
      };
    }
    // Pages stay inert while the camera flies in or out; the presenter
    // wakes the one it lands on.
    const flying = presenting !== null && presented?.phase !== "active";
    renderer?.setTool(flying && tool !== "comment" ? "pointer" : tool);
    // Holding C in interactive mode keeps a comment being written when it's let go.
    if (!commenting && !presenting) {
      setDraft(null);
      setHover(null);
    }
  }, [tool, presenting, presented?.phase]);

  // A deleted design's tab goes with it.
  useEffect(() => {
    if (missing) tabsStore.update((tabs) => closeTab(tabs, id, null).state);
  }, [missing, id]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    if (!updated) return;
    const timer = setTimeout(() => setUpdated(null), UPDATED_MS);
    return () => clearTimeout(timer);
  }, [updated]);

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
    if (tool === "comment" && pointer && (!draft || pointer.shift)) hoverAt(pointer.x, pointer.y);
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
    else if (!presenting) partFrame.current = requestAnimationFrame(() => partAt(x, y));
    if (tool !== "comment") return;
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
    // A click on the canvas around the page leaves interactive mode. A link
    // in the page has already flown to another artboard by now, so compare
    // with the one shown when the press started. Enter on a link clicks it
    // with no press at all.
    if (presenting && tool !== "comment" && !draft && !openId) {
      if (press && rendererRef.current?.boardOf(e.nativeEvent) !== press.shown) {
        void presenterRef.current?.exit();
      }
      return;
    }
    // Shift-click adds an element in the draft's artboard, or takes it out.
    // Only on a sure answer: a stale one could take out the wrong element.
    if (tool === "comment" && draft?.nodeId && e.shiftKey) {
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
    if (tool !== "comment" || !camera || !replica) return;
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

  const postComment = async (body: string) => {
    if (!draft) return undefined;
    // Leave out elements an agent deleted or moved away while the person typed.
    const replica = sessionRef.current?.replica;
    const [nodeId = null, ...extraNodeIds] = selectionOf(draft).filter(
      (node) => replica?.artboardOf(node)?.id === draft.artboardId,
    );
    const pin = { ...draft, nodeId, extraNodeIds };
    const exit = await runtime.runPromiseExit(
      Api.use((api) => api.createComment(id, { author: localUser(), body, ...pin })),
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

  /** Adds a page and shows it; it shows before the server answers. */
  const addPage = () => {
    const session = sessionRef.current;
    if (!session || !editorRef.current) return;
    const before = new Set(session.replica.pages.map((p) => p.id));
    const name = `Page ${session.replica.pages.length + 1}`;
    void editorRef.current.commit([{ kind: "createPage", name }]);
    const added = session.replica.pages.find((p) => !before.has(p.id));
    if (added) showPage(added.id);
  };

  const pageActions = {
    add: addPage,
    rename: (pageId: string, name: string) =>
      void editorRef.current?.commit([{ kind: "renamePage", id: pageId, name }]),
    remove: (pageId: string) =>
      void editorRef.current?.commit([{ kind: "deletePage", id: pageId }]),
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
  // Import and Export lost their buttons in the tab bar; the logic and the
  // panels stay here until they get a new home.
  void importFile;

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
    ...(tool === "comment" && !openComment && hover ? [hover.nodeId] : []),
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

  // What P and the play buttons open: the selected artboard (several
  // selected: the first, stepping through them all), or the one last used
  // with the Interact tool.
  const replica = sessionRef.current?.replica;
  const selectedBoards = replica ? boardsOf(replica, selection) : [];
  const targetNow = () => {
    const used = lastUsedRef.current;
    const board = used ? replica?.get(used) : undefined;
    const usedHere = board && replica?.pageOf(board) === page?.id ? used : null;
    return selectedBoards[0] ?? usedHere;
  };
  const target = targetNow();
  actions.current.enter = () => {
    // Read now: a page used a moment ago may not have re-rendered this yet.
    const board = targetNow();
    if (board) presenterRef.current?.enter(board, selectedBoards);
  };
  actions.current.enterOn = (boardId) => presenterRef.current?.enter(boardId, selectedBoards);
  useEffect(() => {
    rendererRef.current?.setFocused(presenting ? null : target);
  }, [target, presenting]);
  // An artboard deleted while it's shown leaves interactive mode.
  useEffect(() => {
    if (presenting && !sessionRef.current?.replica.get(presenting)) {
      void presenterRef.current?.exit();
    }
  }, [presenting, session.version]);
  // People edit the canvas only with the pointer, and not in interactive
  // mode, whose arrow keys and Escape would move or deselect what's selected.
  useEffect(() => {
    editorRef.current?.setEnabled(mode === "pointer" && presenting === null);
  }, [mode, presenting]);

  const renameDesign = (name: string) => {
    // The new name comes back over the socket, to every viewer.
    void runtime.runPromiseExit(Api.use((api) => api.renameDesign(id, name)));
  };

  // From Layers: center the canvas on a layer.
  /** The page whose row in the sidebar is under a page point. */
  const pageAt = (x: number, y: number) =>
    document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-page-id]")?.dataset.pageId ?? null;

  const revealNode = (nodeId: string) => {
    const rect = canvasRect(nodeId);
    if (rect) cameraRef.current?.centerOn(rect.x + rect.width / 2, rect.y + rect.height / 2);
  };

  // Hiding or showing the chrome around the canvas moves its corner: pan by
  // as much the other way, so the artboards stay where they are on screen.
  const cornerRef = useRef<{ x: number; y: number } | null>(null);
  useLayoutEffect(() => {
    const box = viewportRef.current?.getBoundingClientRect();
    const camera = cameraRef.current;
    const was = cornerRef.current;
    if (!box) return;
    if (camera && was && (box.left !== was.x || box.top !== was.y)) {
      const v = camera.view;
      camera.set({ ...v, x: v.x - (box.left - was.x), y: v.y - (box.top - was.y) });
    }
    cornerRef.current = { x: box.left, y: box.top };
  }, [wide, presenting]);
  // The zoom's width, on the avatar itself, for where it lands in hide mode.
  useLayoutEffect(() => {
    const group = zoomGroupRef.current;
    const avatar = avatarRef.current;
    if (!group || !avatar) return;
    // Its exact width, fractions too: `offsetWidth` rounds, and the avatar would land off by them.
    const measure = () =>
      avatar.style.setProperty("--zoom-width", `${group.getBoundingClientRect().width}px`);
    measure();
    const resize = new ResizeObserver(measure);
    resize.observe(group);
    return () => resize.disconnect();
  }, [presenting]);

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
    <main {...stylex.props(styles.page, presenting !== null && styles.presenting)}>
      <TabBar
        current={id}
        currentName={meta?.name}
        working={presence}
        sidebar={{ open: leftOpen, onToggle: () => setLeftOpen(!leftOpen) }}
        hidden={presenting !== null}
      >
        {presence.map((p) => (
          <span key={p.actor} {...stylex.props(styles.chip)} title={p.status ?? undefined}>
            <span aria-hidden {...stylex.props(styles.chipDot)} />
            {p.name}
          </span>
        ))}
      </TabBar>

      {!presenting && (
        <LeftSidebar
          inert={!leftOpen}
          style={[
            styles.overCanvas,
            styles.overRail,
            hideMode.panel,
            !leftOpen && hideMode.panelHidden,
            !leftOpen && hideMode.offLeft,
            sidebars.instant && hideMode.instant,
          ]}
          name={meta?.name ?? null}
          onRename={renameDesign}
          mode={leftMode}
          onMode={setLeftMode}
          pages={pages}
          page={page?.id ?? null}
          onPage={showPage}
          pageActions={pageActions}
          layers={(query, onDropPage) =>
            editorRef.current &&
            layersRef.current &&
            replica &&
            page && (
              <LayersTree
                model={layersRef.current}
                replica={replica}
                editor={editorRef.current}
                page={page.id}
                query={query}
                onReveal={revealNode}
                onPageAt={pageAt}
                onDropPage={onDropPage}
              />
            )
          }
          tokens={
            replica && (
              <TokensPanel
                table={session.tokens}
                artboards={replica
                  .artboards()
                  .filter((board) => replica.pageOf(board) === page?.id)}
                modeOf={(board) => replica.modeOf(board)}
                actions={tokenActions}
              />
            )
          }
        />
      )}

      {!presenting && (
        <ToolRail mode={mode} onMode={setMode} hidden={!leftOpen} instant={sidebars.instant} />
      )}

      <div
        {...stylex.props(
          styles.cell,
          wide && !presenting && styles.cellWide,
          page?.background !== undefined &&
            styles.pageColor(pageCanvasColor(page.background, session.tokens)),
        )}
      >
        <div
          ref={viewportRef}
          onPointerDown={(e) => {
            pressRef.current = { x: e.clientX, y: e.clientY, shown: presenting };
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
          {...stylex.props(
            styles.viewport,
            tool === "comment" && styles.commenting,
            tool === "interact" && styles.interacting,
          )}
        >
          <div ref={worldRef} {...stylex.props(styles.world)}>
            <div ref={framesRef} />
            {!presenting && editorRef.current && rendererRef.current && cameraRef.current && (
              <SelectionLayer
                editor={editorRef.current}
                session={sessionRef.current!}
                renderer={rendererRef.current}
                camera={cameraRef.current}
              />
            )}
            {(!presenting || tool === "comment") &&
              outlines.map(
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
              !presenting &&
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
            {sessionRef.current && page && (!presenting || commentHold || draft || openId) && (
              <CommentLayer
                replica={sessionRef.current.replica}
                page={page.id}
                comments={comments}
                openId={openId}
                draft={draft}
                working={working}
                agents={knownAgents(comments, presence, listening)}
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
              Connect an agent to <code {...stylex.props(styles.code)}>{mcpUrl()}</code> and ask it
              to design something in <code {...stylex.props(styles.code)}>{id}</code>.
            </p>
          </div>
        )}

        {panel === "export" && replica && (
          <ExportMenu
            designId={id}
            artboards={replica
              .artboards()
              .map((board) => ({ id: board.id, name: board.name ?? "Artboard" }))}
            onClose={() => setPanel(null)}
          />
        )}
        {panel === "import" && imported && (
          <ImportResultCard
            designId={id}
            state={imported}
            nameOf={(nodeId) => replica?.get(nodeId)?.name ?? undefined}
            onClose={() => setPanel(null)}
          />
        )}

        {editorRef.current && <EditorNotice editor={editorRef.current} />}

        {presented && presenting && replica && (
          <InteractivePill
            name={replica.get(presenting)?.name ?? "Artboard"}
            index={presented.boards.indexOf(presenting)}
            total={presented.boards.length}
            canGoBack={presented.history.length > 0}
            canRestart={presented.start !== presenting || presented.history.length > 0}
            broken={replica.flow().broken.filter((b) => b.from === presenting).length}
            held={rendererRef.current?.isHeld(presenting) ?? false}
            note={notice ?? (updated?.board === presenting ? updated.text : null)}
            hosts={rendererRef.current?.hostsOf(presenting) ?? []}
            presence={presence}
            onStep={(by) => presenterRef.current?.step(by)}
            onBack={() => presenterRef.current?.back()}
            onRestart={() => presenterRef.current?.restart()}
            onReload={() => rendererRef.current?.reload(presenting)}
            onHold={() => {
              const renderer = rendererRef.current;
              renderer?.hold(presenting, !renderer.isHeld(presenting));
              setTick((t) => t + 1);
            }}
            onExit={() => void presenterRef.current?.exit()}
          />
        )}
        {notice && !presenting && <p {...stylex.props(styles.bar, styles.notice)}>{notice}</p>}
      </div>

      {!presenting && (
        <aside
          data-camera-ignore
          aria-label="Properties"
          {...stylex.props(styles.right, styles.overCanvas, !leftOpen && styles.rightHidden)}
        >
          <span
            aria-hidden
            {...stylex.props(
              styles.rightFace,
              hideMode.panel,
              !leftOpen && hideMode.panelHidden,
              !leftOpen && hideMode.offRight,
              sidebars.instant && hideMode.instant,
            )}
          />
          {/* In hide mode the avatar and the zoom stay, and travel into the top right
              corner, where a small panel's face fades in around them. */}
          <div {...stylex.props(styles.zoomRow)}>
            <span
              ref={avatarRef}
              {...stylex.props(
                styles.avatar,
                hideMode.travel,
                hideMode.dip,
                !leftOpen && hideMode.travelHidden,
                !leftOpen && hideMode.dipHidden,
                !leftOpen && styles.avatarHidden,
                sidebars.instant && hideMode.instant,
              )}
            >
              <UserAvatar />
            </span>
            <div
              ref={zoomGroupRef}
              {...stylex.props(
                styles.zoomGroup,
                hideMode.travel,
                hideMode.dip,
                !leftOpen && hideMode.travelHidden,
                !leftOpen && hideMode.dipHidden,
                !leftOpen && styles.zoomGroupHidden,
                sidebars.instant && hideMode.instant,
              )}
            >
              <span
                aria-hidden
                {...stylex.props(
                  styles.cornerFace,
                  hideMode.face,
                  !leftOpen && hideMode.faceShown,
                  sidebars.instant && hideMode.instant,
                )}
              />
              <button
                type="button"
                onClick={() => cameraRef.current?.set({ ...cameraRef.current.view, zoom: 1 })}
                title="Zoom to 100% (0)"
                {...stylex.props(...buttonStyle({ variant: "ghost", size: "small" }), styles.zoom)}
              >
                {/* The camera writes the percentage into this span itself. */}
                <span ref={zoomLabelRef} />
                <Icon name="chevronDown" size={12} />
              </button>
            </div>
          </div>
          <div
            inert={!leftOpen}
            {...stylex.props(
              styles.rightBody,
              hideMode.panel,
              !leftOpen && hideMode.panelHidden,
              !leftOpen && hideMode.offRight,
              sidebars.instant && hideMode.instant,
            )}
          >
            {tool === "comment" && replica ? (
              <CommentsPanel
                replica={replica}
                comments={comments}
                working={working}
                openId={openId}
                activity={activity}
                onSelect={showComment}
              />
            ) : (
              editorRef.current &&
              rendererRef.current &&
              replica && (
                <Inspector
                  editor={editorRef.current}
                  session={sessionRef.current!}
                  renderer={rendererRef.current}
                  replica={replica}
                  tokens={session.tokens}
                />
              )
            )}
          </div>
        </aside>
      )}
    </main>
  );
}

const styles = stylex.create({
  page: {
    position: "fixed",
    inset: 0,
    display: "grid",
    gridTemplateColumns: `${size.left} ${size.rail} minmax(0, 1fr) ${size.right}`,
    gridTemplateRows: `${size.bar} minmax(0, 1fr)`,
    gridTemplateAreas: '"bar bar bar bar" "left rail canvas right"',
    overflow: "hidden",
    backgroundColor: colors.canvas,
    color: colors.text,
    fontFamily: fonts.sans,
    fontSize: 13,
  },
  // Interactive mode gives the page the whole window.
  presenting: {
    gridTemplateColumns: "minmax(0, 1fr)",
    gridTemplateRows: "minmax(0, 1fr)",
    gridTemplateAreas: '"canvas"',
  },
  cell: {
    gridArea: "canvas",
    position: "relative",
    minWidth: 0,
    minHeight: 0,
    overflow: "hidden",
  },
  // A page's own canvas color, over the theme's `colors.canvas` behind it.
  pageColor: (color: string) => ({ backgroundColor: color }),
  // Hide mode, and while the sidebars slide back: the canvas runs under their columns.
  cellWide: { gridArea: "2 / 1 / 3 / 5" },
  // The sidebars and the rail lie over the canvas while it runs under them.
  overCanvas: { position: "relative", zIndex: 2 },
  // The left sidebar's menus open over the rail.
  overRail: { zIndex: 3 },
  // The aside stays put in hide mode: its face and body slide off, its header stays.
  right: {
    gridArea: "right",
    display: "flex",
    flexDirection: "column",
    minHeight: 0,
    overflow: "hidden",
  },
  // In hide mode only the corner's panel takes clicks; the canvas has the rest.
  rightHidden: { pointerEvents: "none" },
  // The sidebar's own background, under its content: the aside is a stacking
  // context (`overCanvas`), and this sits at its bottom.
  rightFace: {
    position: "absolute",
    inset: 0,
    zIndex: -1,
    backgroundColor: colors.surface,
    borderLeftWidth: 1,
    borderLeftStyle: "solid",
    borderLeftColor: colors.border,
    pointerEvents: "none",
  },
  // What the sidebar shows scrolls; the zoom row above it stays put.
  rightBody: {
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    minHeight: 0,
    overflowY: "auto",
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: colors.border,
  },
  // The sidebar's header: who's signed in on the left, the zoom on the right.
  zoomRow: {
    position: "relative",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    flexShrink: 0,
    height: size.lg,
    paddingLeft: space.ms,
    // The zoom's group has 3px of its own, for the corner panel.
    paddingRight: `calc(${space.ms} - ${space.xs})`,
  },
  // Over the corner panel's face, which reaches under it in hide mode.
  avatar: {
    position: "relative",
    zIndex: 1,
    display: "flex",
    pointerEvents: "auto",
  },
  /**
   * Into the corner panel's left end, 9px in, where its 21px corners wrap the
   * 24px circle evenly: across the sidebar but for its 9px, the panel's 9px
   * inset, its own 24px with the 9px before it, and the zoom; and 9px down,
   * as the 42px panel sits 9px from the top where the 42px row held it. It
   * ends left of the zoom, so it never passes over it.
   */
  avatarHidden: {
    transform: `translate(calc(${size.right} - 2 * ${space.ms} - ${size.xs} - var(--zoom-width, 0px)), ${space.ms})`,
  },
  // The zoom, with 9px above and below it and 3px either side: the corner panel's right end.
  zoomGroup: {
    position: "relative",
    zIndex: 0,
    display: "flex",
    paddingBlock: space.ms,
    paddingInline: space.xs,
    pointerEvents: "auto",
  },
  // 9px in from the corner each way, where the row had it 6px from the right and at the top.
  zoomGroupHidden: { transform: `translate(calc(-1 * ${space.xs}), ${space.ms})` },
  /**
   * The corner panel, 42px tall: the avatar 9px in at its left end and the zoom
   * 3px in at its right, so the chevron ends 12px from the edge. A pill, whose
   * 21px ends are the avatar's 12px radius and the 9px around it.
   */
  cornerFace: {
    position: "absolute",
    top: 0,
    bottom: 0,
    left: `calc(-1 * (${size.xs} + ${space.ms}))`,
    right: 0,
    zIndex: -1,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    borderRadius: `calc(${size.lg} / 2)`,
    backgroundColor: colors.surface,
    boxShadow: shadows.raised,
    pointerEvents: "none",
  },
  // A small ghost button, with the percentage in figures that don't shift as it changes.
  zoom: {
    fontFamily: fonts.mono,
    fontVariantNumeric: "tabular-nums",
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
  // Pages show their own cursors; the canvas around them shows the arrow.
  interacting: { cursor: "default" },
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
    marginBottom: 3,
    paddingInline: 6,
    paddingBlock: 1,
    borderRadius: 4,
    backgroundColor: colors.component,
    color: colors.onComponent,
    fontSize: 11,
    lineHeight: 1.4,
    whiteSpace: "nowrap",
    transform: "scale(var(--inv-zoom, 1))",
    transformOrigin: "bottom left",
  },
  flash: {
    backgroundColor: `color-mix(in srgb, ${colors.ok} 12%, transparent)`,
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
    borderRadius: radii.md,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: colors.surface,
    boxShadow: shadows.raised,
  },
  link: {
    color: colors.muted,
    textDecoration: { default: "none", ":hover": "underline" },
  },
  muted: { margin: 0, color: colors.muted },
  code: {
    fontFamily: fonts.mono,
    fontSize: 12,
    userSelect: "all",
  },
  /**
   * An agent on the design: a quiet neutral chip, a small button's height, with the
   * brand cyan only in its dot, which says it's here now.
   */
  chip: {
    display: "inline-flex",
    alignItems: "center",
    gap: space.sm,
    flexShrink: 0,
    height: size.xs,
    paddingInline: space.sm,
    borderRadius: radii.sm,
    backgroundColor: colors.activeFill,
    color: colors.text,
    fontSize: 12,
    fontWeight: 500,
    lineHeight: "15px",
    whiteSpace: "nowrap",
  },
  chipDot: {
    flexShrink: 0,
    width: 6,
    height: 6,
    borderRadius: "50%",
    backgroundColor: colors.brand,
  },
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
  count: {
    marginLeft: 6,
    color: colors.muted,
    fontVariantNumeric: "tabular-nums",
  },
  notice: {
    left: "50%",
    bottom: 63,
    transform: "translateX(-50%)",
    margin: 0,
  },
  notFound: {
    minHeight: "100vh",
    display: "grid",
    placeContent: "center",
    gap: space.sm,
    textAlign: "center",
    backgroundColor: colors.bg,
    color: colors.text,
    fontFamily: fonts.sans,
  },
});
