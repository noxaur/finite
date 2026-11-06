import type {
  Canvas,
  CanvasPatch,
  CommentAnchor,
  Frame,
  Hit,
  HitElement,
  LayerNode,
  Loc,
  Rect,
  Rev,
  SourceEdit,
  TextLabel,
} from "@finite/protocol";
import { useSyncExternalStore } from "react";
import type { Camera } from "@/design/camera";
import { bridgeOf, mountedBridges } from "./bridge";
import { childrenIn, pathIn } from "./layers";
import { finite } from "@/client/finite";
import {
  baseName,
  chainOf,
  detachTarget,
  drillInto,
  fileOf,
  flowAxis,
  type Handle,
  movedFrames,
  type Point,
  reorderBefore,
  resizeEdit,
  resizedFrame,
  resizeStyles,
  revsOf,
} from "./gestures";
import {
  createStore,
  keyOf,
  remapSelection,
  type SelectionItem,
  selectionStore,
  type Store,
  toggleItem,
} from "./selection";

/** How far the pointer travels before a press becomes a drag, in screen pixels. */
const DRAG_SLOP = 3;
const NOTICE_MS = 5000;
/** How soon a second click makes a double-click, in milliseconds. */
const DOUBLE_MS = 400;

export type Tool = "select" | "comment";

/** What an element selection knows beyond its loc: what the edits it makes need. */
export type ElementFacts = { rev: Rev; tag: string; path: HitElement[] };

export type Notice = {
  text: string;
  /** Where it shows, in canvas units: under the selection. */
  at: Point;
  action?: { label: string; run: () => void };
};

export type TextEdit = {
  frameId: string;
  loc: Loc;
  index: number;
  rev: Rev;
  tag: string;
  /** The element's box in its frame, CSS pixels. */
  rect: Rect;
  text: string;
  font: Record<string, string>;
};

export interface EditorState {
  readonly tool: Tool;
  /** The pointer reaches into the frames, to click through the real app. */
  readonly interact: boolean;
  /** What's under the pointer: a frame (no loc) or an element's box in it. */
  readonly hover: { frameId: string; rect: Rect } | null;
  /** Each selected thing's box in its frame (CSS pixels); `null` until measured. */
  readonly rects: Readonly<Record<string, Rect | null>>;
  /** "Edits Button.tsx · used in 3 places", for one element from another file. */
  readonly label: string | null;
  readonly dragging: boolean;
  /** Frames shown somewhere else than the canvas says, while a gesture runs. */
  readonly frameOverrides: Readonly<Record<string, Rect>>;
  readonly textOverrides: Readonly<Record<string, Point>>;
  /** Where a reorder drops, in the frame's CSS pixels. */
  readonly dropLine: { frameId: string; rect: Rect } | null;
  readonly notice: Notice | null;
  readonly editingText: TextEdit | null;
  readonly selectedText: string | null;
  readonly editingLabel: string | null;
  /** A comment being written: its anchor and where its pin sits, in canvas units. */
  readonly commentDraft: { anchor: CommentAnchor; at: Point } | null;
  readonly openComment: string | null;
  /** Heights hug frames report, so their box follows their content. */
  readonly sizes: Readonly<Record<string, number>>;
  /** Counts frame loads and HMR updates, so what's measured in frames measures again. */
  readonly updates: number;
}

const initial: EditorState = {
  tool: "select",
  interact: false,
  hover: null,
  rects: {},
  label: null,
  dragging: false,
  frameOverrides: {},
  textOverrides: {},
  dropLine: null,
  notice: null,
  editingText: null,
  selectedText: null,
  editingLabel: null,
  commentDraft: null,
  openComment: null,
  sizes: {},
  updates: 0,
};

type Gesture = {
  move(screen: Point, world: Point, e: PointerEvent): void;
  end(commit: boolean): void | Promise<void>;
};

type Press = {
  pointerId: number;
  /** What was pressed: pointer capture retargets the release to the viewport. */
  target: Element | null;
  screen: Point;
  world: Point;
  started: boolean;
  /** Starts the drag, once it travels far enough. */
  begin: () => Promise<Gesture | null>;
  /** A click: the press came up where it went down. */
  click: () => void | Promise<void>;
  gesture: Promise<Gesture | null> | null;
};

const errorCode = (e: unknown) => (e as { code?: string } | null)?.code;
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Turns the pointer and keys on the canvas into selection, canvas patches and source edits. The
 * frames never get the pointer (unless Interact is on): every press is hit-tested through the
 * frame's bridge, gestures preview through the bridge while they run, and releasing sends one
 * `source.edit` or `canvas.patch`. Selection lives in `selectionStore`, so the layers, the
 * inspector, the composer and the ✱ menu all read the same one.
 */
export class CanvasEditor {
  readonly store: Store<EditorState> = createStore(initial);
  /** rev, tag and stamped ancestors of each selected element, by selection key. */
  private readonly facts = new Map<string, ElementFacts>();
  private canvas: Canvas;
  private press: Press | null = null;
  private lastClick: { at: number; x: number; y: number } | null = null;
  private space = false;
  private hoverFrame = 0;
  private hoverSeq = 0;
  private noticeTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly abort = new AbortController();
  private readonly offSelection: () => void;

