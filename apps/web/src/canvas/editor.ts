import type {
  Canvas,
  CanvasPatch,
  CommentAnchor,
  Frame,
  Hit,
  HitElement,
  Loc,
  Inline,
  Rect,
  Rev,
  Section,
  SourceEdit,
  Slice,
  TextLabel,
} from "@finite/protocol";
import { useSyncExternalStore } from "react";
import type { Camera } from "@/design/camera";
import { hasText, normalize, sameContent } from "@/design/editing/inline";
import { bridgeOf, mountedBridges } from "./bridge";
import { draw } from "./tools/draw";
import type { Ghost, Gesture, KeyInput, Placed, PressPlan, ToolDef, ToolHost } from "./tools/host";
import { ALL_COMMANDS, type KeyEnv, resolveKey, type ToolId, toolOf } from "./tools/registry";
import { placeText } from "./tools/text";
import { layerName, layerNameAt, pathIn } from "./layers";
import { undoOrderFor } from "./undoOrder";
import { finite } from "@/client/finite";
import { baseName, detachTarget, fileOf, type Point, revsOf } from "./gestures";
import {
  createStore,
  keyOf,
  remapSelection,
  type SelectionItem,
  selectionStore,
  type Store,
} from "./selection";

/** How far the pointer travels before a press becomes a drag, in screen pixels. */
const DRAG_SLOP = 3;
const NOTICE_MS = 5000;
/** How soon a second click makes a double-click, in milliseconds. */
const DOUBLE_MS = 400;

/** What an element selection knows beyond its loc: what the edits it makes need. */
export type ElementFacts = { rev: Rev; tag: string; path: HitElement[] };

export type Notice = {
  text: string;
  /** Where it shows, in canvas units: under the selection. */
  at: Point;
  action?: { label: string; run: () => void };
};

/** What finishing a text edit writes to: an element that exists, or a new one to place. */
export type TextTarget =
  | {
      kind: "element";
      frameId: string;
      loc: Loc;
      tag: string;
      rev: Rev;
      /** The stamped path to the element, outermost first, for the detach offer. */
      chain: readonly HitElement[];
    }
  | { kind: "new"; box: Rect; deep: boolean; alt: boolean; fixed: boolean };

export type TextEdit = {
  /** Where the text sits on the canvas, in canvas units. */
  rect: Rect;
  font: Record<string, string>;
  content: Inline[];
  keeps: { id: number; kind: string; label: string; loc?: Loc | undefined }[];
  /** How each kept wrapper's text is drawn in the frame, by its id. */
  keepStyles: Record<number, Record<string, string>>;
  /** SVG text: no format bar, no line breaks. */
  plain: boolean;
  target: TextTarget;
};

/** A section or slice the person picked, which the selection store (elements and frames) doesn't hold. */
export type ObjectSelection = { kind: "section" | "slice"; id: string };

export interface EditorState {
  /** The current tool. On Interact, the pointer reaches into the frames, into the real app. */
  readonly tool: ToolId;
  /** A shape being drawn. */
  readonly ghost: Ghost | null;
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
  /** Sections and slices shown somewhere else than the canvas says, while a gesture runs. */
  readonly objectOverrides: Readonly<Record<string, Rect>>;
  /** Where a reorder drops, in the frame's CSS pixels. */
  readonly dropLine: { frameId: string; rect: Rect } | null;
  readonly notice: Notice | null;
  readonly editingText: TextEdit | null;
  readonly selectedText: string | null;
  readonly selectedObject: ObjectSelection | null;
  readonly editingLabel: string | null;
  /** A comment (or annotation) being written: its anchor and where its pin sits, in canvas units. */
  readonly commentDraft: { anchor: CommentAnchor; at: Point; kind?: "annotation" } | null;
  readonly openComment: string | null;
  /** Heights hug frames report, so their box follows their content. */
  readonly sizes: Readonly<Record<string, number>>;
  /** Counts frame loads and HMR updates, so what's measured in frames measures again. */
  readonly updates: number;
}

const initial: EditorState = {
  tool: "select",
  ghost: null,
  hover: null,
  rects: {},
  label: null,
  dragging: false,
  frameOverrides: {},
  textOverrides: {},
  objectOverrides: {},
  dropLine: null,
  notice: null,
  editingText: null,
  selectedText: null,
  selectedObject: null,
  editingLabel: null,
  commentDraft: null,
  openComment: null,
  sizes: {},
  updates: 0,
};

