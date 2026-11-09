import type * as t from "@babel/types";
import {
  type Inline,
  type InsertPlace,
  type Loc,
  type NewNode,
  Refused,
  type Remap,
  type Router,
  type SourceEdit,
  type Styling,
} from "@finite/protocol";
import MagicString from "magic-string";
import { editRule } from "./css.ts";
import { rev } from "./files.ts";
import { cssModules } from "./imports.ts";
import { type Kept, setInline } from "./inline.ts";
import { insert } from "./insert.ts";
import {
  asChild,
  attribute,
  attributeInsertAt,
  attrText,
  indentAt,
  isWhitespaceText,
  parseTsx,
  siblings,
  slot,
  tagName,
  type Element,
  type Parsed,
} from "./jsx.ts";
import { stylexEdit, varRefs } from "./stylex.ts";
import { editClasses, kebab, stripClasses, type TailwindVersion, type Theme } from "./tailwind.ts";
import { useVariables, variableRefs, type VariableHome } from "./tokens.ts";
import { unwrap, wrap } from "./wrap.ts";

export type RewriteContext = {
  theme: Theme;
  /** Tailwind's major version (default 4); v3 writes only the config's scales. */
  tailwind?: TailwindVersion;
  /** Other files an edit may change (the `*.module.{css,scss,sass,less}` files this file imports), by root-relative path. */
  files: Record<string, string>;
  /** The file that defines each Sass `$var` and Less `@var` token (`variableSheets`). */
  variables?: Record<string, VariableHome>;
  /** The `*.stylex.ts` file that defines each StyleX `defineVars` token (`group.key`). */
  stylexVars?: Record<string, string>;
  /** Which router the design uses: a new element's file import reads differently under Next.js. */
  router?: Router;
};

export type Rewritten = {
  code: string;
  remap: Remap;
  /** The context files after the edit; only changed ones differ. */
  files: Record<string, string>;
  /** The loc of each new node that named a `ref`. */
  created: Record<string, Loc>;
};

const STALE = "The file changed; try again";
const ASK = "Ask the agent to change this";

/** One edit applied to one element. */
type Op =
  | { kind: "style"; at: string; tag: string; styles: Record<string, string | null> }
  | { kind: "inline"; at: string; tag: string; content: Inline[] }
  | { kind: "reorder"; at: string; tag: string; before: string | null }
  | { kind: "remove" | "duplicate"; at: string }
  | { kind: "attr"; at: string; name: string; value: string | null }
  | { kind: "insert"; at: string; tag: string; place: InsertPlace; node: NewNode };

/** In the position map, the keys of elements a batch created: a client `ref` or a printed index. */
const NEW = "new:";

export function parseLoc(loc: Loc): { file: string; key: string } {
  const m = /^(.*):(\d+):(\d+)$/.exec(loc);
  if (!m) throw new Refused(`${loc} isn't a loc (file:line:col)`, "invalid");
  return { file: m[1]!, key: `${m[2]}:${m[3]}` };
}

/** Every style map the edit writes, a new node's and its children's included. */
export function editStyles(edit: SourceEdit): Record<string, string | null>[] {
  if (edit.kind === "style") return [edit.styles];
  if (edit.kind === "inline")
    return edit.content.flatMap((item) =>
      (item.marks ?? []).flatMap((mark) => (mark.m === "span" ? [mark.styles] : [])),
    );
  if (edit.kind !== "insert") return [];
  const all: Record<string, string>[] = [];
  const visit = (node: NewNode) => {
    if (node.styles) all.push(node.styles);
    node.children?.forEach(visit);
  };
  visit(edit.node);
  return all;
}

/** The files the edit's locs point into. */
export function editFiles(edit: SourceEdit): string[] {
  const locs = "locs" in edit ? edit.locs : [edit.loc];
  const files = locs.map((loc) => parseLoc(loc).file);
  if (edit.kind === "reorder" && edit.before) files.push(parseLoc(edit.before).file);
  return [...new Set(files)];
}

/**
 * Applies the edits whose locs are in `file` to its source, keeping the rest of the formatting.
 * Locs are positions in `code`; `remap` says where every element that moved went.
 */
export function rewrite(
  code: string,
  file: string,
  edits: SourceEdit[],
  convention: Styling,
  ctx: RewriteContext,
): Rewritten | Refused {
  try {
    return rewriteOrThrow(code, file, edits, convention, ctx);
  } catch (error) {
    if (error instanceof Refused) return error;
    throw error;
  }
}

