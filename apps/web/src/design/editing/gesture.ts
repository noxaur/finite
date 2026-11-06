import type { Hit, Measured } from "../renderer";
import type { Replica } from "../replica";
import type { UserEdit } from "../schema";
import type { Box, Guide, Handle, Point } from "./geometry";

/**
 * A way for a person to edit the canvas with the pointer. To add one,
 * write a `Gesture` in `gestures/` and list it in `gestures/index.ts`.
 *
 * A gesture never touches the DOM, the document or the server. It turns
 * the pointer into `UserEdit`s, and the `Editor` shows them as a draft
 * (planned by the same Rust function the server runs, so what the person
 * sees while dragging is the real result, reflow and all), then commits
 * them as one undo step when the pointer comes up.
 */
export interface Gesture {
  /** Takes the press, or returns `null` to leave it to the next gesture. Read what the run needs now. */
  begin(press: Press, ctx: EditContext): Run | null;
}

/** One gesture from press to release. */
export interface Run {
  /** The edits the pointer means now, from where it was pressed. `null`: none, it's back where it started. */
  move(pointer: Pointer): ReadonlyArray<UserEdit> | null;
  /** A node to outline while it runs, like the container a move drops into. */
  target?(): string | null;
  /** The guides the last move snapped to, in page pixels. */
  guides?(): ReadonlyArray<Guide>;
  /** A box to draw, in page pixels, like a selection box. */
  area?(): Box | null;
  /** What the gesture selects now, for one that selects instead of editing. */
  selection?(): ReadonlyArray<string> | null;
}

/** The pointer, in page pixels. */
export interface Pointer extends Point {
  readonly shift: boolean;
  /** ⌘ or Ctrl is held, which turns snapping off. */
  readonly free: boolean;
}

export interface Press extends Pointer {
  /** What's drawn under the pointer. */
  readonly hit: Hit | null;
  /** The artboard whose name label was pressed. */
  readonly label: string | null;
  /** The selection's resize handle that was pressed. */
  readonly handle: Handle | null;
}

/** What a gesture can read. The selection is already updated for the press. */
export interface EditContext {
  readonly replica: Replica;
  readonly selection: ReadonlyArray<string>;
  /** Live DOM facts about a drawn element. */
  measure(id: string): Measured | null;
  /** Where a node is drawn, in page pixels. */
  rect(id: string): DOMRect | null;
  hitTest(x: number, y: number): Hit | null;
  /** Canvas units per page pixel: one over the zoom. */
  readonly canvasPerPixel: number;
  /** The artboards on the page that's shown, in order. */
  artboards(): ReadonlyArray<string>;
}
