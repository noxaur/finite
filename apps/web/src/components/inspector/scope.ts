import { type Reading, readStyle, tokenOf } from "@/design/editing/inspect";
import type { TokenTable } from "@/design/types";
import { rotationOf, type TransformStyles, withSheet } from "@/design/editing/transform";
import { isColor, resolveToken } from "@/lib/tokens";
import type { Draft, StyleEditor, StyleEdit, Target } from "./styleEditor";

export type { Draft, StyleEdit, Target };
export type Editor = StyleEditor;
export type Node = Target;
export type UserEdit = StyleEdit;

export type Changes = Readonly<Record<string, string | null>>;

/** What every field in one render reads and writes. */
export interface Scope {
  /** The elements the fields edit: the selection, with text nodes standing for their element. */
  readonly targets: ReadonlyArray<Node>;
  /** Whether every target is a text layer, so a drop shadow writes `text-shadow`. */
  readonly text: boolean;
  /** The browser's styles on the first target, where they can be read. */
  readonly computed: CSSStyleDeclaration | null;
  /** The browser's styles on any node, like a target's parent, where they can be read. */
  readonly computedOf: (id: string) => CSSStyleDeclaration | null;
  readonly tokens: TokenTable;
  /** The mode the first target's artboard renders in, to resolve tokens. */
  readonly mode: string;
  readonly editor: Editor;
  /** The edits that set `styles` on every target, each into the shorthand it already uses. */
  readonly edits: (styles: Changes) => UserEdit[];
  /** Like `edits`, with each target's own styles: for lists, where each keeps its own entries. */
  readonly editsEach: (styles: (target: Node) => Changes) => UserEdit[];
  readonly commit: (styles: Changes) => void;
  readonly commitEach: (styles: (target: Node) => Changes) => void;
}

/** Longhands a shorthand sets through a token, which only the browser can read back. */
const FONT_PARTS = new Set([
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "line-height",
]);

export const readOf = (scope: Scope, prop: string): Reading => {
  const reading = readStyle(scope.targets, prop, scope.computed?.getPropertyValue(prop) || null);
  // None of them sets it, but the browser draws it differently on some.
  if (reading.kind === "computed" && scope.targets.length > 1) {
    const drawn = scope.targets.map((t) => scope.computedOf(t.id)?.getPropertyValue(prop));
    if (drawn.some((v) => v !== reading.raw)) return { kind: "mixed" };
  }
  // `font: var(--t-body)` sets these on the element itself, so they read as its own.
  if (
    reading.kind === "computed" &&
    FONT_PARTS.has(prop) &&
    scope.targets.every((t) => t.styles.font !== undefined)
  ) {
    return { kind: "value", raw: reading.raw, token: null };
  }
  return reading;
};

/** Two longhands as one reading, like a box's left and right: `mixed` when they differ. */
export const pairOf = (scope: Scope, props: readonly [string, string]): Reading => {
  const [a, b] = props.map((p) => readOf(scope, p)) as [Reading, Reading];
  if (a.kind === "mixed" || b.kind === "mixed" || a.kind !== b.kind) return { kind: "mixed" };
  if (a.kind === "unset" || rawOf(a) === rawOf(b)) return a;
  return { kind: "mixed" };
};

/** The CSS a reading stands for, set inline or drawn by the browser. */
export const rawOf = (reading: Reading): string | undefined =>
  reading.kind === "value" || reading.kind === "computed" ? reading.raw : undefined;

export const isPainted = (raw: string | undefined, none: string) =>
  raw !== undefined && raw !== none && raw !== "transparent" && raw !== "rgba(0, 0, 0, 0)";

/** What removing a style does: take the inline one off, or cover what a sheet draws. */
export const removal = (reading: Reading, none: string): string | null =>
  reading.kind === "computed" ? none : null;

/** Whether any target sets `prop` inline. */
export const owns = (scope: Scope, prop: string) =>
  scope.targets.some((t) => t.styles[prop] !== undefined);

/** A token's value in the artboard's mode. */
export const resolve = (scope: Scope, name: string) => resolveToken(scope.tokens, name, scope.mode);

/** A color as the swatch draws it, its token resolved. */
export function swatchOf(scope: Scope, color: string): string | undefined {
  const token = tokenOf(color);
  const value = token ? resolve(scope, token) : color;
  return isColor(value) ? value : undefined;
}

export type TokenKind = "color" | "length" | "shadow" | "font" | "family";

/** Tokens whose value in the artboard's mode fits `kind`, as [name, value]. */
export function matchingTokens(scope: Scope, kind: TokenKind): Array<[string, string]> {
  const length = (v: string) => /^-?\d*\.?\d+(px|r?em|%)?$/.test(v.trim());
  const fits = (v: string) => {
    if (typeof CSS === "undefined") return false;
    switch (kind) {
      case "color":
        return isColor(v);
      case "length":
        return length(v);
      case "shadow":
        return !isColor(v) && !length(v) && v !== "none" && CSS.supports("box-shadow", v);
      case "font":
        return /\d/.test(v) && CSS.supports("font", v);
      case "family":
        return !/\d/.test(v) && !isColor(v) && CSS.supports("font-family", v);
    }
  };
  return Object.keys(scope.tokens.tokens)
    .map((name): [string, string | undefined] => [name, resolve(scope, name)])
    .filter((t): t is [string, string] => t[1] !== undefined && fits(t[1]));
}

const TRANSFORM_PROPS = ["translate", "rotate", "scale", "transform"] as const;

/**
 * What classes or the browser set for the transform properties `target`
 * doesn't set inline (the first target when none is named), so the
 * controls read them and an edit only covers what they showed.
 */
export function transformSheet(
  scope: Scope,
  target: Node | undefined = scope.targets[0],
): TransformStyles {
  const out: Record<string, string> = {};
  const computed = target ? scope.computedOf(target.id) : scope.computed;
  for (const prop of TRANSFORM_PROPS) {
    if (target?.styles[prop] !== undefined) continue;
    const value = computed?.getPropertyValue(prop);
    if (value) out[prop] = value;
  }
  return out;
}

/**
 * The selection's rotation in degrees, from `rotate` or a `transform` it
 * folds out of, inline or from a class; `"mixed"` when the targets
 * differ, `null` when the controls can't say. Position and Transform both
 * read and write it here.
 */
export function readRotation(scope: Scope): number | "mixed" | null {
  const all = new Set(
    scope.targets.map((t) => rotationOf(withSheet(t.styles, transformSheet(scope, t)))),
  );
  return all.size > 1 ? "mixed" : ([...all][0] ?? null);
}

/**
 * `scope` for fields whose changes depend on each target's own styles,
 * like one axis of a `translate`: a field's changes are what it means
 * (`{ x: "10px" }`), and `styles` turns them into each target's styles.
 */
export function perTarget(
  scope: Scope,
  styles: (target: Node, changes: Changes) => Changes,
): Scope {
  const edits = (changes: Changes) => scope.editsEach((t) => styles(t, changes));
  return {
    ...scope,
    edits,
    commit: (changes) => void scope.editor.commit(edits(changes)),
  };
}
