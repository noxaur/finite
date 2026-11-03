import type { Renderer } from "../renderer";
import type { UserEdit } from "../schema";
import type { DesignSession } from "../session";
import { HANDLES, type Handle, isPositioned, moveAbsolute, moveArtboards } from "./geometry";
import type { EditContext, Press, Run } from "./gesture";
import { GESTURES } from "./gestures";
import { lineage, nodeOf } from "./tree";

/** How far the pointer moves before a press becomes a drag, in page pixels. */
const DRAG_SLOP = 3;
/** How long a notice stays up. */
const NOTICE_MS = 4000;

export interface EditorState {
  /** Selected node ids, real or virtual. */
  readonly selection: ReadonlyArray<string>;
  /** The node under the pointer, when no gesture runs. */
  readonly hover: string | null;
  /** What the running gesture outlines, like the container a move drops into. */
  readonly target: string | null;
  /** Whether a gesture is dragging. */
  readonly dragging: boolean;
  /** Why the last edit didn't happen, for a moment. */
  readonly notice: string | null;
}

const idle: EditorState = {
  selection: [],
  hover: null,
  target: null,
  dragging: false,
  notice: null,
};

/**
 * Lets a person edit the design with the pointer and keys. It owns the
 * selection and the running gesture: a press goes to the first gesture in
 * `GESTURES` that takes it, each frame of the drag shows that gesture's
 * edits as the session's draft, and releasing commits them. A press no
 * gesture takes is left to the camera, which pans.
 *
 * It listens on the viewport in the capture phase, so it sees a press
 * before the camera does and can keep the camera from panning.
 */
export class Editor {
  private current = idle;
  private readonly listeners = new Set<() => void>();
  private enabled = true;
  private run: {
    readonly run: Run;
    readonly press: Press;
    readonly pointerId: number;
    started: boolean;
    edits: ReadonlyArray<UserEdit> | null;
    /** The edits last shown, as JSON, so an unchanged frame skips the draft. */
    shown: string;
  } | null = null;
  private frame = 0;
  private hoverFrame = 0;
  private noticeTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly abort = new AbortController();

  constructor(
    private readonly viewport: HTMLElement,
    private readonly session: DesignSession,
    private readonly renderer: Renderer,
    private readonly zoom: () => number,
  ) {
    const options = { capture: true, signal: this.abort.signal };
    viewport.addEventListener("pointerdown", (e) => this.onDown(e), options);
    viewport.addEventListener("pointermove", (e) => this.onMove(e), options);
    viewport.addEventListener("pointerup", (e) => this.onUp(e), options);
    viewport.addEventListener("pointercancel", () => this.cancel(), options);
    viewport.addEventListener("pointerleave", () => this.update({ hover: null }), options);
    window.addEventListener("keydown", (e) => this.onKey(e), { signal: this.abort.signal });
    const unsubscribe = session.subscribe(() => this.prune());
    const unlisten = session.onDraftLost((reason) => {
      this.cancel();
      this.say(reason);
    });
    this.abort.signal.addEventListener("abort", () => {
      unsubscribe();
      unlisten();
    });
  }