  constructor(
    readonly designId: string,
    canvas: Canvas,
    readonly mode: "design" | "prototype",
    private readonly viewport: HTMLElement,
    readonly camera: Camera,
  ) {
    this.canvas = canvas;
    const signal = this.abort.signal;
    const capture = { capture: true, signal };
    viewport.addEventListener("pointerdown", (e) => this.onDown(e), capture);
    viewport.addEventListener("pointermove", (e) => this.onMove(e), capture);
    viewport.addEventListener("pointerup", (e) => void this.onUp(e), capture);
    viewport.addEventListener("pointercancel", () => this.cancelPress(), capture);
    viewport.addEventListener("pointerleave", () => this.setHover(null), { signal });
    window.addEventListener("keydown", (e) => this.onKey(e), { signal });
    window.addEventListener(
      "keyup",
      (e) => {
        if (e.code === "Space") this.space = camera.space = false;
      },
      { signal },
    );
    window.addEventListener("blur", () => (this.space = camera.space = false), { signal });
    // Left-drag pans only on the empty canvas; on frames it selects and edits.
    camera.mayPan = (e) => this.state.tool === "select" && this.frameAt(this.worldOf(e)) === null;
    this.offSelection = selectionStore.subscribe(() => void this.refreshSelection());
    void this.refreshSelection();
  }

  dispose() {
    this.abort.abort();
    this.offSelection();
    clearTimeout(this.noticeTimer);
    cancelAnimationFrame(this.hoverFrame);
  }

  get state() {
    return this.store.get();
  }

  private update(patch: Partial<EditorState>) {
    this.store.set({ ...this.state, ...patch });
  }

  /** The canvas changed on the server (or another person's edit arrived). */
  setCanvas(canvas: Canvas) {
    this.canvas = canvas;
    const ids = new Set(canvas.frames.map((f) => f.id));
    const kept = selectionStore.get().filter((s) => ids.has(s.frameId));
    if (kept.length !== selectionStore.get().length) selectionStore.set(kept);
    if (this.state.selectedText && !canvas.texts.some((t) => t.id === this.state.selectedText)) {
      this.update({ selectedText: null });
    }
    void this.refreshSelection();
  }

  get frames(): readonly Frame[] {
    return this.canvas.frames;
  }

  get texts(): readonly TextLabel[] {
    return this.canvas.texts;
  }

  /** A frame's box on the canvas as it's drawn now: dragged, resized, or hugging its content. */
  boxOf(frame: Frame): Rect {
    const o = this.state.frameOverrides[frame.id];
    if (o) return o;
    const hug = frame.hug ? this.state.sizes[frame.id] : undefined;
    return { x: frame.x, y: frame.y, width: frame.width, height: hug ?? frame.height };
  }

  frame(id: string): Frame | undefined {
    return this.canvas.frames.find((f) => f.id === id);
  }

  setTool(tool: Tool) {
    this.update({ tool, commentDraft: null, hover: null });
  }

  setInteract(interact: boolean) {
    this.update({ interact, hover: null });
  }

  /** A frame loaded or applied an HMR update: rects and revs may have moved. */
  frameChanged() {
    this.update({ updates: this.state.updates + 1 });
    void this.refreshSelection();
  }

  setSize(frameId: string, height: number) {
    if (this.state.sizes[frameId] === height) return;
    this.update({ sizes: { ...this.state.sizes, [frameId]: height } });
  }

  openComment(id: string | null) {
    this.update({ openComment: id, commentDraft: null });
  }

  cancelCommentDraft() {
    this.update({ commentDraft: null });
  }

  selectText(id: string | null) {
    if (id) selectionStore.set([]);
    this.update({ selectedText: id });
  }

  editLabel(id: string | null) {
    this.update({ editingLabel: id });
  }

  // Coordinates

  worldOf(e: { clientX: number; clientY: number }): Point {
    return this.camera.toWorld(e.clientX, e.clientY);
  }

  /** The topmost frame under a canvas point. */
  frameAt(p: Point): Frame | null {
    for (let i = this.canvas.frames.length - 1; i >= 0; i--) {
      const f = this.canvas.frames[i]!;
      const b = this.boxOf(f);
      if (p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height) return f;
    }
    return null;
  }

  private local(frame: Frame, p: Point): Point {
    const b = this.boxOf(frame);
    return { x: p.x - b.x, y: p.y - b.y };
  }

  // Selection

  private frameItem(frameId: string): SelectionItem {
    const name = this.frame(frameId)?.name;
    return name === undefined ? { frameId } : { frameId, name };
  }

  /** Selects one hit element, remembering what edits to it need. */
  private factsFor(item: SelectionItem, facts: ElementFacts) {
    this.facts.set(keyOf(item), facts);
  }

  private selectHit(frameId: string, hit: Hit | HitElement, index: number, path: HitElement[]) {
    const item = { frameId, loc: hit.loc, index, name: hit.tag };
    this.factsFor(item, { rev: hit.rev, tag: hit.tag, path });
    return item;
  }

