import { parse } from "@babel/parser";
import type * as t from "@babel/types";
import { Refused } from "@finite/protocol";

/** A JSX element and the node it sits in, found by its `<` position. */
export type Element = { node: t.JSXElement; parent: t.Node | undefined };

export type Parsed = {
  ast: t.File;
  /** Keyed `line:col` (1-based line, 0-based col of the `<`), the position the Vite plugin stamps. */
  elements: Map<string, Element>;
};

export function parseModule(code: string, file: string): t.File {
  try {
    return parse(code, {
      sourceType: "module",
      plugins: ["typescript", "jsx"],
    }) as unknown as t.File;
  } catch (error) {
    throw new Refused(
      `${file} doesn't parse (${(error as Error).message}). Fix the file, then try again.`,
      "invalid",
    );
  }
}

export function parseTsx(code: string, file: string): Parsed {
  const ast = parseModule(code, file);
  const elements = new Map<string, Element>();
  walk(ast, (node, parent) => {
    if (node.type !== "JSXElement") return;
    const start = node.openingElement.loc!.start;
    elements.set(`${start.line}:${start.column}`, { node, parent });
  });
  return { ast, elements };
}

const SKIP = new Set([
  "loc",
  "start",
  "end",
  "extra",
  "range",
  "leadingComments",
  "trailingComments",
  "innerComments",
  "comments",
  "tokens",
]);

/** Visits every node depth-first with its parent. */
export function walk(
  root: t.Node,
  visit: (node: t.Node, parent: t.Node | undefined) => void,
): void {
  const stack: [t.Node, t.Node | undefined][] = [[root, undefined]];
  while (stack.length > 0) {
    const [node, parent] = stack.pop()!;
    visit(node, parent);
    const children: t.Node[] = [];
    for (const key of Object.keys(node)) {
      if (SKIP.has(key)) continue;
      const value = (node as unknown as Record<string, unknown>)[key];
      if (Array.isArray(value)) {
        for (const item of value) if (isNode(item)) children.push(item);
      } else if (isNode(value)) children.push(value);
    }
    for (let i = children.length - 1; i >= 0; i--) stack.push([children[i]!, node]);
  }
}

function isNode(value: unknown): value is t.Node {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { type?: unknown }).type === "string"
  );
}

export function tagName(name: t.JSXOpeningElement["name"]): string {
  if (name.type === "JSXIdentifier") return name.name;
  if (name.type === "JSXNamespacedName") return `${name.namespace.name}:${name.name.name}`;
  return `${tagName(name.object as t.JSXOpeningElement["name"])}.${name.property.name}`;
}

export function attribute(el: t.JSXElement, name: string): t.JSXAttribute | undefined {
  for (const attr of el.openingElement.attributes) {
    if (
      attr.type === "JSXAttribute" &&
      attr.name.type === "JSXIdentifier" &&
      attr.name.name === name
    ) {
      return attr;
    }
  }
  return undefined;
}

/** Where a new attribute goes: after the last attribute, or after the tag name. */
export function attributeInsertAt(el: t.JSXElement): number {
  const opening = el.openingElement;
  const last = opening.attributes.at(-1);
  return last ? last.end! : (opening.typeArguments ?? opening.name).end!;
}

/** True when the element sits among JSX children, so it can be moved, removed or copied as a sibling. */
export function isChild(
  element: Element,
): element is { node: t.JSXElement; parent: t.JSXElement | t.JSXFragment } {
  return element.parent?.type === "JSXElement" || element.parent?.type === "JSXFragment";
}

export function isWhitespaceText(node: t.Node | undefined): node is t.JSXText {
  return node?.type === "JSXText" && node.value.trim() === "";
}

/** The element plus the whitespace-only text before it: the unit that moves when siblings reorder. */
export function slot(
  parent: t.JSXElement | t.JSXFragment,
  el: t.JSXElement,
): { start: number; end: number } {
  const i = parent.children.indexOf(el);
  const before = parent.children[i - 1];
  return { start: isWhitespaceText(before) ? before.start! : el.start!, end: el.end! };
}

/** `element` as a JSX child, or a refusal saying why it can't have `what` done to it. */
export function asChild(element: Element, what: string) {
  if (!isChild(element)) {
    throw new Refused(
      `This element is a component's root or sits inside code, so Finite can't ${what} it by hand. Ask the agent to change this.`,
      "unsupported-style",
    );
  }
  return element;
}

/** The whitespace that starts the line `offset` is on. */
export function indentAt(code: string, offset: number): string {
  const lineStart = code.lastIndexOf("\n", offset - 1) + 1;
  return /^[ \t]*/.exec(code.slice(lineStart))![0];
}

/** `value` as JSX children: bare text when that's safe, else a string expression. */
export function jsxText(value: string): string {
  return value === "" || /[{}<>&\n]/.test(value) || value !== value.trim()
    ? `{${JSON.stringify(value)}}`
    : value;
}

