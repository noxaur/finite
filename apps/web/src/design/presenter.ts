import type { Camera, View } from "./camera";
import type { Bounds, Renderer } from "./renderer";

/** How long the camera takes to zoom onto an artboard, or back out. */
export const ENTER_MS = 450;
/** How long it takes to fly from one artboard to another. */
export const STEP_MS = 350;
/** Space left around the artboard, in screen pixels. */
const PADDING = 32;
/**
 * A board is tall when fitting it whole would shrink it below this share of
 * the zoom that fits its width. Then it fits by width and scrolls instead.
 */
const TALL = 0.75;

/**
 * The view that shows `board` in `free` (viewport coordinates), at most at
 * 100%. A tall board fits by width, its top at the top of `free`, with the
 * height of the window it scrolls inside, in its own CSS pixels.
 */
export function presentationOf(board: Bounds, free: Bounds): { view: View; window: number | null } {
  const width = Math.max(free.width - PADDING * 2, 1);
  const height = Math.max(free.height - PADDING * 2, 1);
  const byWidth = Math.min(1, width / Math.max(board.width, 1));
  const whole = Math.min(byWidth, height / Math.max(board.height, 1));
  if (whole < byWidth * TALL) {
    const zoom = byWidth;
    return {
      view: {
        zoom,
        x: free.x + (free.width - board.width * zoom) / 2 - board.x * zoom,
        y: free.y + PADDING - board.y * zoom,
      },
      window: Math.floor(height / zoom),
    };
  }
  const zoom = whole;
  return {
    view: {
      zoom,
      x: free.x + (free.width - board.width * zoom) / 2 - board.x * zoom,
      y: free.y + (free.height - board.height * zoom) / 2 - board.y * zoom,
    },
    window: null,
  };
}

export type Phase = "idle" | "entering" | "active" | "exiting";

export interface PresenterState {
  readonly phase: Phase;
  /** The artboard shown, or `null` on the canvas. */
  readonly board: string | null;
  /** Where Back goes, most recent last. */
  readonly history: ReadonlyArray<string>;
  /** The artboards ←/→ step through, in order. */
  readonly boards: ReadonlyArray<string>;
}

export interface PresenterHost {
  readonly camera: Camera;
  readonly renderer: Renderer;
  /** The part of the viewport no app chrome covers, in viewport coordinates. */
  freeRect(): Bounds;
  /** Where the viewport's corner is in the window. Hiding the chrome around it moves it. */
  origin(): { readonly x: number; readonly y: number };
  /** Resolves once the app has laid out a change of state, like the chrome hiding. */
  layout(): Promise<void>;
  /** The shown page's artboards in reading order, for stepping without a playlist. */
  pageBoards(): ReadonlyArray<string>;
  /** Shows `id`'s page, if it's on another. False when there's no such artboard. */
  reveal(id: string): boolean;
  /** The page shown. */
  page(): string;
  /** Shows a page again. False when it's gone. */
  showPage(id: string): boolean;
}

const idle: PresenterState = { phase: "idle", board: null, history: [], boards: [] };

/**
 * Interactive mode: one artboard, zoomed onto on the canvas itself, running
 * as a real page. Entering springs the camera onto it and wakes it once the
 * camera lands; leaving goes back to the exact view it started from. Every
 * transition takes a new turn, so a newer one (pressing P again, stepping,
 * Escape) cancels an older one before it can wake the wrong artboard.
 */
export class Presenter {
  private current: PresenterState = idle;
  private readonly listeners = new Set<() => void>();
  /** The view to go back to, and its page, saved once when it starts. */
  private returnView: View | null = null;
  private returnPage: string | null = null;
  /** The viewport's corner when it started, since the view is relative to it. */
  private returnOrigin = { x: 0, y: 0 };
  /** The selection it started with, if it was several artboards. */
  private playlist: ReadonlyArray<string> | null = null;
  private turn = 0;

  constructor(private readonly host: PresenterHost) {}

