import type {
  CanvasPatch,
  Frame,
  FrameBridge,
  Hit,
  HitElement,
  Inline,
  Loc,
  NewNode,
  Rect,
  Rev,
  Section,
  SourceEdit,
  Slice,
  TextLabel,
} from "@finite/protocol";
import type { ComponentType } from "react";
import type { Camera } from "@/design/camera";
import type { IconName } from "@/lib/icons";
import type { EditorState, ElementFacts, ObjectSelection } from "../editor";
import type { Point } from "../gestures";
import type { SelectionItem } from "../selection";

export type KeyCombo = {
  /** The key's value, lowercase. */
  key?: string;
  /** The physical key, for keys whose value changes with Shift. */
  code?: string;
  shift?: true;
  mod?: true;
  alt?: true;
  /** Also fires with any other modifiers held. */
  loose?: true;
};

export type KeyInput = Pick<
  KeyboardEvent,
  "key" | "code" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey"
> & { preventDefault?: () => void; repeat?: boolean };

export type Gesture = {
  move(screen: Point, world: Point, e: PointerEvent): void;
  end(commit: boolean): void | Promise<void>;
};

/** What a press does once it's a drag (`begin`) or a click. */
export type PressPlan = {
  begin(): Promise<Gesture | null>;
  click(): void | Promise<void>;
  /** Leaves the pointer to the camera, so a drag pans; a click still counts. */
  passive?: true;
};

/** A press on the canvas, as a tool reads it. */
export type Down = {
  event: PointerEvent;
  target: Element | null;
  world: Point;
  screen: Point;
  shift: boolean;
  /** ⌘ or Ctrl. */
  deep: boolean;
  alt: boolean;
  /** The topmost frame under the press. */
  frame: Frame | null;
};

/** A shape being drawn, in canvas units. Page-level, so it costs no bridge traffic. */
export type Ghost = {
  box: Rect;
  round?: boolean;
  /** An outline drawn instead of the box, in the box's own units. */
  d?: string;
};

/** Where a drawn shape landed. */
export type Placed = { frameId: string; loc: Loc; index: number };

export type ToolGroup = "move" | "frame" | "shape" | "pen" | "text" | "comment";

/** One tool. The toolbar, shortcuts, menu hints and cursors all derive from these. */
export interface ToolDef<Id extends string = string> {
  readonly id: Id;
  readonly group: ToolGroup;
  readonly label: string;
  readonly keys: KeyCombo | null;
  readonly icon: IconName;
  /** The viewport's cursor while the tool is on; empty for the default. */
  readonly cursor: string;
  /** Off until the work behind it lands: hidden from the toolbar and the keys. */
  readonly enabled: boolean;
  /** Stays on after one use. Without it, the tool goes back to Move. */
  readonly sticky?: true;
  /** A mode that's entered from the canvas, never picked from the toolbar. */
  readonly hidden?: true;
  /** Where a drag pans the camera: on the empty canvas, or anywhere. */
  readonly pan?: "empty" | "always";
  /** Outlines what's under the pointer. */
  readonly hover?: true;
  /** A short note the toolbar shows while the tool is on. */
  readonly hint?: string;
  activate?(host: ToolHost): void;
  /** The tool is being left, or the editor closed. */
  deactivate?(host: ToolHost): void;
  /** A press on the canvas; `"pass"` leaves it alone. Without it, every press passes. */
  down?(host: ToolHost, p: Down): PressPlan | "pass";
  doubleClick?(host: ToolHost, e: MouseEvent, target: Element | null): void | Promise<void>;
  /** A key, before the shortcuts. Returns whether it was used. */
  key?(host: ToolHost, e: KeyInput): boolean;
  /** The pointer moved with nothing pressed. */
  pointerMove?(host: ToolHost, e: PointerEvent): void;
  /** The pointer left the canvas. */
  pointerLeave?(host: ToolHost): void;
  /** A frame loaded or applied an HMR update. */
  frameUpdated?(host: ToolHost): void;
  /** The canvas changed: frames may be gone. */
  canvasChanged?(host: ToolHost): void;
  Overlay?: ComponentType<{ host: ToolHost; state: EditorState }>;
}

/** What tools ask of the canvas editor. */
export interface ToolHost {
  readonly designId: string;
  readonly canvasId: string;
  readonly camera: Camera;
  readonly state: EditorState;
  readonly frames: readonly Frame[];
  readonly texts: readonly TextLabel[];
  readonly sections: readonly Section[];
  readonly slices: readonly Slice[];
  readonly facts: Map<string, ElementFacts>;
  /** A press is down on the canvas. */
  readonly pressing: boolean;
  frame(id: string): Frame | undefined;
  frameAt(p: Point): Frame | null;
  boxOf(f: Frame): Rect;
  local(f: Frame, p: Point): Point;
  worldOf(e: { clientX: number; clientY: number }): Point;
  bridge(frameId: string): FrameBridge | undefined;
  /** The file a frame renders, when the router names one. */
  ownFile(f: Frame): string | undefined;
  update(patch: Partial<EditorState>): void;
  /** Pointer capture and drag slop, for overlay handles marked data-canvas-ui. */
  press(e: PointerEvent, plan: PressPlan): void;
  /** Adds a shape where `box` lands: picks the target, places it, selects it. */
  draw(input: {
    box: Rect;
    node: NewNode;
    deep?: boolean;
    alt?: boolean;
    /** The sides the new element takes from its content, not the box. */
    hug?: readonly ("width" | "height")[];
  }): Promise<Placed | null>;
  edit(
    edits: SourceEdit[],
    chain?: readonly HitElement[],
  ): Promise<{ created: Record<string, Loc> } | false>;
  /** The element's children as editable runs, and the rev they belong to. */
  readInline(loc: Loc): Promise<{
    rev: Rev;
    content: Inline[];
    keeps: { id: number; kind: string; label: string; loc?: Loc | undefined }[];
  }>;
  patch(p: CanvasPatch): Promise<void>;
  say(text: string): void;
  select(items: SelectionItem[]): void;
  selectHit(
    frameId: string,
    hit: Hit | HitElement,
    index: number,
    path: HitElement[],
  ): SelectionItem;
  selectText(id: string | null): void;
  /** Picks a section or slice, or nothing. */
  selectObject(picked: ObjectSelection | null): void;
  frameItem(frameId: string): SelectionItem;
  refreshSelection(): Promise<void>;
  setTool(id: string): void;
  setGhost(g: Ghost | null): void;
  // What the built-in shortcuts run.
  setSpace(on: boolean): void;
  escape(): void;
  undo(which: "undo" | "redo"): Promise<void>;
  duplicate(): Promise<void>;
  remove(): Promise<void>;
  fitAll(): void;
  fitSelection(): void;
}

/** A `down` for a tool whose work hasn't landed; unreachable while the tool is hidden. */
export const notBuilt =
  (what: string) =>
  (host: ToolHost): "pass" => {
    host.say(`${what} isn't built yet.`);
    return "pass";
  };
