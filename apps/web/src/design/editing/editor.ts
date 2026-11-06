import type { Renderer } from "../renderer";
import type { UserEdit } from "../schema";
import type { DesignSession } from "../session";
import {
  type Box,
  type Guide,
  HANDLES,
  type Handle,
  isPositioned,
  moveAbsolute,
  moveArtboards,
} from "./geometry";
import type { Hit } from "../renderer";
import type { EditContext, Pointer, Press, Run } from "./gesture";
import { GESTURES } from "./gestures";
import { toggleFlag } from "./layers";
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
  /** The guides the running gesture snapped to, in page pixels. */
  readonly guides: ReadonlyArray<Guide>;
  /** The running gesture's box, like a selection box, in page pixels. */
  readonly area: Box | null;
  /** The node whose text the person is typing into. */
  readonly editing: string | null;
  /** Why the last edit didn't happen, for a moment. */
  readonly notice: string | null;
}

/**
 * One edit from a panel that shows as it's made: a field being typed into,
 * a label being scrubbed, a color being picked. It previews through the
 * same draft a canvas gesture uses, and commits as one undo step. After
 * `commit` or `cancel` it does nothing, so a late blur can't send it twice.
 */
export interface Draft {
  /** Shows `edits` instead of the last ones (`null`: none). Returns why they can't be made. */
  preview(edits: ReadonlyArray<UserEdit> | null): string | null;
  /** Sends what's shown, or `final` instead, as one undo step. */
  commit(final?: ReadonlyArray<UserEdit>): void;
  /** Takes the preview off the screen. */
  cancel(): void;
}

/** A pointer gesture a panel starts with `Editor.drive`. */
export interface PanelRun extends Run {
  /** Whether each frame's edits show as a draft (the default), or only commit on release. */
  readonly live?: boolean;
  /** Runs once when the gesture ends, committed or not. */
  end?(committed: boolean): void;
  /** True while the panel holds the pointer another way, like a pointer lock, so losing its capture doesn't end the gesture. */
  keep?(): boolean;
}

const idle: EditorState = {
  selection: [],
  hover: null,
  target: null,
  dragging: false,
  guides: [],
  area: null,
  editing: null,
  notice: null,
};

/**
 * Lets a person edit the design with the pointer and keys. It owns the
 * selection and the running gesture: a press goes to the first gesture in
 * `GESTURES` that takes it, each frame of the drag shows that gesture's
 * edits as the session's draft, and releasing commits them. A press no
 * gesture takes is left to the camera, which pans, as is any press while
 * Space is held. Keys run the commands in `onKey`, and a double-click
 * types into an element's text.
 *
 * It listens on the viewport in the capture phase, so it sees a press
 * before the camera does and can keep the camera from panning.
 */
