import type { Outset } from "./outset";

/** A box on the canvas or the page, as the camera, the culler and the renderer pass it around. */
export interface Bounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** How far the node's strokes reach past the box, from a sandboxed artboard. */
  readonly outset?: Outset;
}

/**
 * What the live DOM says about one drawn element, which a person's edit
 * needs to turn a drag into CSS: the document only holds inline styles,
 * and the cascade (`<style>` blocks, classes, the shared CSS) decides the rest.
 */
export interface Measured {
  /** The border box, in page pixels. */
  readonly rect: DOMRect;
  /** Page pixels per CSS pixel of the artboard: the camera's zoom. */
  readonly scale: number;
  readonly position: string;
  readonly display: string;
  readonly flexDirection: string;
  readonly flexWrap: string;
  readonly flexGrow: number;
  /**
   * With `box-sizing: content-box`, the padding and borders across and
   * down, in CSS pixels, which `width` and `height` leave out. 0 for `border-box`.
   */
  readonly frameX: number;
  readonly frameY: number;
  /** Resolved insets in CSS pixels, `NaN` for `auto`. */
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** The artboard, and the deepest element in it, under a point. */
export interface Hit {
  readonly artboardId: string;
  /** For a sandboxed artboard, the artboard itself until its iframe answers. */
  readonly nodeId: string;
}