  get state(): PresenterState {
    return this.current;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Zooms onto `board`. With `playlist` (several selected artboards), ←/→ step only through those. */
  enter(board: string, playlist: ReadonlyArray<string> | null = null) {
    const page = this.host.page();
    if (!this.host.reveal(board)) return;
    if (this.current.phase === "idle") {
      this.returnView = this.host.camera.view;
      this.returnOrigin = this.host.origin();
      // The page it started on, before revealing the artboard switched it.
      this.returnPage = page;
      this.playlist = playlist && playlist.length > 1 ? playlist : null;
    }
    this.host.camera.locked = () => this.exit();
    void this.show(board, this.current.phase === "idle" ? ENTER_MS : STEP_MS, []);
  }

  /** Steps to the next (`1`) or previous (`-1`) artboard. */
  step(by: 1 | -1) {
    const { board } = this.current;
    if (!board || this.current.phase === "exiting") return;
    const boards = this.boards();
    const index = boards.indexOf(board);
    const next = boards[(index + by + boards.length) % boards.length];
    if (next && next !== board) void this.show(next, STEP_MS, this.current.history);
  }

  /** Follows a link to artboard `target`. False when there's no such artboard. */
  goto(target: string): boolean {
    const { board } = this.current;
    if (!board || this.current.phase === "exiting") return false;
    if (target === board) return true;
    if (!this.host.reveal(target)) return false;
    void this.show(target, STEP_MS, [...this.current.history, board]);
    return true;
  }

  /** Flies back to where the last link was followed from. */
  back() {
    const history = [...this.current.history];
    let previous = history.pop();
    while (previous !== undefined && !this.host.reveal(previous)) previous = history.pop();
    if (previous !== undefined && this.current.board) void this.show(previous, STEP_MS, history);
  }

  /** Goes back to the canvas, to the view it started from. */
  async exit() {
    const { board, phase } = this.current;
    if (!board || phase === "exiting" || phase === "idle") return;
    const turn = ++this.turn;
    this.host.renderer.setPresenting(null);
    this.host.renderer.setWindow(board, null);
    this.update({ phase: "exiting" });
    // A link may have gone to another page. The view belongs to the page it
    // started on; if that page is gone, the view would frame nothing.
    const page = this.returnPage;
    const home = page === null || page === this.host.page() || this.host.showPage(page);
    // The viewport moves back when the chrome shows again, and the app pans
    // to keep the canvas still, so land where that leaves the starting view.
    const now = this.host.origin();
    const back =
      home && this.returnView
        ? {
            ...this.returnView,
            x: this.returnView.x + this.returnOrigin.x - now.x,
            y: this.returnView.y + this.returnOrigin.y - now.y,
          }
        : null;
    if (back) await this.host.camera.animateTo(back, ENTER_MS);
    if (turn !== this.turn) return;
    this.host.camera.locked = null;
    this.returnView = null;
    this.returnPage = null;
    this.playlist = null;
    this.update(idle);
  }

  /** Fits the shown artboard again, after the window or the chrome around it changed. */
  refit() {
    const { board, phase } = this.current;
    if (!board || phase !== "active") return;
    const at = this.presentation(board);
    if (!at) return;
    this.host.renderer.setWindow(board, at.window);
    this.host.camera.set(at.view);
  }

  private boards(): ReadonlyArray<string> {
    const shown = new Set(this.host.pageBoards());
    const list = this.playlist?.filter((id) => shown.has(id));
    return list && list.length > 1 ? list : [...shown];
  }

  private presentation(board: string) {
    const bounds = this.host.renderer.artboardBounds().get(board);
    return bounds ? presentationOf(bounds, this.host.freeRect()) : null;
  }

  private async show(board: string, durationMs: number, history: ReadonlyArray<string>) {
    const turn = ++this.turn;
    const renderer = this.host.renderer;
    const before = this.current.board;
    const starting = this.current.phase === "idle";
    renderer.setPresenting(null);
    if (before && before !== board) renderer.setWindow(before, null);
    // Starting hides the chrome around the canvas, which resizes it: fit what it leaves.
    if (starting) {
      this.update({ phase: "entering", board, history, boards: this.boards() });
      await this.host.layout();
      if (turn !== this.turn) return;
    }
    // The full size, before any window, decides the fit.
    renderer.setWindow(board, null);
    const at = this.presentation(board);
    if (!at) {
      if (starting) void this.exit();
      return;
    }
    renderer.setWindow(board, at.window);
    this.update({ phase: "entering", board, history, boards: this.boards() });
    const landed = await this.host.camera.animateTo(at.view, durationMs);
    if (turn !== this.turn) return;
    if (!landed) this.host.camera.set(at.view);
    renderer.setPresenting(board);
    this.update({ phase: "active", boards: this.boards() });
  }

  private update(patch: Partial<PresenterState>) {
    this.current = { ...this.current, ...patch };
    for (const listener of this.listeners) listener();
  }
}