  /** Measures what's selected again and fills in facts it doesn't have (from the layers panel, say). */
  async refreshSelection() {
    const items = selectionStore.get();
    const rects: Record<string, Rect | null> = {};
    await Promise.all(
      items.map(async (item) => {
        const key = keyOf(item);
        const frame = this.frame(item.frameId);
        if (!frame) return;
        if (item.loc === undefined) {
          const b = this.boxOf(frame);
          rects[key] = { x: 0, y: 0, width: b.width, height: b.height };
          return;
        }
        const bridge = bridgeOf(item.frameId);
        if (!bridge) return void (rects[key] = null);
        try {
          const [found, inspection] = await Promise.all([
            bridge.rects([item.loc]),
            bridge.inspect(item.loc, item.index ?? 0),
          ]);
          rects[key] = found[item.loc]?.[item.index ?? 0] ?? null;
          if (inspection) {
            const known = this.facts.get(key);
            const path =
              known?.path ??
              pathIn(await bridge.layers(), item.loc, item.index ?? 0) ??
              ([] as HitElement[]);
            this.facts.set(key, { rev: inspection.rev, tag: inspection.tag, path });
          }
        } catch {
          rects[key] = null;
        }
      }),
    );
    // A newer selection took over while this one measured.
    if (items !== selectionStore.get()) return;
    this.update({ rects, label: await this.labelFor(items) });
  }

  /** "Edits Button.tsx · used in 3 places" when one element comes from a file the frame doesn't own. */
  private async labelFor(items: readonly SelectionItem[]): Promise<string | null> {
    const [only] = items;
    if (items.length !== 1 || only?.loc === undefined) return null;
    const file = fileOf(only.loc);
    const frame = this.frame(only.frameId);
    const own = frame?.source.kind === "file" ? frame.source.file : this.routeFile?.(frame);
    if (own === file) return null;
    let count = 0;
    await Promise.all(
      [...mountedBridges().values()].map(async (b) => {
        const found = await b.rects([only.loc!]).catch(() => ({}) as Record<string, Rect[]>);
        count += found[only.loc!]?.length ?? 0;
      }),
    );
    const name = baseName(file);
    return count > 1 ? `Edits ${name} · used in ${count} places` : `Edits ${name}`;
  }

  /** Set by the canvas: the route module a route frame renders, when the router names one. */
  routeFile: ((frame: Frame | undefined) => string | undefined) | null = null;

  /** Moves to the selection's parent: an element's parent element, then its frame, then nothing. */
  selectParent() {
    const items = selectionStore.get();
    if (items.length === 0) return;
    const next: SelectionItem[] = [];
    for (const item of items) {
      if (item.loc === undefined) continue;
      const up = this.facts.get(keyOf(item))?.path[0];
      if (!up) next.push(this.frameItem(item.frameId));
      else {
        // Which instance of the parent: the same one as the child's, the common case.
        const parent = this.selectHit(
          item.frameId,
          up,
          0,
          this.facts.get(keyOf(item))!.path.slice(1),
        );
        next.push(parent);
      }
    }
    selectionStore.set(dedupe(next));
  }

  // Hover

  setHover(hover: EditorState["hover"]) {
    const h = this.state.hover;
    if (h === hover) return;
    if (
      h &&
      hover &&
      h.frameId === hover.frameId &&
      h.rect.x === hover.rect.x &&
      h.rect.y === hover.rect.y &&
      h.rect.width === hover.rect.width &&
      h.rect.height === hover.rect.height
    ) {
      return;
    }
    this.update({ hover });
  }

  /** Outlines an element from outside the canvas, like a row in the layers panel. */
  async hoverItem(item: SelectionItem | null) {
    if (!item) return this.setHover(null);
    const frame = this.frame(item.frameId);
    if (!frame) return;
    if (item.loc === undefined) {
      const b = this.boxOf(frame);
      return this.setHover({
        frameId: frame.id,
        rect: { x: 0, y: 0, width: b.width, height: b.height },
      });
    }
    const found = await bridgeOf(item.frameId)
      ?.rects([item.loc])
      .catch(() => null);
    const rect = found?.[item.loc]?.[item.index ?? 0];
    this.setHover(rect ? { frameId: frame.id, rect } : null);
  }

  private hoverAt(e: PointerEvent) {
    cancelAnimationFrame(this.hoverFrame);
    const { clientX, clientY, target } = e;
    this.hoverFrame = requestAnimationFrame(async () => {
      const seq = ++this.hoverSeq;
      const el = target instanceof Element ? target : null;
      const title = el?.closest<HTMLElement>("[data-frame-title]")?.dataset.frameTitle;
      if (title) {
        const f = this.frame(title);
        if (f) {
          const b = this.boxOf(f);
          this.setHover({ frameId: f.id, rect: { x: 0, y: 0, width: b.width, height: b.height } });
        }
        return;
      }
      if (el?.closest("[data-canvas-ui]")) return this.setHover(null);
      const world = this.camera.toWorld(clientX, clientY);
      const frame = this.frameAt(world);
      if (!frame) return this.setHover(null);
      const p = this.local(frame, world);
      const hit = await bridgeOf(frame.id)
        ?.hit(p.x, p.y)
        .catch(() => null);
      if (seq !== this.hoverSeq || this.press) return;
      const b = this.boxOf(frame);
      this.setHover({
        frameId: frame.id,
        rect: hit?.rect ?? { x: 0, y: 0, width: b.width, height: b.height },
      });
    });
  }