type Press = {
  tool: ToolDef;
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
export class CanvasEditor implements ToolHost {
  readonly store: Store<EditorState> = createStore(initial);
  /** rev, tag and stamped ancestors of each selected element, by selection key. */
  readonly facts = new Map<string, ElementFacts>();
  private canvas: Canvas;
  private current: Press | null = null;
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
        if (e.code === "Space") this.setSpace(false);
      },
      { signal },
    );
    window.addEventListener("blur", () => this.setSpace(false), { signal });
    // Left-drag pans only on the empty canvas; on frames it selects and edits.
    camera.mayPan = (e) => {
      const pan = toolOf(this.state.tool).pan;
      return pan === "always" || (pan === "empty" && this.frameAt(this.worldOf(e)) === null);
    };
    this.offSelection = selectionStore.subscribe(() => {
      if (this.state.selectedObject && selectionStore.get().length > 0) {
        this.update({ selectedObject: null });
      }
      void this.refreshSelection();
    });
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

  update(patch: Partial<EditorState>) {
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
    const picked = this.state.selectedObject;
    if (
      picked &&
      !(picked.kind === "section" ? canvas.sections : canvas.slices).some((o) => o.id === picked.id)
    ) {
      this.update({ selectedObject: null });
    }
    void this.refreshSelection();
  }

  get frames(): readonly Frame[] {
    return this.canvas.frames;
  }

  get canvasId(): string {
    return this.canvas.id;
  }

  get sections(): readonly Section[] {
    return this.canvas.sections;
  }

  get slices(): readonly Slice[] {
    return this.canvas.slices;
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

  setTool(id: string) {
    const tool = toolOf(id);
    if (!tool.enabled) return;
    // A key held down repeats, and that same tool's press has to survive it.
    if (tool.id !== this.state.tool) this.cancelPress();
    this.update({ tool: tool.id as ToolId, commentDraft: null, hover: null, ghost: null });
    tool.activate?.(this);
  }

  setGhost(ghost: Ghost | null) {
    this.update({ ghost });
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
    this.update({ selectedText: id, ...(id ? { selectedObject: null } : {}) });
  }

  /** Picks a section or slice (or nothing), taking the selection off elements, frames and labels. */
  selectObject(picked: ObjectSelection | null) {
    if (picked) selectionStore.set([]);
    this.update({ selectedObject: picked, ...(picked ? { selectedText: null } : {}) });
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

  local(frame: Frame, p: Point): Point {
    const b = this.boxOf(frame);
    return { x: p.x - b.x, y: p.y - b.y };
  }

  // Selection

  frameItem(frameId: string): SelectionItem {
    const name = this.frame(frameId)?.name;
    return name === undefined ? { frameId } : { frameId, name };
  }

  /** Selects one hit element, remembering what edits to it need. */
  private factsFor(item: SelectionItem, facts: ElementFacts) {
    this.facts.set(keyOf(item), facts);
  }

  /**
   * Selects one hit element, remembering what edits to it need. Its name is the layer name: the
   * component or tag's meaning at once, then the bridge's own name (text, label) once it answers.
   */
  selectHit(frameId: string, hit: Hit | HitElement, index: number, path: HitElement[]) {
    const parentFile = path[0] && fileOf(path[0].loc);
    const name = layerName({ loc: hit.loc, tag: hit.tag, name: "" }, parentFile);
    const item = { frameId, loc: hit.loc, index, name };
    this.factsFor(item, { rev: hit.rev, tag: hit.tag, path });
    void this.nameFromLayers(item);
    return item;
  }

  private async nameFromLayers(item: SelectionItem & { loc: Loc }) {
    const layers = await bridgeOf(item.frameId)
      ?.layers()
      .catch(() => null);
    const name = layers && layerNameAt(layers, item.loc, item.index ?? 0);
    if (!name || name === item.name) return;
    const key = keyOf(item);
    const now = selectionStore.get();
    if (now.some((s) => keyOf(s) === key)) {
      selectionStore.set(now.map((s) => (keyOf(s) === key ? { ...s, name } : s)));
    }
    // The press that hit it may put this item in the selection later: it carries the name there.
    item.name = name;
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
    if (frame && this.ownFile(frame) === file) return null;
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

  ownFile(frame: Frame): string | undefined {
    return frame.source.kind === "file" ? frame.source.file : this.routeFile?.(frame);
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
      if (seq !== this.hoverSeq || this.current) return;
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
    if (this.state.editingText) {
      // A press outside the overlay ends the edit, the same as leaving the box.
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      return;
    }
    // A press that isn't on a section's or slice's own controls lets go of it.
    if (this.state.selectedObject) this.update({ selectedObject: null });
    // A press on the canvas takes the keys back from a field outside it, like the composer, so
    // canvas shortcuts don't type into it. The camera's own handling keeps focus from moving.
    const active = document.activeElement;
    if (active instanceof HTMLElement && !this.viewport.contains(active)) active.blur();
    const target = e.target instanceof Element ? e.target : null;
    const world = this.worldOf(e);
    const screen = { x: e.clientX, y: e.clientY };
    const tool = toolOf(this.state.tool);
    const plan = tool.down?.(this, {
      event: e,
      target,
      world,
      screen,
      shift: e.shiftKey,
      deep: e.metaKey || e.ctrlKey,
      alt: e.altKey,
      frame: this.frameAt(world),
    });
    if (!plan || plan === "pass") return;
    if (this.state.notice) this.update({ notice: null });
    if (plan.passive) {
      this.current = {
        ...plan,
        tool,
        pointerId: e.pointerId,
        target,
        screen,
        world,
        started: false,
        gesture: null,
      };
      return;
    }
    this.press(e, plan, tool, target, world);
  }

  /** Takes the pointer and turns the press into `plan`: a drag past the slop, else a click. */
  press(
    e: PointerEvent,
    plan: PressPlan,
    tool: ToolDef = toolOf(this.state.tool),
    target: Element | null = e.target instanceof Element ? e.target : null,
    world: Point = this.worldOf(e),
  ) {
    e.preventDefault();
    e.stopPropagation();
    this.viewport.setPointerCapture(e.pointerId);
    this.current = {
      ...plan,
      tool,
      pointerId: e.pointerId,
      target,
      screen: { x: e.clientX, y: e.clientY },
      world,
      started: false,
      gesture: null,
    };
  }

  private onMove(e: PointerEvent) {
    const press = this.current;
    if (!press || press.pointerId !== e.pointerId) {
      if (!press && toolOf(this.state.tool).hover) this.hoverAt(e);
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
      if (this.current === press) g?.move(screen, world, e);
    });
  }

  private async onUp(e: PointerEvent) {
    const press = this.current;
    if (!press || press.pointerId !== e.pointerId) return;
    this.current = null;
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
      if (double) await press.tool.doubleClick?.(this, e, press.target);
      this.backToMove(press.tool);
      return;
    }
    const g = await press.gesture;
    this.update({ dragging: false });
    await g?.end(true);
    this.backToMove(press.tool);
  }

  /** A tool that isn't sticky hands back to Move after one use. */
  private backToMove(tool: ToolDef) {
    if (!tool.sticky && this.state.tool === tool.id) this.setTool("select");
  }

  private cancelPress() {
    const press = this.current;
    this.current = null;
    this.update({ dragging: false, ghost: null });
    void press?.gesture?.then((g) => g?.end(false));
  }

  // Comments

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
    this.key(e, "page");
  }

  /** A key pressed on the canvas, or forwarded by a frame's bridge. Returns whether it was used. */
  key(e: KeyInput, source: KeyEnv["source"]): boolean {
    const editing = this.state.editingText !== null || this.state.editingLabel !== null;
    const done = () => {
      e.preventDefault?.();
      return true;
    };
    if (!editing && toolOf(this.state.tool).key?.(this, e)) return done();
    const action = resolveKey(e, {
      source,
      interact: this.state.tool === "interact",
      editing,
      vector: false,
    });
    if (!action) return false;
    if (action.kind === "tool") this.setTool(action.id);
    else ALL_COMMANDS.find((c) => c.id === action.id)?.run(this);
    return done();
  }

  /** Space-drag pans; the camera reads the same flag. */
  setSpace(on: boolean) {
    this.space = this.camera.space = on;
  }

  /** Backs out of whatever's open, one step at a time. */
  escape() {
    if (this.current) return this.cancelPress();
    if (this.state.tool === "interact") return this.setTool("select");
    if (this.state.commentDraft || this.state.openComment) {
      return this.update({ commentDraft: null, openComment: null });
    }
    if (this.state.tool !== "select") return this.setTool("select");
    if (this.state.selectedText) return this.selectText(null);
    if (this.state.selectedObject) return this.selectObject(null);
    this.selectParent();
  }

  fitAll() {
    // Text labels have no height of their own; a label's box ends where the frame below it starts.
    const labels = this.canvas.texts.map((t) => ({ x: t.x, y: t.y, width: t.width, height: 100 }));
    this.camera.fitTo(
      union([...this.canvas.frames.map((f) => this.boxOf(f)), ...labels, ...this.canvas.sections]),
    );
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
    const picked = this.state.selectedObject;
    if (picked) {
      this.update({ selectedObject: null });
      return this.patch(
        picked.kind === "section"
          ? { op: "removeSection", sectionId: picked.id }
          : { op: "removeSlice", sliceId: picked.id },
      );
    }
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

  /** Takes back (or redoes) this person's last source edit or canvas patch, whichever came last. */
  async undo(which: "undo" | "redo") {
    const order = undoOrderFor(this.designId);
    // Nothing recorded (the page reloaded): the server still has the source edits.
    const step = (which === "undo" ? order.undo() : order.redo()) ?? { kind: "source" };
    try {
      if (step.kind === "source") {
        await finite.request(which === "undo" ? "source.undo" : "source.redo", {
          designId: this.designId,
        });
        return;
      }
      const canvas = await finite.request(which === "undo" ? "canvas.undo" : "canvas.redo", {
        designId: this.designId,
        canvasId: step.canvasId,
      });
      if (canvas.id === this.canvas.id) this.setCanvas(canvas);
    } catch (e) {
      this.say(errorText(e));
    }
  }

  /** Ends a text edit: writes the runs when they changed; `null` puts the text back. */
  async finishText(content: Inline[] | null, measured = { width: 0, height: 0 }) {
    const editing = this.state.editingText;
    if (!editing) return;
    this.update({ editingText: null });
    const target = editing.target;
    if (target.kind === "new") {
      if (content && hasText(content)) await placeText(this, target, content, measured);
      return;
    }
    bridgeOf(target.frameId)?.preview(target.loc, null);
    if (content === null || sameContent(content, normalize(editing.content))) return;
    await this.edit(
      [
        {
          kind: "inline",
          loc: target.loc,
          tag: target.tag,
          content,
          revs: revsOf([{ loc: target.loc, rev: target.rev }]),
        },
      ],
      target.chain,
    );
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

  /**
   * Sends source edits; keeps the selection on the elements through `remap`, or says why not.
   * `chain` is the stamped path to a new element's parent, outermost first, for the detach offer.
   */
  async edit(
    edits: SourceEdit[],
    chain?: readonly HitElement[],
  ): Promise<{ created: Record<string, Loc> } | false> {
    try {
      const { remap, created } = await finite.request("source.edit", {
        designId: this.designId,
        canvasId: this.canvas.id,
        edits,
      });
      undoOrderFor(this.designId).did({ kind: "source" });
      const before = selectionStore.get();
      const after = remapSelection(before, remap);
      after.forEach((item, i) => {
        const facts = this.facts.get(keyOf(before[i]!));
        if (facts) this.facts.set(keyOf(item), facts);
      });
      selectionStore.set(after);
      return { created };
    } catch (e) {
      for (const el of this.selectedElements())
        bridgeOf(el.item.frameId)?.preview(el.item.loc, null);
      this.refused(e, edits, chain);
      return false;
    }
  }

  readInline(loc: Loc) {
    return finite.request("source.inline", { designId: this.designId, loc });
  }

  /** Adds a shape where `box` lands, or says why it can't. */
  draw(input: Parameters<ToolHost["draw"]>[0]): Promise<Placed | null> {
    return draw(this, input);
  }

  bridge(frameId: string) {
    return bridgeOf(frameId);
  }

  select(items: SelectionItem[]) {
    selectionStore.set(items);
  }

  async patch(patch: CanvasPatch) {
    try {
      const canvas = await finite.request("canvas.patch", {
        designId: this.designId,
        canvasId: this.canvas.id,
        patch,
      });
      undoOrderFor(this.designId).did({ kind: "canvas", canvasId: this.canvas.id });
      this.setCanvas(canvas);
    } catch (e) {
      this.say(errorText(e));
    }
  }

  private refused(e: unknown, edits: SourceEdit[], passed?: readonly HitElement[]) {
    if (errorCode(e) !== "outside-prototype") return this.say(errorText(e));
    const first = edits[0];
    const loc = first && ("loc" in first ? first.loc : first.locs[0]);
    const el = this.selectedElements().find((x) => x.item.loc === loc);
    const chain = passed ?? (el ? [...el.facts.path].reverse() : []);
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
    return { x: c.x + c.width / 2 - 150, y: c.y + c.height - 190 / this.camera.view.zoom };
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