/** `value` as the right side of a JSX attribute. */
export function attrText(value: string): string {
  return /["\n]/.test(value) ? `{${JSON.stringify(value)}}` : `"${value}"`;
}

/** The sibling children that aren't whitespace. */
export function siblings(parent: t.JSXElement | t.JSXFragment): t.Node[] {
  return parent.children.filter((child) => !isWhitespaceText(child));
}

/** Where to point at an element: a 1-based line, a 0-based column, and/or text it shows. */
export type Near = { line?: number | undefined; column?: number | undefined; match?: string };

type Candidate = {
  node: t.JSXElement;
  tag: string;
  intrinsic: boolean;
  line: number;
  column: number;
  text: string;
};

/**
 * The stamped loc (`file:line:col`, the column of the `<`) of the HTML element `near` points at:
 * the one whose tag starts there, else whose opening tag holds the position (a column off by one
 * still lands), else the one on `line` or showing `match`. Only intrinsic (lowercase) elements are
 * stamped, so only they can be pinned. Refuses with the elements nearby when none fits.
 */
export function snapLoc(code: string, file: string, near: Near): string {
  const all: Candidate[] = [];
  walk(parseModule(code, file), (node) => {
    if (node.type !== "JSXElement") return;
    const opening = node.openingElement;
    const tag = tagName(opening.name);
    all.push({
      node,
      tag,
      intrinsic: opening.name.type === "JSXIdentifier" && /^[a-z]/.test(tag),
      line: opening.loc!.start.line,
      column: opening.loc!.start.column,
      text: shownText(node),
    });
  });
  const html = all.filter((c) => c.intrinsic);
  const at = (c: Candidate) => `${file}:${c.line}:${c.column}`;
  const innermost = (list: Candidate[]) =>
    list.reduce<Candidate | undefined>(
      (best, c) => (!best || c.node.start! >= best.node.start! ? c : best),
      undefined,
    );
  const { line, column } = near;
  const match = near.match?.trim().toLowerCase();
  const shows = (c: Candidate) => !match || c.text.toLowerCase().includes(match);

  if (line !== undefined && column !== undefined) {
    const offset = offsetOf(code, line, column);
    const inTag = innermost(
      all.filter(
        (c) => c.node.openingElement.start! <= offset && offset < c.node.openingElement.end!,
      ),
    );
    const inElement =
      inTag ?? innermost(all.filter((c) => c.node.start! <= offset && offset < c.node.end!));
    if (inElement?.intrinsic) return at(inElement);
    if (inElement) {
      throw new Refused(
        `<${inElement.tag}> at ${file}:${inElement.line}:${inElement.column} is a component; comments pin to HTML elements. ${nearby(html, file, line)}`,
        "invalid",
      );
    }
  }
  if (line !== undefined) {
    const onLine = html.filter((c) => c.line === line && shows(c));
    if (onLine[0]) return at(onLine[0]);
    // A multi-line opening tag, or an element whose content is on that line.
    const spanning = innermost(
      html.filter(
        (c) => c.node.loc!.start.line <= line && line <= c.node.loc!.end.line && shows(c),
      ),
    );
    if (spanning && !match) return at(spanning);
  }
  if (match) {
    const shown = html.filter(shows);
    const distance = (c: Candidate) => (line === undefined ? 0 : Math.abs(c.line - line));
    const best = shown.sort(
      (a, b) =>
        distance(a) - distance(b) || a.node.end! - a.node.start! - (b.node.end! - b.node.start!),
    )[0];
    if (best) return at(best);
  }
  const where =
    line === undefined ? "" : ` at line ${line}${column === undefined ? "" : `, column ${column}`}`;
  const what = match ? ` showing "${near.match}"` : "";
  throw new Refused(
    `There's no HTML element${where}${what} in ${file}. ${nearby(html, file, line)}`,
    "invalid",
  );
}

function offsetOf(code: string, line: number, column: number): number {
  let offset = 0;
  for (let l = 1; l < line; l++) {
    const next = code.indexOf("\n", offset);
    if (next === -1) return code.length;
    offset = next + 1;
  }
  return offset + column;
}

/** The text an element shows itself: its own text children and labelling attributes. */
function shownText(el: t.JSXElement): string {
  const parts: string[] = [];
  for (const child of el.children) {
    if (child.type === "JSXText" && child.value.trim()) parts.push(child.value.trim());
    if (child.type === "JSXExpressionContainer" && child.expression.type === "StringLiteral") {
      parts.push(child.expression.value);
    }
  }
  for (const name of ["alt", "aria-label", "title", "placeholder", "data-name"]) {
    const value = attribute(el, name)?.value;
    if (value?.type === "StringLiteral") parts.push(value.value);
  }
  return parts.join(" ").replace(/\s+/g, " ");
}

function nearby(html: Candidate[], file: string, line: number | undefined): string {
  if (html.length === 0)
    return `${file} has no HTML elements to pin to; leave loc out to pin the frame.`;
  const close = [...html]
    .sort((a, b) => (line === undefined ? 0 : Math.abs(a.line - line) - Math.abs(b.line - line)))
    .slice(0, 6)
    .sort((a, b) => a.node.start! - b.node.start!)
    .map(
      (c) => `<${c.tag}> ${file}:${c.line}:${c.column}${c.text ? ` "${c.text.slice(0, 30)}"` : ""}`,
    );
  return `Elements ${line === undefined ? "in the file" : "near there"}: ${close.join(", ")}.`;
}
