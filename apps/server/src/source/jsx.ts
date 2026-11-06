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

/** The sibling children that aren't whitespace. */
export function siblings(parent: t.JSXElement | t.JSXFragment): t.Node[] {
  return parent.children.filter((child) => !isWhitespaceText(child));
}