  // Pointer

  private ignored(e: Event) {
    const t = e.target;
    return t instanceof Element && t.closest("[data-canvas-ui]") !== null;
  }

  private onDown(e: PointerEvent) {
    if (e.button !== 0 || this.space || this.ignored(e)) return;
    if (this.state.editingText) return;
    const target = e.target instanceof Element ? e.target : null;
    const world = this.worldOf(e);
    const screen = { x: e.clientX, y: e.clientY };
    const shift = e.shiftKey;
    const deep = e.metaKey || e.ctrlKey;

    const handle = target?.closest<HTMLElement>("[data-handle]");
    const titleId = target?.closest<HTMLElement>("[data-frame-title]")?.dataset.frameTitle;
    const textId = target?.closest<HTMLElement>("[data-text-id]")?.dataset.textId;
    const frame = this.frameAt(world);
    if (this.state.interact && frame && !handle && !titleId) return;
    if (this.state.notice) this.update({ notice: null });

    let start: Omit<
      Press,
      "pointerId" | "target" | "screen" | "world" | "started" | "gesture"
    > | null = null;

    if (this.state.tool === "comment") {
      e.preventDefault();
      start = {
        begin: async () => null,
        click: () => this.placeComment(world, frame),
      };
    } else if (handle) {
      const which = handle.dataset.handle as Handle;
      const key = handle.dataset.key!;
      start = { begin: () => this.beginResize(key, which, screen), click: () => {} };
    } else if (textId) {
      start = {
        begin: async () => this.beginMoveText(textId, world),
        click: () => this.selectText(textId),
      };
    } else if (titleId) {
      const f = this.frame(titleId)!;
      const item = this.frameItem(f.id);
      const selected = selectionStore.get().some((s) => s.loc === undefined && s.frameId === f.id);
      if (!selected) selectionStore.set(shift ? toggleItem(selectionStore.get(), item) : [item]);
      this.update({ selectedText: null });
      start = {
        begin: async () => this.beginMoveFrames(world),
        click: () => {
          if (selected && shift) selectionStore.set(toggleItem(selectionStore.get(), item));
        },
      };
    } else if (frame) {
      const p = this.local(frame, world);
      const bridge = bridgeOf(frame.id);
      const hit = bridge ? bridge.hit(p.x, p.y).catch(() => null) : Promise.resolve(null);
      this.update({ selectedText: null });
      start = {
        begin: async () => this.beginDragInFrame(frame, await hit, world, deep),
        click: async () => this.clickInFrame(frame, await hit, shift, deep),
      };
    } else {
      // The empty canvas: the camera pans on a drag; a click clears the selection.
      start = {
        begin: async () => null,
        click: () => {
          if (!shift) selectionStore.set([]);
          this.update({ selectedText: null, editingLabel: null });
        },
      };
      this.press = {
        ...start,
        pointerId: e.pointerId,
        target,
        screen,
        world,
        started: false,
        gesture: null,
      };
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    this.viewport.setPointerCapture(e.pointerId);
    this.press = {
      ...start,
      pointerId: e.pointerId,
      target,
      screen,
      world,
      started: false,
      gesture: null,
    };
  }

  private onMove(e: PointerEvent) {
    const press = this.press;
    if (!press || press.pointerId !== e.pointerId) {
      if (!this.press && this.state.tool === "select" && !this.state.interact) this.hoverAt(e);
      else if (this.state.tool === "comment") this.hoverAt(e);
      return;
    }
    const screen = { x: e.clientX, y: e.clientY };
    if (!press.started) {
      if (Math.hypot(screen.x - press.screen.x, screen.y - press.screen.y) < DRAG_SLOP) return;
      press.started = true;
      press.gesture = press.begin();
      void press.gesture.then((g) => {
        if (g) this.update({ dragging: true, hover: null });
      });
    }
    const world = this.worldOf(e);
    void press.gesture?.then((g) => {
      if (this.press === press) g?.move(screen, world, e);
    });
  }

  private async onUp(e: PointerEvent) {
    const press = this.press;
    if (!press || press.pointerId !== e.pointerId) return;
    this.press = null;
    if (this.viewport.hasPointerCapture(e.pointerId))
      this.viewport.releasePointerCapture(e.pointerId);
    if (!press.started) {
      await press.click();
      // A second click in the same spot soon after is a double-click. Counted here, since a
      // pointerdown the editor takes keeps the browser from firing `dblclick` reliably.
      const last = this.lastClick;
      const now = performance.now();
      const plain = !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey;
      const double =
        plain &&
        last !== null &&
        now - last.at < DOUBLE_MS &&
        Math.hypot(e.clientX - last.x, e.clientY - last.y) < DRAG_SLOP * 2;
      this.lastClick = double || !plain ? null : { at: now, x: e.clientX, y: e.clientY };
      if (double) await this.onDoubleClick(e, press.target);
      return;
    }
    const g = await press.gesture;
    this.update({ dragging: false });
    await g?.end(true);
  }

  private cancelPress() {
    const press = this.press;
    this.press = null;
    this.update({ dragging: false });
    void press?.gesture?.then((g) => g?.end(false));
  }

  private async onDoubleClick(e: MouseEvent, target: Element | null) {
    if (
      target?.closest("[data-canvas-ui]") ||
      this.state.interact ||
      this.state.tool !== "select"
    ) {
      return;
    }
    const textId = target?.closest<HTMLElement>("[data-text-id]")?.dataset.textId;
    if (textId) return this.update({ editingLabel: textId, selectedText: textId });
    const titleId = target?.closest<HTMLElement>("[data-frame-title]")?.dataset.frameTitle;
    if (titleId) return;
    const world = this.worldOf(e);
    const frame = this.frameAt(world);
    if (!frame) return;
    const bridge = bridgeOf(frame.id);
    const p = this.local(frame, world);
    const hit = await bridge?.hit(p.x, p.y).catch(() => null);
    if (!hit || !bridge) return;
    const selected = selectionStore.get().find((s) => s.frameId === frame.id);
    const sameEl = selected?.loc === hit.loc && (selected.index ?? 0) === hit.index;
    // On the selected element: type into its text, when it holds only text.
    if (sameEl) {
      const inspection = await bridge.inspect(hit.loc, hit.index).catch(() => null);
      if (inspection?.text !== undefined) {
        return this.update({
          editingText: {
            frameId: frame.id,
            loc: hit.loc,
            index: hit.index,
            rev: inspection.rev,
            tag: inspection.tag,
            rect: hit.rect,
            text: inspection.text,
            font: inspection.computed,
          },
        });
      }
    }
    const next = drillInto(hit, selected?.loc);
    if (!next) return;
    const chain = chainOf(hit);
    const i = chain.findIndex((c) => c.loc === next.loc);
    const path = chain.slice(0, i).reverse();
    const index = next.loc === hit.loc ? hit.index : 0;
    selectionStore.set([this.selectHit(frame.id, next, index, path)]);
  }

  private clickInFrame(frame: Frame, hit: Hit | null, shift: boolean, deep: boolean) {
    let item: SelectionItem = this.frameItem(frame.id);
    const current = selectionStore.get();
    if (hit) {
      // A press on the selected element's ancestor chain keeps the selected one, unless ⌘.
      const selectedInChain =
        !deep &&
        !shift &&
        current.find(
          (s) =>
            s.frameId === frame.id &&
            s.loc !== undefined &&
            chainOf(hit).some((c) => c.loc === s.loc),
        );
      item = selectedInChain || this.selectHit(frame.id, hit, hit.index, hit.path);
    }
    selectionStore.set(shift ? toggleItem(current, item) : [item]);
  }

  // Gestures

  private async beginMoveFrames(from: Point): Promise<Gesture | null> {
    const ids = new Set(
      selectionStore
        .get()
        .filter((s) => s.loc === undefined)
        .map((s) => s.frameId),
    );
    const frames = this.canvas.frames.filter((f) => ids.has(f.id));
    if (frames.length === 0) return null;
    let d = { x: 0, y: 0 };
    return {
      move: (_, world) => {
        d = { x: world.x - from.x, y: world.y - from.y };
        const frameOverrides: Record<string, Rect> = {};
        for (const f of frames) {
          const b = this.boxOf({ ...f });
          frameOverrides[f.id] = { ...b, x: Math.round(f.x + d.x), y: Math.round(f.y + d.y) };
        }
        this.update({ frameOverrides });
      },
      end: async (commit) => {
        if (commit && (d.x !== 0 || d.y !== 0)) {
          await this.patch({ op: "moveFrames", frames: movedFrames(frames, d) });
        }
        this.update({ frameOverrides: {} });
      },
    };
  }

  private async beginMoveText(id: string, from: Point): Promise<Gesture | null> {
    const text = this.canvas.texts.find((t) => t.id === id);
    if (!text) return null;
    this.selectText(id);
    let at = { x: text.x, y: text.y };
    return {
      move: (_, world) => {
        at = { x: Math.round(text.x + world.x - from.x), y: Math.round(text.y + world.y - from.y) };
        this.update({ textOverrides: { [id]: at } });
      },
      end: async (commit) => {
        if (commit && (at.x !== text.x || at.y !== text.y)) {
          await this.patch({ op: "setText", text: { ...text, ...at } });
        }
        this.update({ textOverrides: {} });
      },
    };
  }

  private async beginResize(key: string, handle: Handle, from: Point): Promise<Gesture | null> {
    const item = selectionStore.get().find((s) => keyOf(s) === key);
    const frame = item && this.frame(item.frameId);
    if (!item || !frame) return null;
    const zoom = () => this.camera.view.zoom;
    if (item.loc === undefined) {
      let d = { x: 0, y: 0 };
      const start = this.boxOf(frame);
      return {
        move: (screen) => {
          d = { x: (screen.x - from.x) / zoom(), y: (screen.y - from.y) / zoom() };
          const r = resizedFrame({ ...frame, ...start }, handle, d);
          this.update({ frameOverrides: { [frame.id]: r } });
        },
        end: async (commit) => {
          if (commit && (d.x !== 0 || d.y !== 0)) {
            await this.patch({
              op: "resizeFrames",
              frames: [resizedFrame({ ...frame, ...start }, handle, d)],
            });
          }
          this.update({ frameOverrides: {} });
          void this.refreshSelection();
        },
      };
    }
    const facts = this.facts.get(key);
    const rect = this.state.rects[key];
    const bridge = bridgeOf(frame.id);
    if (!facts || !rect || !bridge) return null;
    const el = { loc: item.loc, rev: facts.rev, tag: facts.tag };
    let d = { x: 0, y: 0 };
    return {
      move: (screen) => {
        d = { x: (screen.x - from.x) / zoom(), y: (screen.y - from.y) / zoom() };
        bridge.preview(item.loc!, resizeStyles(rect, handle, d));
        void bridge.rects([item.loc!]).then((r) => {
          const now = r[item.loc!]?.[item.index ?? 0];
          if (now) this.update({ rects: { ...this.state.rects, [key]: now } });
        });
      },
      end: async (commit) => {
        const edit = commit ? resizeEdit(el, rect, handle, d) : null;
        if (edit) await this.edit([edit]);
        else bridge.preview(item.loc!, null);
        void this.refreshSelection();
      },
    };
  }

  /** A drag that starts inside a frame: reorders the selected element within its flex or grid parent. */
  private async beginDragInFrame(
    frame: Frame,
    hit: Hit | null,
    from: Point,
    deep: boolean,
  ): Promise<Gesture | null> {
    const selected = selectionStore.get();
    const frameSelected = selected.some((s) => s.loc === undefined && s.frameId === frame.id);
    if (!hit) return frameSelected ? this.beginMoveFrames(from) : null;
    const chain = chainOf(hit);
    let item = deep
      ? undefined
      : selected.find(
          (s) =>
            s.frameId === frame.id && s.loc !== undefined && chain.some((c) => c.loc === s.loc),
        );
    if (!item) {
      item = this.selectHit(frame.id, hit, hit.index, hit.path);
      selectionStore.set([item]);
    }
    const bridge = bridgeOf(frame.id);
    const facts = this.facts.get(keyOf(item));
    if (!bridge || !facts || item.loc === undefined) return null;
    const loc = item.loc;
    const inspection = await bridge.inspect(loc, item.index ?? 0).catch(() => null);
    const axis = inspection ? flowAxis(inspection.parent) : null;
    if (!axis) {
      this.say("Only children of a flex or grid layout can be dragged into a new order.");
      return null;
    }
    const parent = facts.path[0];
    const layers = await bridge.layers().catch(() => [] as LayerNode[]);
    const siblingNodes = childrenIn(layers, parent ? { loc: parent.loc, index: 0 } : null) ?? [];
    const locs = [...new Set(siblingNodes.map((n) => n.loc))];
    const rects = await bridge.rects(locs).catch(() => ({}) as Record<string, Rect[]>);
    const siblings = locs
      .map((l) => ({ loc: l, rect: rects[l]?.[0] }))
      .filter((s): s is { loc: Loc; rect: Rect } => s.rect !== undefined);
    let before: Loc | null | undefined;
    return {
      move: (_, world) => {
        const p = this.local(frame, world);
        before = reorderBefore(loc, siblings, p, axis);
        if (before === undefined) return this.update({ dropLine: null });
        const target =
          before === null ? siblings.at(-1)?.rect : siblings.find((s) => s.loc === before)?.rect;
        if (!target) return this.update({ dropLine: null });
        const edge = before === null;
        const line =
          axis === "x"
            ? {
                x: edge ? target.x + target.width : target.x,
                y: target.y,
                width: 0,
                height: target.height,
              }
            : {
                x: target.x,
                y: edge ? target.y + target.height : target.y,
                width: target.width,
                height: 0,
              };
        this.update({ dropLine: { frameId: frame.id, rect: line } });
      },
      end: async (commit) => {
        this.update({ dropLine: null });
        if (!commit || before === undefined) return;
        await this.edit([
          { kind: "reorder", loc, tag: facts.tag, before, revs: revsOf([{ loc, rev: facts.rev }]) },
        ]);
      },
    };
  }

  // Comments

  private async placeComment(world: Point, frame: Frame | null) {
    if (!frame)
      return this.update({ commentDraft: { anchor: { x: world.x, y: world.y }, at: world } });
    const p = this.local(frame, world);
    const hit = await bridgeOf(frame.id)
      ?.hit(p.x, p.y)
      .catch(() => null);
    const b = this.boxOf(frame);
    const anchor: CommentAnchor = hit
      ? { frameId: frame.id, loc: hit.loc, index: hit.index }
      : { frameId: frame.id };
    const at = hit
      ? { x: b.x + hit.rect.x + hit.rect.width, y: b.y + hit.rect.y }
      : { x: b.x + b.width, y: b.y };
    this.update({ commentDraft: { anchor, at }, openComment: null });
  }

  // Keys

  private onKey(e: KeyboardEvent) {
    const t = e.target;
    if (
      t instanceof HTMLElement &&
      (t.isContentEditable ||
        t.tagName === "INPUT" ||
        t.tagName === "TEXTAREA" ||
        t.tagName === "SELECT")
    ) {
      return;
    }
    this.key(e);
  }

  /** A key pressed on the canvas, or forwarded by a frame's bridge. Returns whether it was used. */
  key(
    e: Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey"> & {
      preventDefault?: () => void;
      repeat?: boolean;
    },
  ): boolean {
    const mod = e.metaKey || e.ctrlKey;
    const done = () => {
      e.preventDefault?.();
      return true;
    };
    if (e.code === "Space" && !mod) {
      this.space = this.camera.space = true;
      return done();
    }
    if (e.key === "Escape") {
      if (this.state.interact) return (this.setInteract(false), done());
      if (this.state.commentDraft || this.state.openComment) {
        return (this.update({ commentDraft: null, openComment: null }), done());
      }
      if (this.state.tool !== "select") return (this.setTool("select"), done());
      if (this.state.selectedText) return (this.selectText(null), done());
      return (this.selectParent(), done());
    }
    if (mod && e.key.toLowerCase() === "z") {
      void this.undo(e.shiftKey ? "redo" : "undo");
      return done();
    }
    if (mod && e.key.toLowerCase() === "d") {
      void this.duplicate();
      return done();
    }
    if (mod && (e.key === "=" || e.key === "+")) return (this.camera.zoomBy(1.25), done());
    if (mod && e.key === "-") return (this.camera.zoomBy(0.8), done());
    if (mod && e.key === "0") return (this.camera.set({ ...this.camera.view, zoom: 1 }), done());
    if (e.key === "Backspace" || e.key === "Delete") return (void this.remove(), done());
    if (mod || e.altKey) return false;
    if (e.shiftKey && e.code === "Digit1") return (this.fitAll(), done());
    if (e.shiftKey && e.code === "Digit2") return (this.fitSelection(), done());
    if (e.key === "c" || e.key === "C") return (this.setTool("comment"), done());
    if (e.key === "v" || e.key === "V") return (this.setTool("select"), done());
    return false;
  }

