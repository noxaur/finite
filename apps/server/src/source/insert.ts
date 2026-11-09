import type * as t from "@babel/types";
import path from "node:path";
import {
  type InsertPlace,
  NEW_TAG,
  type NewNode,
  Refused,
  type Router,
  type Styling,
} from "@finite/protocol";
import type MagicString from "magic-string";
import postcss from "postcss";
import { cssModules } from "./imports.ts";
import {
  asChild,
  attribute,
  attrText,
  indentAt,
  isChild,
  jsxText,
  type Element,
  type Parsed,
  tagName,
  walk,
} from "./jsx.ts";
import { head, shadowed } from "./stylex.ts";

/** A printed element, in document order: its key in the position map, and what styles it. */
export type Printed = { key: string; tag: string; styles: Record<string, string> };

/** The parts of the rewrite step that printing and placing a new element read. */
export type InsertStep = {
  ms: MagicString;
  code: string;
  file: string;
  parsed: Parsed;
  files: Record<string, string>;
  convention: Styling;
  router: Router | undefined;
};

/** Elements with no children, so nothing can go inside them. */
export const VOID = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);
const ATTR_NAME = /^[A-Za-z_][\w:.-]*$/;
/** Attributes a string can't set: styling goes through `styles`, and the rest need an expression. */
/** A CSS property as it's printed unquoted into an object key or a sheet. */
const STYLE_NAME = /^(--[\w-]+|-?[A-Za-z][A-Za-z-]*)$/;
const NOT_AN_ATTR = /^(className|style|key|ref|dangerouslySetInnerHTML|on[A-Z].*)$/;

/**
 * Adds `node` at `place` relative to `element`, returning what it printed in document order. Its
 * styles aren't written here: the caller queues a style edit for each, so every convention is the
 * same path an inspector edit takes. A CSS-modules file gets its class name now, for that edit.
 */
export function insert(
  s: InsertStep,
  element: Element,
  place: InsertPlace,
  node: NewNode,
): Printed[] {
  const out = printing(s, element.node);
  const el = element.node;
  if (place === "before" || place === "after") {
    const beside = slotOf(s, element);
    const i = beside.parent.children.indexOf(beside.node as never);
    const ws = beside.parent.children[i - 1];
    const sep =
      ws?.type === "JSXText" && ws.value.trim() === ""
        ? ws.value.includes("\n")
          ? `\n${ws.value.split("\n").at(-1)}`
          : ws.value
        : "";
    const text = print(s, node, indentAt(s.code, beside.node.start!), out);
    if (place === "before") s.ms.appendLeft(beside.node.start!, text + sep);
    else s.ms.appendLeft(beside.node.end!, sep + text);
    return out.nodes;
  }

  const opening = el.openingElement;
  const name = tagName(opening.name);
  if (VOID.has(name)) throw new Refused(`<${name}> can't hold other elements`, "invalid");
  if (attribute(el, "dangerouslySetInnerHTML") || attribute(el, "children"))
    throw new Refused(
      "This element's content comes from code. Ask the agent to change this.",
      "unsupported-style",
    );

  const closeIndent = indentAt(s.code, el.start!);
  const childIndent = closeIndent + (closeIndent.includes("\t") ? "\t" : "  ");
  const close = el.closingElement;
  if (!close) {
    let start = opening.end! - 2;
    while (/\s/.test(s.code[start - 1]!)) start--;
    const text = print(s, node, childIndent, out);
    s.ms.overwrite(start, opening.end!, `>\n${childIndent}${text}\n${closeIndent}</${name}>`);
    return out.nodes;
  }

  const from = opening.end!;
  const to = close.start!;
  const inner = s.code.slice(from, to);
  if (inner.trim() === "") {
    const text = print(s, node, childIndent, out);
    const body = `\n${childIndent}${text}\n${closeIndent}`;
    if (from === to) s.ms.appendLeft(from, body);
    else s.ms.overwrite(from, to, body);
    return out.nodes;
  }

  // Children on their own lines keep that shape; children on the tag's line stay on it, where a
  // new line would change the text they show.
  if (place === "start") {
    const lead = /^\s*/.exec(inner)![0];
    if (lead.includes("\n")) {
      const indent = indentAt(s.code, from + lead.length);
      s.ms.appendLeft(from, `\n${indent}${print(s, node, indent, out)}`);
    } else s.ms.appendLeft(from, print(s, node, closeIndent, out));
    return out.nodes;
  }
  const trail = /\s*$/.exec(inner)![0];
  if (trail.includes("\n")) {
    s.ms.appendLeft(to - trail.length, `\n${childIndent}${print(s, node, childIndent, out)}`);
  } else s.ms.appendLeft(to, print(s, node, closeIndent, out));
  return out.nodes;
}