function rewriteOrThrow(
  code: string,
  file: string,
  edits: SourceEdit[],
  convention: Styling,
  ctx: RewriteContext,
): Rewritten {
  const ops: Op[] = [];
  const current = rev(code);
  for (const edit of edits) {
    if (!editFiles(edit).includes(file)) continue;
    const r = edit.revs[file];
    if (r === undefined) throw new Refused(`The edit has no rev for ${file}`, "invalid");
    if (r !== current) throw new Refused(STALE, "stale");
    ops.push(...toOps(edit, file));
  }

  let parsed = parseTsx(code, file);
  // Where each element of the original code is now, keyed by its original position.
  const original = new Set(parsed.elements.keys());
  const where = new Map<string, string>([...original].map((k) => [k, k]));
  const files = { ...ctx.files };

  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]!;
    const at = where.get(op.at);
    if (at === undefined) {
      if (original.has(op.at)) continue; // an earlier op in this batch removed it (its parent went)
      throw new Refused(STALE, "stale");
    }
    const element = parsed.elements.get(at)!;
    if ("tag" in op && tagName(element.node.openingElement.name) !== op.tag)
      throw new Refused(STALE, "stale");

    const ms = new MagicString(code);
    const s: StepCtx = {
      ms,
      code,
      file,
      parsed,
      where,
      ctx,
      files,
      convention,
      router: ctx.router,
    };
    const made = applyOp(s, element, op);
    const next = ms.toString();
    if (next === code) continue;
    const nextParsed = parseTsx(next, file);
    const moved = follow(ms, parsed, nextParsed);
    for (const [orig, cur] of where) {
      const to = moved.get(cur);
      if (to === undefined) where.delete(orig);
      else where.set(orig, to);
    }
    if (made) ops.splice(i + 1, 0, ...track(made, moved, nextParsed, where));
    code = next;
    parsed = nextParsed;
  }

  const remap: Remap = {};
  const created: Record<string, Loc> = {};
  for (const [orig, cur] of where) {
    if (orig.startsWith(`${NEW}#`)) continue;
    if (orig.startsWith(NEW)) created[orig.slice(NEW.length)] = `${file}:${cur}`;
    else if (orig !== cur) remap[`${file}:${orig}`] = `${file}:${cur}`;
  }
  return { code, remap, files, created };
}

/**
 * Enters what an insert printed into the position map, so later ops find it like any other
 * element, and returns the style ops that dress it. An element that was only reprinted goes back
 * under its original key. The elements no earlier position maps to are
 * the printed ones, and both lists are in document order.
 */
function track(
  made: Kept[],
  moved: Map<string, string>,
  parsed: Parsed,
  where: Map<string, string>,
): Op[] {
  const old = new Set(moved.values());
  const fresh = [...parsed.elements.keys()]
    .filter((key) => !old.has(key))
    .sort((a, b) => {
      const [al, ac] = a.split(":").map(Number) as [number, number];
      const [bl, bc] = b.split(":").map(Number) as [number, number];
      return al - bl || ac - bc;
    });
  if (fresh.length !== made.length)
    throw new Error(`printed ${made.length} elements, parsed ${fresh.length} new ones`);
  return made.flatMap((node, i): Op[] => {
    where.set(node.orig ?? `${NEW}${node.key}`, fresh[i]!);
    return Object.keys(node.styles).length === 0
      ? []
      : [{ kind: "style", at: `${NEW}${node.key}`, tag: node.tag, styles: node.styles }];
  });
}