  fitAll() {
    this.camera.fitTo(union(this.canvas.frames.map((f) => this.boxOf(f))));
  }

  fitSelection() {
    const boxes = selectionStore
      .get()
      .map((s) => this.frame(s.frameId))
      .filter((f): f is Frame => f !== undefined)
      .map((f) => this.boxOf(f));
    if (boxes.length > 0) this.camera.fitTo(union(boxes));
  }

  // Commands

  /** The selected elements, each with what an edit to it needs. */
  private selectedElements() {
    return selectionStore
      .get()
      .filter((s): s is SelectionItem & { loc: Loc } => s.loc !== undefined)
      .map((s) => ({ item: s, facts: this.facts.get(keyOf(s)) }))
      .filter((x): x is { item: SelectionItem & { loc: Loc }; facts: ElementFacts } => !!x.facts);
  }

  async remove() {
    if (this.state.selectedText) {
      const textId = this.state.selectedText;
      this.update({ selectedText: null });
      return this.patch({ op: "removeText", textId });
    }
    const frames = selectionStore
      .get()
      .filter((s) => s.loc === undefined)
      .map((s) => s.frameId);
    if (frames.length > 0) {
      selectionStore.set([]);
      return this.patch({ op: "removeFrames", frameIds: frames });
    }
    const els = this.selectedElements();
    if (els.length === 0) return;
    const locs = [...new Set(els.map((e) => e.item.loc))];
    const parents = els.map(({ item, facts }) =>
      facts.path[0]
        ? this.selectHit(item.frameId, facts.path[0], 0, facts.path.slice(1))
        : this.frameItem(item.frameId),
    );
    const ok = await this.edit([
      {
        kind: "remove",
        locs,
        revs: revsOf(els.map((e) => ({ loc: e.item.loc, rev: e.facts.rev }))),
      },
    ]);
    if (ok) selectionStore.set(dedupe(parents));
  }