/** Whether a CSS value, printed raw into a sheet, stays one declaration's value and nothing more. */
function isOneValue(value: string): boolean {
  try {
    const [rule, ...others] = postcss.parse(`a{x:${value}}`).nodes;
    if (others.length > 0 || rule?.type !== "rule" || rule.nodes.length !== 1) return false;
    const [decl] = rule.nodes;
    return decl?.type === "decl" && decl.prop === "x" && decl.value === value.trim();
  } catch {
    return false;
  }
}

/** Refuses a style that wouldn't print as one declaration. */
export function checkStyles(styles: Record<string, string>): void {
  for (const [name, value] of Object.entries(styles)) {
    if (!STYLE_NAME.test(name) || !isOneValue(value))
      throw new Refused(`A new element can't set the style ${name}: ${value}`, "invalid");
  }
}

/**
 * What `before` and `after` sit beside: the element when it's a JSX child, else the `{…}` child
 * that renders it, like `{items.map(…)}`. A component's root has neither.
 */
function slotOf(
  s: InsertStep,
  element: Element,
): { node: t.Node; parent: t.JSXElement | t.JSXFragment } {
  if (isChild(element)) return element;
  const parents = new Map<t.Node, t.Node | undefined>();
  walk(s.parsed.ast, (node, parent) => parents.set(node, parent));
  for (let up = parents.get(element.node); up; up = parents.get(up)) {
    if (up.type === "JSXAttribute" || up.type === "JSXSpreadAttribute") break;
    if (up.type !== "JSXExpressionContainer") continue;
    const owner = parents.get(up);
    if (owner?.type === "JSXElement" || owner?.type === "JSXFragment")
      return { node: up, parent: owner };
    break;
  }
  return asChild(element, "add a sibling to");
}

type Printing = {
  nodes: Printed[];
  classes: Set<string>;
  /** The binding each asset is imported under. */
  assets: Map<string, string>;
  /** Every name the file mentions, so a new import can't be hidden by a local. */
  names: Set<string>;
  /** The element the new one goes in or beside, for what's in scope there. */
  at: t.JSXElement | undefined;
};

export function printing(s: InsertStep, at?: t.JSXElement): Printing {
  const names = new Set<string>();
  walk(s.parsed.ast, (node) => {
    if (node.type === "Identifier" || node.type === "JSXIdentifier") names.add(node.name);
  });
  return { nodes: [], classes: new Set(), assets: new Map(), names, at };
}

/** Prints `node` as a whole expression, for a file it's the root of. */
export function printRoot(
  s: InsertStep,
  node: NewNode,
  indent: string,
): {
  text: string;
  nodes: Printed[];
} {
  const out = printing(s);
  return { text: print(s, node, indent, out), nodes: out.nodes };
}

export function print(s: InsertStep, node: NewNode, indent: string, out: Printing): string {
  if (!NEW_TAG.test(node.tag)) throw new Refused(`${node.tag} isn't an element's name`, "invalid");
  const attrs: string[] = [];
  if (node.name !== undefined) attrs.push(`data-name=${attrText(node.name)}`);
  if (node.src) {
    attrs.push(`src={${assetBinding(s, node.src.asset, out)}}`);
    if (node.tag === "video") attrs.push("controls");
  }
  for (const [name, value] of Object.entries(node.attrs ?? {})) {
    if (!ATTR_NAME.test(name) || NOT_AN_ATTR.test(name))
      throw new Refused(`A new element can't set ${name} as an attribute`, "invalid");
    attrs.push(`${name}=${attrText(value)}`);
  }
  const styles = node.styles ?? {};
  checkStyles(styles);
  const cls = Object.keys(styles).length > 0 ? moduleClass(s, node, out) : undefined;
  if (cls) attrs.push(`className={${cls}}`);
  const key = node.ref ?? `#${out.nodes.length}`;
  if (out.nodes.some((p) => p.key === key))
    throw new Refused(`Two new elements are both called ${key}`, "invalid");
  out.nodes.push({ key, tag: node.tag, styles });

  const open = `<${[node.tag, ...attrs].join(" ")}`;
  const kids = node.children ?? [];
  if (node.text === undefined && kids.length === 0) return `${open} />`;
  if (VOID.has(node.tag)) throw new Refused(`<${node.tag}> can't hold anything`, "invalid");
  if (kids.length === 0) return `${open}>${jsxText(node.text!)}</${node.tag}>`;
  const inner = indent + (indent.includes("\t") ? "\t" : "  ");
  const lines = kids.map((kid) => `\n${inner}${print(s, kid, inner, out)}`).join("");
  const text = node.text === undefined ? "" : `\n${inner}${jsxText(node.text)}`;
  return `${open}>${text}${lines}\n${indent}</${node.tag}>`;
}