  get state(): EditorState {
    return this.current;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Off while another tool, like commenting, has the pointer. */
  setEnabled(enabled: boolean) {
    this.enabled = enabled;
    if (!enabled) {
      this.cancel();
      this.update({ selection: [], hover: null });
    }
  }

  select(selection: ReadonlyArray<string>) {
    this.update({ selection });
  }

  dispose() {
    this.cancel();
    this.abort.abort();
    cancelAnimationFrame(this.hoverFrame);
    clearTimeout(this.noticeTimer);
  }

  private context(): EditContext {
    return {
      replica: this.session.replica,
      selection: this.current.selection,
      measure: (id) => this.renderer.measure(id),
      rect: (id) => this.renderer.nodeRect(id),
      hitTest: (x, y) => this.renderer.hitTest(x, y),
      canvasPerPixel: 1 / this.zoom(),
    };
  }

  private onDown(e: PointerEvent) {
    if (!this.enabled || e.button !== 0 || this.run) return;
    const target = e.target instanceof Element ? e.target : null;
    const handle = (target?.closest("[data-handle]") as HTMLElement | null)?.dataset.handle;
    // Pins and other controls on the canvas keep their clicks.
    if (!handle && target?.closest("[data-camera-ignore]")) return;
    const label = this.renderer.labelOf(target);
    const hit = label ? null : this.renderer.hitTest(e.clientX, e.clientY);
    const press: Press = {
      x: e.clientX,
      y: e.clientY,
      shift: e.shiftKey,
      hit,
      label,
      handle: HANDLES.includes(handle as Handle) ? (handle as Handle) : null,
    };
    if (!press.handle) this.selectFor(press);
    const ctx = this.context();
    for (const gesture of GESTURES) {
      const run = gesture.begin(press, ctx);
      if (!run) continue;
      // The press is the gesture's: no panning, no text selection, no focus.
      e.preventDefault();
      e.stopPropagation();
      this.viewport.setPointerCapture(e.pointerId);
      this.run = { run, press, pointerId: e.pointerId, started: false, edits: null, shown: "null" };
      return;
    }
  }

  /**
   * What a press selects: the pressed node, unless it's inside a selected
   * element already, so a drag anywhere on a selected card moves the card.
   * A selected artboard doesn't keep what's on it from being picked.
   */
  private selectFor(press: Press) {
    const { selection } = this.current;
    const pressed = press.label ?? press.hit?.nodeId ?? null;
    if (pressed === null) {
      if (!press.shift) this.update({ selection: [] });
      return;
    }
    if (press.shift) {
      const next = selection.includes(pressed)
        ? selection.filter((id) => id !== pressed)
        : [...selection, pressed];
      this.update({ selection: next });
      return;
    }
    const within = lineage(this.session.replica, pressed).some(
      (id) =>
        selection.includes(id) &&
        (id === pressed || nodeOf(this.session.replica, id)?.parent !== null),
    );
    if (!within) this.update({ selection: [pressed] });
  }

  private onMove(e: PointerEvent) {
    const running = this.run;
    if (!running) {
      if (!this.enabled || e.buttons !== 0) return;
      const { clientX, clientY } = e;
      cancelAnimationFrame(this.hoverFrame);
      this.hoverFrame = requestAnimationFrame(() => {
        const hit = this.renderer.hitTest(clientX, clientY);
        if (hit?.nodeId !== this.current.hover) this.update({ hover: hit?.nodeId ?? null });
      });
      return;
    }
    if (e.pointerId !== running.pointerId) return;
    const pointer = { x: e.clientX, y: e.clientY, shift: e.shiftKey };
    if (!running.started) {
      if (Math.hypot(pointer.x - running.press.x, pointer.y - running.press.y) < DRAG_SLOP) return;
      running.started = true;
      this.update({ dragging: true, hover: null });
    }
    // One draft per frame, however many moves arrive.
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => this.step(pointer));
  }

  private step(pointer: { x: number; y: number; shift: boolean }) {
    const running = this.run;
    if (!running) return;
    const edits = running.run.move(pointer);
    const json = JSON.stringify(edits);
    if (json !== running.shown) {
      running.shown = json;
      const outcome = this.session.draft(edits);
      if (outcome.error !== null) {
        this.cancel();
        this.say(outcome.error);
        return;
      }
      running.edits = edits;
    }
    this.update({ target: running.run.target?.() ?? null });
  }

  private onUp(e: PointerEvent) {
    const running = this.run;
    if (!running || e.pointerId !== running.pointerId) return;
    cancelAnimationFrame(this.frame);
    if (running.started) this.step({ x: e.clientX, y: e.clientY, shift: e.shiftKey });
    // The last frame's edits can't be planned, so it cancelled the gesture.
    if (this.run !== running) return;
    this.run = null;
    this.update({ dragging: false, target: null });
    if (running.edits) void this.commit(running.edits);
  }

  /** Stops the running gesture and takes its draft off the screen. */
  private cancel() {
    cancelAnimationFrame(this.frame);
    if (!this.run) return;
    this.run = null;
    this.session.draft(null);
    this.update({ dragging: false, target: null });
  }