  async duplicate() {
    const frames = selectionStore
      .get()
      .filter((s) => s.loc === undefined)
      .map((s) => this.frame(s.frameId))
      .filter((f): f is Frame => f !== undefined);
    if (frames.length > 0) {
      const copies = frames.map((f) => ({
        ...f,
        id: crypto.randomUUID(),
        name: `${f.name} copy`,
        x: f.x + f.width + 60,
      }));
      await this.patch({ op: "addFrames", frames: copies });
      selectionStore.set(copies.map((c) => ({ frameId: c.id, name: c.name })));
      return;
    }
    const els = this.selectedElements();
    if (els.length === 0) return;
    await this.edit([
      {
        kind: "duplicate",
        locs: [...new Set(els.map((e) => e.item.loc))],
        revs: revsOf(els.map((e) => ({ loc: e.item.loc, rev: e.facts.rev }))),
      },
    ]);
  }

  async undo(which: "undo" | "redo") {
    try {
      await finite.request(which === "undo" ? "source.undo" : "source.redo", {
        designId: this.designId,
      });
    } catch (e) {
      this.say(errorText(e));
    }
  }

  /** Ends a text edit: sends the text when it changed. */
  async finishText(text: string | null) {
    const editing = this.state.editingText;
    if (!editing) return;
    this.update({ editingText: null });
    bridgeOf(editing.frameId)?.preview(editing.loc, null);
    if (text === null || text === editing.text) return;
    await this.edit([
      {
        kind: "text",
        loc: editing.loc,
        tag: editing.tag,
        text,
        revs: revsOf([{ loc: editing.loc, rev: editing.rev }]),
      },
    ]);
  }