/**
 * The expression that holds `asset`'s URL, importing it when the file doesn't yet. In Next.js a
 * static import is an object, whose URL is `.src`.
 */
function assetBinding(s: InsertStep, asset: string, out: Printing): string {
  if (
    !/^[\w ./@+-]+$/.test(asset) ||
    path.posix.isAbsolute(asset) ||
    asset.split("/").includes("..")
  )
    throw new Refused(`${asset} isn't a file in the design`, "invalid");
  const relative = path.posix.relative(path.posix.dirname(s.file), asset);
  const from = relative.startsWith(".") ? relative : `./${relative}`;
  let binding = out.assets.get(asset) ?? importedFrom(s, from, out.at);
  if (binding === undefined) {
    const stem = path.posix.basename(asset, path.posix.extname(asset));
    binding = freeName(`${className(stem)}Asset`, out.names);
    for (const p of head(s.code, s.parsed.ast, [{ names: binding, from }]))
      s.ms.appendLeft(p.start, p.text);
  }
  out.assets.set(asset, binding);
  return s.router === "next-app" || s.router === "next-pages" ? `${binding}.src` : binding;
}

/** `base`, numbered when the file already mentions it, and taken from then on. */
function freeName(base: string, names: Set<string>): string {
  let name = base;
  for (let n = 2; names.has(name); n++) name = `${base}${n}`;
  names.add(name);
  return name;
}

/** The local name of the file's default import of `from`, if the new element can see it. */
function importedFrom(s: InsertStep, from: string, at?: t.JSXElement): string | undefined {
  for (const stmt of s.parsed.ast.program.body) {
    if (stmt.type !== "ImportDeclaration" || stmt.source.value !== from) continue;
    const def = stmt.specifiers.find((sp) => sp.type === "ImportDefaultSpecifier");
    if (def && !(at && shadowed(s.parsed.ast, at, def.local.name))) return def.local.name;
  }
  return undefined;
}

/**
 * The `binding.name` a new element in a CSS-modules file takes. A file importing exactly one
 * sheet gets a class there; any other file has nowhere obvious to put one, so it stays inline.
 */
export function moduleClass(
  s: InsertStep,
  node: NewNode,
  out: Pick<Printing, "classes">,
): string | undefined {
  if (s.convention !== "css-modules") return undefined;
  const sheets = [...cssModules(s.parsed.ast, s.file)];
  if (sheets.length !== 1) return undefined;
  const [binding, sheet] = sheets[0]!;
  const css = s.files[sheet];
  if (css === undefined) return undefined;
  const base = className(node.name ?? node.tag);
  const taken = (name: string) =>
    new RegExp(`\\.${name}(?![\\w-])`).test(css) ||
    new RegExp(`\\b${binding}\\.${name}\\b`).test(s.code) ||
    out.classes.has(name);
  let name = base;
  for (let n = 2; taken(name); n++) name = `${base}${n}`;
  out.classes.add(name);
  return `${binding}.${name}`;
}

/** A layer name as a CSS-module class: `Hero Card` → `heroCard`. */
function className(name: string): string {
  const words = name.match(/[A-Za-z0-9]+/g) ?? [];
  const joined = words
    .map((w, i) => (i === 0 ? w[0]!.toLowerCase() + w.slice(1) : w[0]!.toUpperCase() + w.slice(1)))
    .join("");
  return joined === "" ? "element" : /^\d/.test(joined) ? `n${joined}` : joined;
}