function toOps(edit: SourceEdit, file: string): Op[] {
  const here = (loc: Loc) => {
    const p = parseLoc(loc);
    return p.file === file ? [p.key] : [];
  };
  switch (edit.kind) {
    case "style":
      return edit.locs
        .flatMap(here)
        .map((at) => ({ kind: "style", at, tag: edit.tag, styles: edit.styles }));
    case "remove":
    case "duplicate":
      return edit.locs.flatMap(here).map((at) => ({ kind: edit.kind, at }));
    case "attr":
      return here(edit.loc).map((at) => ({ kind: "attr", at, name: edit.name, value: edit.value }));
    case "insert":
      return here(edit.loc).map((at) => ({
        kind: "insert",
        at,
        tag: edit.tag,
        place: edit.place,
        node: edit.node,
      }));
    case "wrap":
      return wrap();
    case "unwrap":
      return unwrap();
    case "inline":
      return here(edit.loc).map((at) => ({
        kind: "inline",
        at,
        tag: edit.tag,
        content: edit.content,
      }));
    case "reorder": {
      const before = edit.before ? parseLoc(edit.before) : null;
      if (before && before.file !== parseLoc(edit.loc).file) {
        throw new Refused(
          "An element can only move among its siblings in the same file",
          "invalid",
        );
      }
      return here(edit.loc).map((at) => ({
        kind: "reorder",
        at,
        tag: edit.tag,
        before: before?.key ?? null,
      }));
    }
  }
}

/** Old position → new position for every element `ms` didn't drop, read off its hi-res source map. */
function follow(ms: MagicString, before: Parsed, after: Parsed): Map<string, string> {
  const map = ms.generateDecodedMap({ hires: true });
  const out = new Map<string, string>();
  for (const key of after.elements.keys()) {
    const [line, col] = key.split(":").map(Number) as [number, number];
    const seg = map.mappings[line - 1]?.find((s) => s[0] === col);
    if (!seg || seg.length < 4) continue;
    const old = `${seg[2]! + 1}:${seg[3]}`;
    if (before.elements.has(old) && !out.has(old)) out.set(old, key);
  }
  return out;
}

type StepCtx = {
  ms: MagicString;
  code: string;
  file: string;
  parsed: Parsed;
  where: Map<string, string>;
  ctx: RewriteContext;
  files: Record<string, string>;
  convention: Styling;
  router: Router | undefined;
};

/** Applies the op; an insert says what it printed. */
function applyOp(s: StepCtx, element: Element, op: Op): Kept[] | void {
  switch (op.kind) {
    case "style":
      return style(s, element.node, op.styles);
    case "inline":
      return setInline(s, element, op.content);
    case "reorder":
      return reorder(s, element, op.before);
    case "remove": {
      const child = asChild(element, "remove");
      const range = slot(child.parent, child.node);
      s.ms.remove(range.start, range.end);
      return;
    }
    case "duplicate": {
      const child = asChild(element, "duplicate");
      const i = child.parent.children.indexOf(child.node);
      const ws = child.parent.children[i - 1];
      const sep = isWhitespaceText(ws)
        ? ws.value.includes("\n")
          ? `\n${ws.value.split("\n").at(-1)}`
          : ws.value
        : "";
      s.ms.appendLeft(child.node.end!, sep + s.code.slice(child.node.start!, child.node.end!));
      return;
    }
    case "attr":
      return attr(s, element.node, op.name, op.value);
    case "insert":
      return insert(s, element, op.place, op.node);
  }
}

// Styles

const CLASS_FNS = new Set(["cn", "clsx", "twMerge", "classnames", "classNames", "cx"]);