export class Editor {
  private current = idle;
  private readonly listeners = new Set<() => void>();
  private enabled = true;
  private run: {
    readonly run: PanelRun;
    readonly press: Press;
    readonly pointerId: number;
    started: boolean;
    edits: ReadonlyArray<UserEdit> | null;
    /** The edits last shown, as JSON, so an unchanged frame skips the draft. */
    shown: string;
    /** The panel element that takes the pointer once the press becomes a drag. */
    capture?: HTMLElement;
    /** Stops listening on that element. */
    detach?: () => void;
  } | null = null;
  /** The panel edit being previewed, with what it last showed. */
  private open: {
    edits: ReadonlyArray<UserEdit> | null;
    readonly onLost: ((reason: string) => void) | undefined;
  } | null = null;
  private frame = 0;
  private hoverFrame = 0;
  private noticeTimer: ReturnType<typeof setTimeout> | undefined;
  /** Held down, Space hands the pointer to the camera, to pan. */
  private space = false;
  /** What ⌘C copied, for ⌘V to duplicate. */
  private copied: ReadonlyArray<string> = [];
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
    // Only leaving the viewport itself: listening in the capture phase also
    // hears every element inside it, like the selection redrawn under a click.
    viewport.addEventListener(
      "pointerleave",
      (e) => {
        if (e.target !== viewport) return;
        // A hover test still waiting would undo what a panel's row shows hovered next.
        cancelAnimationFrame(this.hoverFrame);
        this.update({ hover: null });
      },
      options,
    );
    viewport.addEventListener("dblclick", (e) => this.onDoubleClick(e), options);
    window.addEventListener("keydown", (e) => this.onKey(e), { signal: this.abort.signal });
    window.addEventListener(
      "keyup",
      (e) => {
        if (e.code === "Space") this.space = false;
      },
      { signal: this.abort.signal },
    );
    window.addEventListener("blur", () => (this.space = false), { signal: this.abort.signal });
    const unsubscribe = session.subscribe(() => this.prune());
    const unlisten = session.onDraftLost((reason) => {
      this.cancel();
      const open = this.open;
      if (open) {
        this.open = null;
        this.session.draft(null);
        open.onLost?.(reason);
      }
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
    this.finishOpen();
    this.update({ selection });
  }

  /** Shows `id` as hovered, as the pointer over it on the canvas does. */
  hover(id: string | null) {
    if (!this.run && id !== this.current.hover) this.update({ hover: id });
  }

  /** Shows `id` outlined as where a running panel gesture drops. */
  setTarget(id: string | null) {
    if (id !== this.current.target) this.update({ target: id });
  }

  /**
   * Starts a panel edit that previews until it's committed. Only one is
   * open at a time, since the design has one draft: starting another, a
   * press on the canvas or a new selection commits this one first.
   */
  begin(options: { onLost?: (reason: string) => void } = {}): Draft {
    this.finishOpen();
    const open = { edits: null as ReadonlyArray<UserEdit> | null, onLost: options.onLost };
    this.open = open;
    const live = () => this.open === open;
    return {
      preview: (edits) => {
        if (!live() || this.run) return null;
        const json = JSON.stringify(edits);
        if (json === JSON.stringify(open.edits)) return null;
        const outcome = this.session.draft(edits);
        open.edits = outcome.error === null ? edits : null;
        return outcome.error;
      },
      commit: (final) => {
        if (!live()) return;
        this.open = null;
        const edits = final ?? open.edits;
        if (edits && edits.length > 0) void this.commit(edits);
        else this.session.draft(null);
      },
      cancel: () => {
        if (!live()) return;
        this.open = null;
        this.session.draft(null);
      },
    };
  }

  /** Commits the open panel edit, if any. */
  private finishOpen() {
    const open = this.open;
    if (!open) return;
    this.open = null;
    if (open.edits) void this.commit(open.edits);
    else this.session.draft(null);
  }

  /**
   * Runs a pointer gesture a panel started, on the element that was
   * pressed, the way canvas gestures run: it turns into a drag after a few
   * pixels, shows each frame's edits, commits on release and stops on
   * Escape. Returns a function that stops it.
   */
  drive(e: PointerEvent, element: HTMLElement, run: PanelRun): () => void {
    if (!this.enabled || e.button !== 0 || this.run) return () => {};
    this.finishOpen();
    const press: Press = {
      x: e.clientX,
      y: e.clientY,
      shift: e.shiftKey,
      free: e.metaKey || e.ctrlKey,
      hit: null,
      label: null,
      handle: null,
    };
    // The pointer is captured once the press turns into a drag, so a click
    // or double-click on the panel still reaches what was pressed.
    const listen = new AbortController();
    const { signal } = listen;
    element.addEventListener("pointermove", (m) => this.run && this.onMove(m), { signal });
    element.addEventListener("pointerup", (u) => this.onUp(u), { signal });
    element.addEventListener("pointercancel", () => this.cancel(), { signal });
    element.addEventListener("lostpointercapture", () => run.keep?.() || this.cancel(), { signal });
    const mine = (this.run = {
      run,
      press,
      pointerId: e.pointerId,
      started: false,
      edits: null,
      shown: "null",
      capture: element,
      detach: () => listen.abort(),
    });
    // Stops this gesture if it's still the running one, as when the browser takes the pointer back.
    return () => {
      if (this.run === mine) this.cancel();
    };
  }

  /** Commits `edits` as one undo step, and says why if they're refused. */
  async commit(edits: ReadonlyArray<UserEdit>) {
    const result = await this.session.commit(edits);
    if (result.kind === "refused") this.say(result.message);
  }

  /**
   * What a person can do to `id` with components: make it one, or detach
   * the instance it is. Nothing for an artboard, a component, or a node
   * inside an instance, which only overrides it.
   */
  componentAction(id: string): "make" | "detach" | null {
    const node = id.includes("/") ? undefined : this.session.replica.get(id);
    if (!node || node.type !== "element" || node.parent === null) return null;
    if (node.instanceOf !== undefined) return "detach";
    return node.component ? null : "make";
  }

  /** Makes `id` a component, or detaches it if it's an instance. */
  toggleComponent(id: string) {
    const action = this.componentAction(id);
    if (action === "make") void this.commit([{ kind: "makeComponent", id, name: null }]);
    else if (action === "detach") void this.commit([{ kind: "detach", ids: [id] }]);
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
      artboards: () => this.shownArtboards(),
    };
  }

