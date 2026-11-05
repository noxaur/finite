import type { Node } from "../schema";

/**
 * What one style field shows for the selection. Only inline styles are the
 * selection's own: an edit writes them, and only they keep `var(--token)`.
 * When none of the selection sets the property, the browser's value shows
 * faintly instead, and is never written back.
 */
export type Reading =
  /** Every node sets it to `raw`. `token` is the name when `raw` is a whole `var(--name)`. */
  | { readonly kind: "value"; readonly raw: string; readonly token: string | null }
  /** Nobody sets it; the browser draws `raw` (from classes, `<style>` blocks or defaults). */
  | { readonly kind: "computed"; readonly raw: string }
  /** Nobody sets it, and the browser can't say: a script artboard, or a hidden one. */
  | { readonly kind: "unset" }
  /** The nodes disagree. Typing a value sets it on all of them. */
  | { readonly kind: "mixed" };

/** `var(--surface)` → `--surface`. A fallback or anything around it shows as plain CSS. */
export function tokenOf(raw: string): string | null {
  return raw.match(/^\s*var\(\s*(--[\w-]+)\s*\)\s*$/)?.[1] ?? null;
}

/**
 * Reads `prop` across `nodes`' inline styles, or `computed`, the browser's
 * value on the first node, when none of them sets it.
 */
export function readStyle(
  nodes: ReadonlyArray<Pick<Node, "styles">>,
  prop: string,
  computed: string | null,
): Reading {
  const values = new Set(nodes.map((n) => n.styles[prop]));
  if (values.size > 1) return { kind: "mixed" };
  const [raw] = values;
  if (raw !== undefined) return { kind: "value", raw, token: tokenOf(raw) };
  return computed ? { kind: "computed", raw: computed } : { kind: "unset" };
}

/** Properties whose bare numbers mean pixels. */
const LENGTHS = new Set([
  "gap",
  "row-gap",
  "column-gap",
  "padding",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "border-width",
  "border-radius",
  "font-size",
  "letter-spacing",
  "width",
  "height",
]);

/**
 * What typing `text` into `prop`'s field sets: `null` (empty) takes the
 * inline style off, a bare number on a length gets `px`, and a token name
 * becomes `var(--name)`. Anything else is CSS as typed; the browser decides
 * what it means, as it does for agents' edits.
 */
export function parseInput(prop: string, text: string): string | null {
  const value = text.trim().replace(/;+$/, "");
  if (value === "") return null;
  if (/^--[\w-]+$/.test(value)) return `var(${value})`;
  if (LENGTHS.has(prop) && /^-?\d*\.?\d+$/.test(value)) return `${value}px`;
  return value;
}

/** How a field shows a reading: the token's name, the value, or a placeholder. */
export function shown(reading: Reading): { text: string; placeholder: string } {
  switch (reading.kind) {
    case "value":
      return { text: reading.token ?? reading.raw, placeholder: "" };
    case "computed":
      return { text: "", placeholder: reading.raw };
    case "mixed":
      return { text: "", placeholder: "Mixed" };
    case "unset":
      return { text: "", placeholder: "" };
  }
}

export type LayoutKind = "block" | "column" | "row" | "grid";

/** Which layout `display` and `flex-direction` make. */
export function layoutOf(display: string, direction: string): LayoutKind {
  if (display === "grid" || display === "inline-grid") return "grid";
  if (display === "flex" || display === "inline-flex") {
    return direction.startsWith("column") ? "column" : "row";
  }
  return "block";
}

/** The styles that make an element lay its children out as `kind`. */
export function layoutStyles(kind: LayoutKind): Record<string, string | null> {
  switch (kind) {
    // Explicit, so it wins over a class that makes it flex or grid.
    case "block":
      return { display: "block", "flex-direction": null };
    case "column":
      return { display: "flex", "flex-direction": "column" };
    case "row":
      return { display: "flex", "flex-direction": "row" };
    case "grid":
      return { display: "grid", "flex-direction": null };
  }
}

const ALIGN = ["flex-start", "center", "flex-end"] as const;

/** Where `justify-content` and `align-items` put the children, as a column and row of a 3×3 grid. */
export function alignCell(
  kind: "row" | "column",
  justify: string,
  align: string,
): { x: number; y: number } | null {
  const at = (v: string) => {
    if (v === "start" || v === "left" || v === "normal" || v === "stretch" || v === "") return 0;
    const i = ALIGN.indexOf(v as (typeof ALIGN)[number]);
    return i === -1 ? (v === "end" || v === "right" ? 2 : -1) : i;
  };
  const main = at(justify);
  const cross = at(align);
  if (main === -1 || cross === -1) return null;
  return kind === "row" ? { x: main, y: cross } : { x: cross, y: main };
}

/** The styles that put children in cell (`x`, `y`) of the 3×3 align grid. */
export function alignStyles(kind: "row" | "column", x: number, y: number): Record<string, string> {
  const [main, cross] = kind === "row" ? [x, y] : [y, x];
  return { "justify-content": ALIGN[main]!, "align-items": ALIGN[cross]! };
}

/**
 * Inline styles as CSS declarations, one per line, and back. Reading the
 * text returns every change to make: new or changed values, and `null` for
 * properties that were taken out.
 */
export function declarations(styles: Readonly<Record<string, string>>): string {
  return Object.entries(styles)
    .map(([prop, value]) => `${prop}: ${value};`)
    .join("\n");
}

export function parseDeclarations(
  text: string,
  before: Readonly<Record<string, string>>,
): Record<string, string | null> {
  const after: Record<string, string> = {};
  for (const line of splitDeclarations(text)) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const name = line.slice(0, colon).trim();
    // Custom properties are case-sensitive; the rest aren't.
    const prop = name.startsWith("--") ? name : name.toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (/^(--[\w-]+|-?[a-z][\w-]*)$/i.test(prop) && value !== "") after[prop] = value;
  }
  const changes: Record<string, string | null> = {};
  for (const [prop, value] of Object.entries(after)) {
    if (before[prop] !== value) changes[prop] = value;
  }
  for (const prop of Object.keys(before)) if (!(prop in after)) changes[prop] = null;
  return changes;
}

/**
 * Splits at `;` and line breaks outside quotes, comments and brackets, so
 * `url("data:…;base64,…")` and a comment holding `;` stay whole.
 */
function splitDeclarations(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 1;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "(" || c === "[" || c === "{") depth++;
    else if ((c === ")" || c === "]" || c === "}") && depth > 0) depth--;
    else if ((c === ";" || c === "\n") && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}