function style(s: StepCtx, el: t.JSXElement, styles: Record<string, string | null>): void {
  const cls = attribute(el, "className");
  const token = varRefs(styles)[0];
  if (token && s.convention !== "stylex") {
    const how = { tailwind: "Tailwind classes", "css-modules": "a CSS module" }[
      s.convention as string
    ];
    throw new Refused(
      `${token} is a StyleX token, which only a stylex.create entry can use, and this element is styled with ${how ?? "inline styles"}. Pick a CSS custom property (--name) token instead, or ask the agent.`,
      "unsupported-style",
    );
  }
  if (s.convention === "css-modules" && cls) return cssModule(s, cls, styles);
  const ref = variableRefs(styles)[0];
  if (ref) {
    const how = { stylex: "StyleX", tailwind: "Tailwind classes" }[s.convention as string];
    throw new Refused(
      `${ref} is a ${ref.startsWith("$") ? "Sass" : "Less"} variable, which only a rule in a ${ref.startsWith("$") ? ".module.scss" : ".module.less"} sheet can use, and this element is styled with ${how ?? "inline styles"}. Pick a CSS custom property (--name) token instead, or ask the agent.`,
      "unsupported-style",
    );
  }
  if (s.convention === "stylex") {
    const patches = stylexEdit(s.code, s.parsed.ast, el, styles, s.file, s.ctx.stylexVars ?? {});
    if (patches) {
      for (const p of patches)
        if (p.start === p.end) s.ms.appendLeft(p.start, p.text);
        else s.ms.overwrite(p.start, p.end, p.text);
      return;
    }
    if (token)
      throw new Refused(
        `${token} is a StyleX token, which only a stylex.create entry can use, and this element has a style, a className or a spread but no stylex.props spread, so it would get an inline style. Give it a stylex.create entry, pick a CSS custom property (--name) token instead, or ask the agent.`,
        "unsupported-style",
      );
    return inline(s, el, styles);
  }
  if (s.convention === "inline" || s.convention === "css-modules") return inline(s, el, styles);

  if (!cls) {
    const classes = editClasses("", styles, s.ctx.theme, s.ctx.tailwind);
    if (classes !== "") s.ms.appendLeft(attributeInsertAt(el), ` className=${classAttr(classes)}`);
    return;
  }
  const value = cls.value;
  if (value?.type === "StringLiteral")
    return setLiteral(s, value, editClasses(value.value, styles, s.ctx.theme, s.ctx.tailwind));
  if (value?.type === "JSXExpressionContainer") {
    const expr = value.expression;
    const lit = literal(expr);
    if (lit !== undefined)
      return setLiteral(
        s,
        expr as t.StringLiteral,
        editClasses(lit, styles, s.ctx.theme, s.ctx.tailwind),
      );
    if (
      expr.type === "CallExpression" &&
      expr.callee.type === "Identifier" &&
      CLASS_FNS.has(expr.callee.name)
    ) {
      const args = expr.arguments.filter((a) => literal(a) !== undefined);
      const last = args.at(-1);
      if (last) {
        for (const arg of args.slice(0, -1))
          setLiteral(s, arg, stripClasses(literal(arg)!, styles, s.ctx.theme, s.ctx.tailwind));
        return setLiteral(
          s,
          last,
          editClasses(literal(last)!, styles, s.ctx.theme, s.ctx.tailwind),
        );
      }
    }
  }
  throw new Refused(ASK, "unsupported-style");
}

/** A new `className` value, quoted so it holds whatever the class list contains. */
function classAttr(classes: string): string {
  if (!classes.includes('"')) return `"${classes}"`;
  if (!classes.includes("'")) return `'${classes}'`;
  return `{\`${classes.replace(/[`\\]|\$\{/g, (m) => `\\${m}`)}\`}`;
}

/** The text of a string literal or a template literal without `${}`. */
function literal(node: t.Node): string | undefined {
  if (node.type === "StringLiteral") return node.value;
  if (node.type === "TemplateLiteral" && node.expressions.length === 0)
    return node.quasis[0]!.value.cooked ?? undefined;
  return undefined;
}

function setLiteral(s: StepCtx, node: t.Node, value: string): void {
  if (node.type === "TemplateLiteral")
    return void s.ms.overwrite(
      node.start!,
      node.end!,
      `\`${value.replace(/[`\\]|\$\{/g, (m) => `\\${m}`)}\``,
    );
  const quote = s.code[node.start!] === "'" ? "'" : '"';
  s.ms.overwrite(
    node.start! + 1,
    node.end! - 1,
    value.replaceAll(quote, quote === '"' ? "'" : '"'),
  );
}

function cssModule(s: StepCtx, cls: t.JSXAttribute, styles: Record<string, string | null>): void {
  const expr = cls.value?.type === "JSXExpressionContainer" ? cls.value.expression : undefined;
  if (expr?.type !== "MemberExpression" || expr.object.type !== "Identifier")
    throw new Refused(ASK, "unsupported-style");
  const name =
    !expr.computed && expr.property.type === "Identifier"
      ? expr.property.name
      : expr.property.type === "StringLiteral"
        ? expr.property.value
        : undefined;
  const sheet = cssModules(s.parsed.ast, s.file).get(expr.object.name);
  if (name === undefined || sheet === undefined) throw new Refused(ASK, "unsupported-style");
  const css = s.files[sheet];
  if (css === undefined) throw new Refused(`${sheet} doesn't exist`, "not-found");
  const used = useVariables(sheet, css, styles, s.ctx.variables ?? {});
  s.files[sheet] = editRule(sheet, used.css, name, used.styles);
}