  /** The artboards on the page that's shown. */
  private shownArtboards(): string[] {
    const replica = this.session.replica;
    const page = this.renderer.shownPage();
    return replica
      .artboards()
      .filter((b) => replica.pageOf(b) === page)
      .map((b) => b.id);
  }

  private onDown(e: PointerEvent) {
    if (!this.enabled || e.button !== 0 || this.run || this.space) return;
    this.finishOpen();
    const target = e.target instanceof Element ? e.target : null;
    if (this.current.editing !== null) {
      // A press in the text being typed into places the caret.
      if (e.composedPath().some((t) => this.renderer.isEditing(t))) return;
      // Anywhere else keeps the text, as leaving the field would; the
      // press below would otherwise keep the focus from moving.
      this.renderer.finishTextEdit();
    }
    const handle = (target?.closest("[data-handle]") as HTMLElement | null)?.dataset.handle;
    // Pins and other controls on the canvas keep their clicks.
    if (!handle && target?.closest("[data-camera-ignore]")) return;
    const label = this.renderer.labelOf(target);
    const hit = label ? null : this.pressable(this.renderer.hitTest(e.clientX, e.clientY));
    const press: Press = {
      x: e.clientX,
      y: e.clientY,
      shift: e.shiftKey,
      free: e.metaKey || e.ctrlKey,
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
   * What a press on the canvas reaches: a locked layer, or one inside a
   * locked layer, lets the press through to what holds it. A locked
   * artboard takes no presses at all. The layers panel still selects them.
   */
  private pressable(hit: Hit | null): Hit | null {
    if (!hit) return null;
    let nodeId = hit.nodeId;
    for (const id of lineage(this.session.replica, hit.nodeId)) {
      const node = nodeOf(this.session.replica, id);
      if (node?.attrs["data-locked"] === undefined) continue;
      if (node.parent === null) return null;
      nodeId = node.parent;
    }
    return nodeId === hit.nodeId ? hit : { ...hit, nodeId };
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
        const hit = this.pressable(this.renderer.hitTest(clientX, clientY));
        if (hit?.nodeId !== this.current.hover) this.update({ hover: hit?.nodeId ?? null });
      });
      return;
    }
    if (e.pointerId !== running.pointerId) return;
    const pointer = pointerOf(e);
    if (!running.started) {
      if (Math.hypot(pointer.x - running.press.x, pointer.y - running.press.y) < DRAG_SLOP) return;
      running.started = true;
      running.capture?.setPointerCapture(running.pointerId);
      this.update({ dragging: true, hover: null });
    }
    // One draft per frame, however many moves arrive.
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => this.step(pointer));
  }

  private step(pointer: Pointer) {
    const running = this.run;
    if (!running) return;
    const { run } = running;
    const edits = running.run.move(pointer);
    const json = JSON.stringify(edits);
    if (json !== running.shown) {
      running.shown = json;
      if (run.live !== false) {
        const outcome = this.session.draft(edits);
        if (outcome.error !== null) {
          this.cancel();
          this.say(outcome.error);
          return;
        }
      }
      running.edits = edits;
    }
    const selection = run.selection?.() ?? null;
    this.update({
      target: run.target?.() ?? null,
      guides: run.guides?.() ?? [],
      area: run.area?.() ?? null,
      ...(selection && { selection }),
    });
  }

  private onUp(e: PointerEvent) {
    const running = this.run;
    if (!running || e.pointerId !== running.pointerId) return;
    cancelAnimationFrame(this.frame);
    if (running.started) this.step(pointerOf(e));
    // The last frame's edits can't be planned, so it cancelled the gesture.
    if (this.run !== running) return;
    this.run = null;
    running.detach?.();
    this.update({ dragging: false, target: null, guides: [], area: null });
    const commit = running.started && running.edits !== null;
    running.run.end?.(commit);
    if (commit) void this.commit(running.edits!);
  }

  /** Stops the running gesture and takes its draft off the screen. */
  private cancel() {
    cancelAnimationFrame(this.frame);
    const running = this.run;
    if (!running) return;
    this.run = null;
    running.detach?.();
    if (running.run.live !== false) this.session.draft(null);
    this.update({ dragging: false, target: null, guides: [], area: null });
    running.run.end?.(false);
  }

  /**
   * Types into the text of the element double-clicked, in place: Enter or
   * a click elsewhere keeps it, Escape puts it back. Only an element that
   * holds nothing but text can be typed into, since typing replaces it all.
   */
  private onDoubleClick(e: MouseEvent) {
    if (!this.enabled || this.run || this.current.editing !== null) return;
    const hit = this.renderer.hitTest(e.clientX, e.clientY);
    if (!hit || hit.nodeId === hit.artboardId) return;
    const id = hit.nodeId;
    const started = this.renderer.editText(id, (text) => {
      this.update({ editing: null });
      if (text !== null) void this.commit([{ kind: "setText", id, text }]);
    });
    if (!started) {
      this.say("Only plain text outside components can be typed into here.");
      return;
    }
    e.preventDefault();
    this.update({ editing: id, selection: [id], hover: null });
  }

  private onKey(e: KeyboardEvent) {
    // Undo works with any tool, and from a panel's field that holds no typing of its own.
    if ((e.metaKey || e.ctrlKey) && !e.altKey && (e.code === "KeyZ" || e.code === "KeyY")) {
      if (this.run || !this.undoes(e)) return;
      e.preventDefault();
      this.undo(e.code === "KeyY" || e.shiftKey);
      return;
    }
    if (!this.enabled || isTyping(e)) return;
    if (e.code === "Space") {
      // Held, it pans; it would scroll or press a focused button otherwise.
      this.space = true;
      e.preventDefault();
      return;
    }
    const mod = e.metaKey || e.ctrlKey;
    const { selection } = this.current;
    if (mod) {
      const command = this.command(e, selection);
      if (command) {
        e.preventDefault();
        command();
      }
      return;
    }
    if (e.altKey) return;
    if (e.key === "Escape") {
      if (this.run) this.cancel();
      else this.selectParent();
      return;
    }
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

  /** The ⌘ (or Ctrl) shortcut `e` runs, if any. */
  private command(e: KeyboardEvent, selection: ReadonlyArray<string>): (() => void) | null {
    const replica = this.session.replica;
    const some = selection.length > 0 && !this.run;
    switch (e.code) {
      case "KeyA":
        return () => this.selectAll();
      case "KeyC":
        return some ? () => (this.copied = [...selection]) : null;
      case "KeyV": {
        const ids = this.copied.filter((id) => replica.get(id) !== undefined);
        return ids.length > 0 && !this.run ? () => this.duplicate(ids) : null;
      }
      case "KeyD":
        return some ? () => this.duplicate(selection) : null;
      case "KeyG":
        return some ? () => (e.shiftKey ? this.ungroup(selection) : this.group(selection)) : null;
      // ⇧⌘H hides and ⇧⌘L locks, as in Figma.
      case "KeyH":
      case "KeyL": {
        if (!some || !e.shiftKey) return null;
        const attr = e.code === "KeyH" ? "hidden" : "data-locked";
        return () => void this.commit([toggleFlag((id) => nodeOf(replica, id), selection, attr)]);
      }
      // ⌥⌘K makes a component and ⌥⌘B detaches an instance, as in Figma.
      case "KeyK":
      case "KeyB": {
        const [id] = selection;
        const want = e.code === "KeyK" ? "make" : "detach";
        if (!e.altKey || selection.length !== 1 || id === undefined || this.run) return null;
        return this.componentAction(id) === want ? () => this.toggleComponent(id) : null;
      }
      case "BracketRight":
      case "BracketLeft": {
        const [id] = selection;
        if (selection.length !== 1 || id === undefined || this.run) return null;
        const up = e.code === "BracketRight";
        return () => this.restack(id, up, e.altKey);
      }
      default:
        return null;
    }
  }

  private undo(redo: boolean) {
    this.finishOpen();
    void (redo ? this.session.redo() : this.session.undo()).then((result) => {
      if (result.kind === "refused") this.say(result.message);
    });
  }

  /**
   * Whether ⌘Z undoes the design rather than text. A field keeps it while
   * something's typed into it, and so does a field inside an artboard. A
   * panel's field that only has focus, like one just scrubbed or a color
   * just picked, lets it go and loses the focus, as in Figma.
   */
  private undoes(e: KeyboardEvent): boolean {
    if (!isTyping(e)) return true;
    const target = e.composedPath()[0];
    if (!(target instanceof HTMLInputElement) || target.getRootNode() !== document) return false;
    if (this.open?.edits || target.value !== target.defaultValue) return false;
    target.blur();
    return true;
  }

  /** Selects everything beside what's selected, or every artboard on the page. */
  private selectAll() {
    const replica = this.session.replica;
    const [first] = this.current.selection;
    const parent = first === undefined ? null : (nodeOf(replica, first)?.parent ?? null);
    const all =
      parent === null
        ? this.shownArtboards()
        : replica
            .children(parent)
            .filter((n) => n.type === "element")
            .map((n) => n.id);
    this.update({ selection: all });
  }

  /** Copies nodes, each right after its original, and selects the copies. */
  private duplicate(ids: ReadonlyArray<string>) {
    const replica = this.session.replica;
    // A node inside another one copied comes along with it, so only the outermost get copies.
    const roots = ids.filter(
      (id) =>
        !lineage(replica, id)
          .slice(1)
          .some((ancestor) => ids.includes(ancestor)),
    );
    const next = (id: string) => replica.siblingsAfter(id).next().value?.id ?? null;
    const before = roots.map(next);
    void this.commit([{ kind: "duplicate", ids: [...roots] }]);
    // The copies show at once, right after their originals, with the ids the server
    // will give them. A sibling that was already there means the copy wasn't made.
    const copies = roots.flatMap((id, i) => {
      const copy = next(id);
      return copy !== null && copy !== before[i] ? [copy] : [];
    });
    if (copies.length > 0) this.update({ selection: copies });
  }

  private group(ids: ReadonlyArray<string>) {
    void this.commit([{ kind: "group", ids: [...ids] }]);
    const group = this.session.replica.get(ids[0]!)?.parent ?? null;
    if (group !== null) this.update({ selection: [group] });
  }

  private ungroup(ids: ReadonlyArray<string>) {
    const replica = this.session.replica;
    const children = ids.flatMap((id) => replica.children(id).map((c) => c.id));
    void this.commit([{ kind: "ungroup", ids: [...ids] }]);
    this.update({ selection: children.filter((id) => replica.get(id) !== undefined) });
  }

  /**
   * Moves a node up or down among its siblings, which is what stacks it
   * over or under them: one step, or with ⌥ all the way.
   */
  private restack(id: string, up: boolean, all: boolean) {
    const replica = this.session.replica;
    const node = nodeOf(replica, id);
    if (!node) return;
    const siblings = replica.children(node.parent);
    const at = siblings.findIndex((s) => s.id === id);
    if (at < 0 || (up ? at === siblings.length - 1 : at === 0)) return;
    const before = up
      ? all
        ? null
        : (siblings[at + 2]?.id ?? null)
      : all
        ? siblings[0]!.id
        : siblings[at - 1]!.id;
    void this.commit([{ kind: "place", ids: [id], parent: node.parent, before }]);
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

const pointerOf = (e: PointerEvent): Pointer => ({
  x: e.clientX,
  y: e.clientY,
  shift: e.shiftKey,
  free: e.metaKey || e.ctrlKey,
});

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
