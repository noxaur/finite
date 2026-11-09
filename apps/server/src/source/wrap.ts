import type * as t from "@babel/types";
import { type NewNode, Refused } from "@finite/protocol";
import {
  asChild,
  attribute,
  type Element,
  indentAt,
  isChild,
  isWhitespaceText,
  slot,
  walk,
} from "./jsx.ts";
import { type InsertStep, print, printing, type Printed } from "./insert.ts";

const ASK = "Ask the agent to change this.";

/** Whether a line starting at `offset` starts inside a string, where added spaces would show. */
function inLiteral(s: InsertStep): (offset: number) => boolean {
  const spans: Array<[number, number]> = [];
  walk(s.parsed.ast, (node) => {
    if (node.type === "StringLiteral" || node.type === "TemplateElement")
      spans.push([node.start!, node.end!]);
  });
  return (offset) => spans.some(([from, to]) => offset > from && offset < to);
}

/** The start of every line that begins inside `[from, to)`, and isn't blank. */
function linesIn(code: string, from: number, to: number): number[] {
  const out: number[] = [];
  for (let i = code.indexOf("\n", from); i !== -1 && i < to; i = code.indexOf("\n", i + 1)) {
    if (code[i + 1] !== "\n" && i + 1 < to) out.push(i + 1);
  }
  return out;
}

const startsLine = (code: string, offset: number) =>
  code.slice(code.lastIndexOf("\n", offset - 1) + 1, offset).trim() === "";

/**
 * Puts `elements` inside a new `wrapper`, which takes the place of the first of them. They must be
 * siblings in JSX. A selected element that isn't next to the others is moved beside them, and
 * what stood between them stays after the wrapper. Children on their own lines are indented, so
 * the file keeps its shape; strings aren't touched, since spaces in them would show.
 */
export function wrap(s: InsertStep, elements: Element[], wrapper: NewNode): Printed[] {
  const children = elements.map((e) => asChild(e, "wrap"));
  const parent = children[0]!.parent;
  if (children.some((c) => c.parent !== parent)) {
    throw new Refused(
      `Only elements side by side in one parent can be wrapped together. ${ASK}`,
      "unsupported-style",
    );
  }
  const ordered = [...children].sort((a, b) => a.node.start! - b.node.start!);
  const first = ordered[0]!;
  let run = first;
  for (const child of ordered.slice(1)) {
    const between = parent.children.slice(
      parent.children.indexOf(run.node) + 1,
      parent.children.indexOf(child.node),
    );
    if (!between.every(isWhitespaceText)) break;
    run = child;
  }
  for (const child of ordered.slice(ordered.indexOf(run) + 1)) {
    const from = slot(parent, child.node);
    s.ms.move(from.start, from.end, run.node.end!);
  }

  const out = printing(s, first.node);
  const last = ordered.at(-1)!;
  const indent = indentAt(s.code, first.node.start!);
  const unit = indent.includes("\t") ? "\t" : "  ";
  const printed = print(s, wrapper, indent, out);
  const open = `${printed.slice(0, -" />".length)}>`;
  const close = `</${wrapper.tag}>`;
  if (!startsLine(s.code, first.node.start!)) {
    s.ms.appendLeft(first.node.start!, open);
    s.ms.appendLeft(last.node.end!, close);
    return out.nodes;
  }
  s.ms.appendLeft(first.node.start!, `${open}\n${indent}${unit}`);
  s.ms.appendLeft(last.node.end!, `\n${indent}${close}`);
  const literal = inLiteral(s);
  for (const [i, child] of ordered.entries()) {
    const from = i === 0 ? child.node.start! : slot(parent, child.node).start;
    for (const line of linesIn(s.code, from, child.node.end!))
      if (!literal(line)) s.ms.appendLeft(line, unit);
  }
  return out.nodes;
}

/**
 * Replaces the element with its children, one indent level out. A component's root or an element
 * inside code can't turn into several siblings, so there it needs exactly one child element.
 */
export function unwrap(s: InsertStep, element: Element): void {
  const el = element.node;
  const kids = el.children.filter((k) => !isWhitespaceText(k));
  if (!isChild(element)) {
    if (kids.length !== 1 || kids[0]!.type !== "JSXElement")
      throw new Refused(
        `This element is a component's root or sits inside code, and it holds more than one element. Removing it would leave nothing to return. ${ASK}`,
        "unsupported-style",
      );
    if (attribute(el, "key"))
      throw new Refused(
        `This element's key says which item of a list it is, and removing it would lose that. ${ASK}`,
        "unsupported-style",
      );
  }
  if (kids.length === 0) {
    const range = slot(asChild(element, "remove").parent, el);
    s.ms.remove(range.start, range.end);
    return;
  }
  const first = kids[0] as t.Node;
  const last = kids.at(-1) as t.Node;
  s.ms.remove(el.start!, first.start!);
  s.ms.remove(last.end!, el.end!);
  if (!startsLine(s.code, first.start!)) return;
  const inner = indentAt(s.code, first.start!);
  const drop = inner.length - indentAt(s.code, el.start!).length;
  if (drop <= 0) return;
  const literal = inLiteral(s);
  for (const line of linesIn(s.code, first.start!, last.end!)) {
    if (literal(line)) continue;
    const space = /^[ \t]*/.exec(s.code.slice(line))![0].length;
    if (space > 0) s.ms.remove(line, line + Math.min(space, drop));
  }
}