  /** Sends the inspector's style edits as one `source.edit`: each group sets `styles` on `locs`. */
  styleEdits(groups: Array<{ locs: Loc[]; styles: Record<string, string | null> }>) {
    const els = this.selectedElements();
    const edits: SourceEdit[] = [];
    for (const g of groups) {
      const mine = els.filter((e) => g.locs.includes(e.item.loc));
      if (mine.length === 0) continue;
      edits.push({
        kind: "style",
        locs: [...new Set(mine.map((e) => e.item.loc))],
        tag: mine[0]!.facts.tag,
        styles: g.styles,
        revs: revsOf(mine.map((e) => ({ loc: e.item.loc, rev: e.facts.rev }))),
      });
    }
    return edits.length > 0 ? this.edit(edits) : Promise.resolve(false);
  }

  /** Shows a frame somewhere else than the canvas says, while a field previews it; `null` puts it back. */
  previewFrame(frameId: string, box: Rect | null) {
    this.update({ frameOverrides: box ? { [frameId]: box } : {} });
  }

  /** Sends source edits; keeps the selection on the elements through `remap`, or says why not. */
  async edit(edits: SourceEdit[]): Promise<boolean> {
    try {
      const { remap } = await finite.request("source.edit", {
        designId: this.designId,
        canvasId: this.canvas.id,
        edits,
      });
      const before = selectionStore.get();
      const after = remapSelection(before, remap);
      after.forEach((item, i) => {
        const facts = this.facts.get(keyOf(before[i]!));
        if (facts) this.facts.set(keyOf(item), facts);
      });
      selectionStore.set(after);
      return true;
    } catch (e) {
      for (const el of this.selectedElements())
        bridgeOf(el.item.frameId)?.preview(el.item.loc, null);
      this.refused(e, edits);
      return false;
    }
  }