  private async commit(edits: ReadonlyArray<UserEdit>) {
    const result = await this.session.commit(edits);
    if (result.kind === "refused") this.say(result.message);
  }

  private onKey(e: KeyboardEvent) {
    if (!this.enabled || isTyping(e)) return;
    const mod = e.metaKey || e.ctrlKey;
    const key = e.key.toLowerCase();
    if (mod && (key === "z" || key === "y")) {
      e.preventDefault();
      const redo = key === "y" || e.shiftKey;
      void (redo ? this.session.redo() : this.session.undo()).then((result) => {
        if (result.kind === "refused") this.say(result.message);
      });
      return;
    }
    if (mod || e.altKey) return;
    if (e.key === "Escape") {
      if (this.run) this.cancel();
      else this.selectParent();
      return;
    }
    const { selection } = this.current;
    if (selection.length === 0 || this.run) return;
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      this.update({ selection: [] });
      void this.commit([{ kind: "delete", ids: [...selection] }]);
      return;
    }
    const step = e.shiftKey ? 10 : 1;
    const arrows: Record<string, { x: number; y: number }> = {
      ArrowLeft: { x: -step, y: 0 },
      ArrowRight: { x: step, y: 0 },
      ArrowUp: { x: 0, y: -step },
      ArrowDown: { x: 0, y: step },
    };
    const delta = arrows[e.key];
    if (!delta) return;
    e.preventDefault();
    const edits = this.nudge(selection, delta);
    if (edits.length > 0) void this.commit(edits);
  }

  /**
   * Moves artboards and positioned elements by `delta` pixels. An element
   * in the flow trades places with its previous or next sibling instead.
   */
  private nudge(selection: ReadonlyArray<string>, delta: { x: number; y: number }): UserEdit[] {
    const replica = this.session.replica;
    const boards = selection.flatMap((id) => {
      const node = replica.get(id);
      return node?.parent === null ? [{ id, x: node.x ?? 0, y: node.y ?? 0 }] : [];
    });
    const edits: UserEdit[] = boards.length > 0 ? [moveArtboards(boards, delta)] : [];
    for (const id of selection) {
      const node = nodeOf(replica, id);
      const facts = this.renderer.measure(id);
      if (!node || node.parent === null || !facts) continue;
      if (isPositioned(facts)) {
        edits.push(moveAbsolute(node, facts, delta));
        continue;
      }
      if (selection.length !== 1) continue;
      const siblings = replica.children(node.parent);
      const at = siblings.findIndex((s) => s.id === id);
      const earlier = delta.x < 0 || delta.y < 0;
      // Before the previous sibling, or before the one after the next.
      const anchor = earlier ? siblings[at - 1] : siblings[at + 2];
      if (earlier && !anchor) continue;
      if (!earlier && at + 1 >= siblings.length) continue;
      edits.push({ kind: "place", ids: [id], parent: node.parent, before: anchor?.id ?? null });
    }
    return edits;
  }

  /** Selects the parent of what's selected, or nothing once that's an artboard. */
  private selectParent() {
    const [id] = this.current.selection;
    if (id === undefined) return;
    const node = nodeOf(this.session.replica, id);
    this.update({ selection: node?.parent ? [node.parent] : [] });
  }

  /** Forgets selected nodes someone deleted. */
  private prune() {
    const replica = this.session.replica;
    const selection = this.current.selection.filter((id) => nodeOf(replica, id) !== undefined);
    if (selection.length !== this.current.selection.length) this.update({ selection });
  }

  private say(notice: string) {
    clearTimeout(this.noticeTimer);
    this.update({ notice });
    this.noticeTimer = setTimeout(() => this.update({ notice: null }), NOTICE_MS);
  }

  private update(patch: Partial<EditorState>) {
    this.current = { ...this.current, ...patch };
    for (const listener of this.listeners) listener();
  }
}

/**
 * Whether keys go to a text field, which keeps them. A field inside an
 * artboard's shadow root reaches the window retargeted to its host, so
 * this reads where the event really started.
 */
function isTyping(e: KeyboardEvent) {
  const target = e.composedPath()[0];
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
  );
}