function inline(s: StepCtx, el: t.JSXElement, styles: Record<string, string | null>): void {
  const attr = attribute(el, "style");
  const add = Object.entries(styles).filter((e): e is [string, string] => e[1] !== null);
  if (!attr) {
    if (add.length > 0)
      s.ms.appendLeft(
        attributeInsertAt(el),
        ` style={${objectText(
          add.map(([k, v]) => prop(k, v)),
          false,
          "",
          "",
        )}}`,
      );
    return;
  }
  const obj = attr.value?.type === "JSXExpressionContainer" ? attr.value.expression : undefined;
  if (obj?.type !== "ObjectExpression") throw new Refused(ASK, "unsupported-style");

  const wanted = new Map(Object.entries(styles).map(([k, v]) => [kebab(k), v]));
  const parts: string[] = [];
  for (const p of obj.properties) {
    const key = p.type === "ObjectProperty" && !p.computed ? keyName(p.key) : undefined;
    const k = key === undefined ? undefined : kebab(key);
    if (k === undefined || !wanted.has(k)) {
      parts.push(s.code.slice(p.start!, p.end!));
      continue;
    }
    const v = wanted.get(k)!;
    wanted.delete(k);
    if (v !== null)
      parts.push(
        `${s.code.slice(p.start!, (p as t.ObjectProperty).key.end!)}: ${JSON.stringify(v)}`,
      );
  }
  for (const [k, v] of wanted) if (v !== null) parts.push(prop(k, v));

  if (parts.length === 0) {
    const prev = el.openingElement.attributes[el.openingElement.attributes.indexOf(attr) - 1];
    s.ms.remove(prev ? prev.end! : el.openingElement.name.end!, attr.end!);
    return;
  }
  const source = s.code.slice(obj.start!, obj.end!);
  const multiline = source.includes("\n");
  s.ms.overwrite(
    obj.start!,
    obj.end!,
    objectText(
      parts,
      multiline,
      indentAt(s.code, obj.properties[0]?.start ?? obj.end! - 1),
      indentAt(s.code, obj.end! - 1),
    ),
  );
}

function keyName(key: t.Node): string | undefined {
  if (key.type === "Identifier") return key.name;
  if (key.type === "StringLiteral") return key.value;
  return undefined;
}

function prop(name: string, value: string): string {
  const key = name.startsWith("--")
    ? JSON.stringify(name)
    : name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
  return `${key}: ${JSON.stringify(value)}`;
}

function objectText(
  parts: string[],
  multiline: boolean,
  indent: string,
  closeIndent: string,
): string {
  if (parts.length === 0) return "{}";
  if (!multiline) return `{ ${parts.join(", ")} }`;
  return `{\n${parts.map((p) => `${indent}${p},`).join("\n")}\n${closeIndent}}`;
}

// Order, attributes

function reorder(s: StepCtx, element: Element, beforeKey: string | null): void {
  const child = asChild(element, "move");
  const parent = child.parent;
  const kids = siblings(parent);
  const from = slot(parent, child.node);
  if (beforeKey === null) {
    const last = kids.at(-1)!;
    if (last !== child.node) s.ms.move(from.start, from.end, last.end!);
    return;
  }
  const at = s.where.get(beforeKey);
  const before = at === undefined ? undefined : s.parsed.elements.get(at);
  if (!before) throw new Refused(STALE, "stale");
  if (before.parent !== parent)
    throw new Refused("An element can only move among its siblings", "invalid");
  if (before.node === child.node || kids[kids.indexOf(child.node) + 1] === before.node) return;
  s.ms.move(from.start, from.end, slot(parent, before.node).start);
}

function attr(s: StepCtx, el: t.JSXElement, name: string, value: string | null): void {
  if (!/^[A-Za-z_][\w:.-]*$/.test(name))
    throw new Refused(`${name} isn't an attribute name`, "invalid");
  const existing = attribute(el, name);
  const attrs = el.openingElement.attributes;
  if (value === null) {
    if (!existing) return;
    const prev = attrs[attrs.indexOf(existing) - 1];
    s.ms.remove(prev ? prev.end! : el.openingElement.name.end!, existing.end!);
    return;
  }
  const textValue = attrText(value);
  if (existing) s.ms.overwrite(existing.start!, existing.end!, `${name}=${textValue}`);
  else s.ms.appendLeft(attributeInsertAt(el), ` ${name}=${textValue}`);
}