  async patch(patch: CanvasPatch) {
    try {
      const canvas = await finite.request("canvas.patch", {
        designId: this.designId,
        canvasId: this.canvas.id,
        patch,
      });
      this.setCanvas(canvas);
    } catch (e) {
      this.say(errorText(e));
    }
  }

  private refused(e: unknown, edits: SourceEdit[]) {
    if (errorCode(e) !== "outside-prototype") return this.say(errorText(e));
    const first = edits[0];
    const loc = first && ("loc" in first ? first.loc : first.locs[0]);
    const el = this.selectedElements().find((x) => x.item.loc === loc);
    const chain = el ? [...el.facts.path].reverse() : [];
    const target = loc ? detachTarget(chain, loc) : null;
    if (!target) return this.say(errorText(e));
    this.say(errorText(e), {
      label: `Copy ${baseName(target.file)} into this prototype`,
      run: async () => {
        this.update({ notice: null });
        try {
          await finite.request("source.detach", {
            designId: this.designId,
            canvasId: this.canvas.id,
            ...target,
          });
        } catch (err) {
          this.say(errorText(err));
        }
      },
    });
  }

  /** Shows why something didn't happen, under the selection, for a few seconds. */
  say(text: string, action?: Notice["action"]) {
    clearTimeout(this.noticeTimer);
    this.update({ notice: { text, at: this.noticeSpot(), ...(action ? { action } : {}) } });
    this.noticeTimer = setTimeout(
      () => this.update({ notice: null }),
      action ? NOTICE_MS * 2 : NOTICE_MS,
    );
  }

  private noticeSpot(): Point {
    for (const item of selectionStore.get()) {
      const frame = this.frame(item.frameId);
      const r = this.state.rects[keyOf(item)];
      if (frame && r) {
        const b = this.boxOf(frame);
        return { x: b.x + r.x, y: b.y + r.y + r.height };
      }
    }
    const c = this.camera.visibleWorld(0);
    return { x: c.x + c.width / 2 - 150, y: c.y + c.height - 120 / this.camera.view.zoom };
  }
}

function dedupe(items: SelectionItem[]): SelectionItem[] {
  const seen = new Set<string>();
  return items.filter((i) => !seen.has(keyOf(i)) && seen.add(keyOf(i)));
}

function union(boxes: readonly Rect[]): Rect | null {
  if (boxes.length === 0) return null;
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  const right = Math.max(...boxes.map((b) => b.x + b.width));
  const bottom = Math.max(...boxes.map((b) => b.y + b.height));
  return { x, y, width: right - x, height: bottom - y };
}

// The editor of the canvas on screen, for hooks outside it (the ✱ button, the inspector).

export const activeEditor: Store<CanvasEditor | null> = createStore<CanvasEditor | null>(null);

export function useActiveEditor(): CanvasEditor | null {
  return useSyncExternalStore(activeEditor.subscribe, activeEditor.get, () => null);
}

const noop = () => () => {};

export function useEditorState(editor: CanvasEditor | null): EditorState | null {
  return useSyncExternalStore(
    editor ? editor.store.subscribe : noop,
    () => (editor ? editor.store.get() : null),
    () => null,
  );
}
