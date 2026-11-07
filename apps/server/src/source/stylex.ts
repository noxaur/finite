import type * as t from "@babel/types";
import { Refused } from "@finite/protocol";
import { kebab } from "./tailwind.ts";

const SOURCES = new Set(["@stylexjs/stylex", "stylex"]);
const ASK = "Ask the agent to change this";

/** How a file names StyleX: its namespace imports, named `props` and `create`, and its `create` objects. */
type Bindings = {
  namespaces: Set<string>;
  props: Set<string>;
  create: Set<string>;
  /** Local name → the module it's imported from, for every non-StyleX import. */
  imported: Map<string, string>;
  /** `const <name> = create(<arg>)` at the top level. */
  sheets: Map<string, t.Node>;
};

/** A `name.key` or `name.key(...)` argument of `props`; `sheet` is the root of `name`. */
type Ref = { sheet: string; key: string; call: boolean; nested: boolean; member: t.Node };

/**
 * The overwrite that sets `styles` on the `stylex.create` entry that `el`'s `stylex.props` spread
 * resolves to, or `undefined` when the element has no spread.
 */
export function stylexEdit(
  code: string,
  ast: t.File,
  el: t.JSXElement,
  styles: Record<string, string | null>,
): { start: number; end: number; text: string } | undefined {
  const b = bindings(ast);
  const spreads: t.Node[][] = [];
  for (const attr of el.openingElement.attributes) {
    if (
      attr.type === "JSXSpreadAttribute" &&
      attr.argument.type === "CallExpression" &&
      calls(b, attr.argument.callee, "props")
    ) {
      spreads.push(attr.argument.arguments);
    } else if (
      attr.type === "JSXAttribute" &&
      attr.name.type === "JSXIdentifier" &&
      attr.name.name === "sx" &&
      attr.value?.type === "JSXExpressionContainer" &&
      attr.value.expression.type !== "JSXEmptyExpression"
    ) {
      // StyleX compiles `sx={…}` on a lowercase element to `{...stylex.props(…)}`.
      spreads.push([attr.value.expression]);
    }
  }
  if (spreads.length === 0) return undefined;
  if (spreads.length > 1)
    throw refuse(
      "This element spreads stylex.props more than once, so Finite can't tell which to edit",
    );

  const args = flat(spreads[0]!);
  const known = (r: Ref | undefined) =>
    r !== undefined && (b.sheets.has(r.sheet) || b.imported.has(r.sheet));
  const at = args.findLastIndex((a) => known(ref(a)));
  if (at === -1)
    throw refuse(
      "This element's stylex.props has no style that always applies, so Finite can't tell which to edit",
    );
  const target = ref(args[at]!)!;
  const name = code.slice(target.member.start!, target.member.end!);
  if (!b.sheets.has(target.sheet))
    throw refuse(
      `${name} comes from another file (${b.imported.get(target.sheet)}), so Finite can't edit it by hand`,
    );
  const entry = target.nested ? undefined : entryOf(b, target);
  if (
    target.call ||
    entry?.type === "ArrowFunctionExpression" ||
    entry?.type === "FunctionExpression" ||
    entry?.type === "ObjectMethod"
  )
    throw refuse(`${name} is a function (a dynamic style), so Finite can't edit it by hand`);
  if (entry?.type !== "ObjectExpression")
    throw refuse(`${name} is built from code, so Finite can't edit it by hand`);
  if (entry.properties.some((p) => p.type !== "ObjectProperty"))
    throw refuse(`${name} has a spread or a method, so Finite can't edit it by hand`);

  const wanted = new Map(Object.entries(styles).map(([k, v]) => [kebab(k), v]));
  for (const arg of args.slice(at + 1)) {
    for (const r of conditional(arg)) {
      const later = r.nested ? undefined : entryOf(b, r);
      const body =
        later?.type === "ArrowFunctionExpression" || later?.type === "FunctionExpression"
          ? later.body
          : later;
      if (body?.type !== "ObjectExpression") continue;
      const prop = keys(body).find((k) => wanted.has(k));
      if (prop !== undefined)
        throw refuse(
          `${code.slice(arg.start!, arg.end!)} comes later in stylex.props and sets ${prop}, so the change wouldn't show`,
        );
    }
  }

  const existing = new Set(keys(entry));
  const added = [...wanted]
    .filter(([k, v]) => v !== null && !existing.has(k))
    .map(([k, v]) => `${key(k)}: ${JSON.stringify(v)}`);
  const text = rebuild(
    code,
    entry,
    (p, k) => {
      if (!wanted.has(k)) return undefined;
      const v = wanted.get(k)!;
      const value = p.value;
      const around = (inner: string) =>
        `${code.slice(p.start!, value.start!)}${inner}${code.slice(value.end!, p.end!)}`;
      if (value.type !== "ObjectExpression") return v === null ? null : around(JSON.stringify(v));
      // A conditional value ({ default, ":hover", "@media …" }): set `default`, keep the rest.
      const literal = v === null ? "null" : JSON.stringify(v);
      const hasDefault = keys(value).includes("default");
      return around(
        rebuild(
          code,
          value,
          (q, qk) => {
            if (qk !== "default") return undefined;
            if (q.value.type === "ObjectExpression")
              throw refuse(
                `${k} in ${name} has a nested default, so Finite can't tell which value to edit`,
              );
            return `${code.slice(q.start!, q.value.start!)}${literal}${code.slice(q.value.end!, q.end!)}`;
          },
          hasDefault ? [] : [`default: ${literal}`],
        ),
      );
    },
    added,
  );
  return { start: entry.start!, end: entry.end!, text };
}

function refuse(why: string): Refused {
  return new Refused(`${why}. ${ASK}.`, "unsupported-style");
}

function bindings(ast: t.File): Bindings {
  const b: Bindings = {
    namespaces: new Set(),
    props: new Set(),
    create: new Set(),
    imported: new Map(),
    sheets: new Map(),
  };
  for (const stmt of ast.program.body) {
    if (stmt.type !== "ImportDeclaration") continue;
    const stylex = SOURCES.has(stmt.source.value);
    for (const spec of stmt.specifiers) {
      if (!stylex) b.imported.set(spec.local.name, stmt.source.value);
      else if (spec.type === "ImportNamespaceSpecifier") b.namespaces.add(spec.local.name);
      else if (spec.type === "ImportSpecifier") {
        const name = spec.imported.type === "Identifier" ? spec.imported.name : spec.imported.value;
        if (name === "props") b.props.add(spec.local.name);
        if (name === "create") b.create.add(spec.local.name);
      }
    }
  }
  for (const stmt of ast.program.body) {
    const decl = stmt.type === "ExportNamedDeclaration" ? stmt.declaration : stmt;
    if (decl?.type !== "VariableDeclaration") continue;
    for (const d of decl.declarations) {
      if (
        d.id.type === "Identifier" &&
        d.init?.type === "CallExpression" &&
        calls(b, d.init.callee, "create")
      )
        b.sheets.set(d.id.name, d.init.arguments[0] ?? d.init);
    }
  }
  return b;
}

/** True when `callee` is StyleX's `fn`: `stylex.fn` through a namespace import, or a named import. */
function calls(b: Bindings, callee: t.Node, fn: "props" | "create"): boolean {
  if (callee.type === "Identifier") return b[fn].has(callee.name);
  return (
    callee.type === "MemberExpression" &&
    !callee.computed &&
    callee.object.type === "Identifier" &&
    b.namespaces.has(callee.object.name) &&
    callee.property.type === "Identifier" &&
    callee.property.name === fn
  );
}

/** `props`' arguments with nested arrays spread out, as StyleX reads them. */
function flat(args: t.Node[]): t.Node[] {
  return args.flatMap((a) =>
    a.type === "ArrayExpression" ? flat(a.elements.filter((e) => e !== null)) : [a],
  );
}

/** The `name.key` or `name.key(...)` an unconditional argument is. */
function ref(node: t.Node): Ref | undefined {
  const call = node.type === "CallExpression";
  const member = call ? node.callee : node;
  if (member.type !== "MemberExpression") return undefined;
  let root: t.Node = member.object;
  while (root.type === "MemberExpression") root = root.object;
  if (root.type !== "Identifier") return undefined;
  const key =
    !member.computed && member.property.type === "Identifier"
      ? member.property.name
      : member.property.type === "StringLiteral"
        ? member.property.value
        : undefined;
  if (key === undefined) return undefined;
  return { sheet: root.name, key, call, nested: member.object !== root, member };
}

/** The refs a conditional argument may apply: `on && styles.x`, `on ? styles.x : styles.y`. */
function conditional(node: t.Node): Ref[] {
  if (node.type === "LogicalExpression")
    return [...conditional(node.left), ...conditional(node.right)];
  if (node.type === "ConditionalExpression")
    return [...conditional(node.consequent), ...conditional(node.alternate)];
  const r = ref(node);
  return r ? [r] : [];
}

/** The value of `ref`'s key in its `create` object in this file. */
function entryOf(b: Bindings, r: Ref): t.Node | undefined {
  const sheet = b.sheets.get(r.sheet);
  if (sheet?.type !== "ObjectExpression") return undefined;
  for (const p of sheet.properties) {
    if (p.type === "SpreadElement" || p.computed || keyName(p.key) !== r.key) continue;
    return p.type === "ObjectMethod" ? p : p.value;
  }
  return undefined;
}

/** The CSS property names (kebab-case) an object sets with plain keys. */
function keys(obj: t.ObjectExpression): string[] {
  return obj.properties.flatMap((p) => {
    const k = p.type === "ObjectProperty" && !p.computed ? keyName(p.key) : undefined;
    return k === undefined ? [] : [kebab(k)];
  });
}

function keyName(key: t.Node): string | undefined {
  if (key.type === "Identifier") return key.name;
  if (key.type === "StringLiteral") return key.value;
  return undefined;
}

/** A StyleX key for a CSS property: camelCase, custom properties quoted. */
function key(prop: string): string {
  return prop.startsWith("--")
    ? JSON.stringify(prop)
    : prop.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

/**
 * `obj`'s text with each property `edit` returns a string for replaced, each it returns `null`
 * for dropped, and `added` after the last. Comments and line breaks between properties survive.
 */
function rebuild(
  code: string,
  obj: t.ObjectExpression,
  edit: (p: t.ObjectProperty, key: string) => string | null | undefined,
  added: string[],
): string {
  const props = obj.properties;
  const source = code.slice(obj.start!, obj.end!);
  const multiline = source.includes("\n");
  if (props.length === 0) {
    if (added.length === 0) return source;
    if (!multiline) return `{ ${added.join(", ")} }`;
    const indent = indentAt(code, obj.start!);
    return `{\n${added.map((a) => `${indent}  ${a},`).join("\n")}\n${indent}}`;
  }
  const kept: { text: string; sep: string }[] = [];
  props.forEach((p, i) => {
    const sep = i < props.length - 1 ? code.slice(p.end!, props[i + 1]!.start!) : "";
    const k = p.type === "ObjectProperty" && !p.computed ? keyName(p.key) : undefined;
    const next = k === undefined ? undefined : edit(p as t.ObjectProperty, kebab(k));
    if (next !== null) kept.push({ text: next ?? code.slice(p.start!, p.end!), sep });
  });
  if (kept.length === 0 && added.length === 0) return "{}";
  const sep = multiline ? `,\n${indentAt(code, props[0]!.start!)}` : ", ";
  const body = [
    ...kept.map((k, i) => k.text + (i < kept.length - 1 ? k.sep : "")),
    ...added.map((a, i) => (i > 0 || kept.length > 0 ? sep : "") + a),
  ].join("");
  return code.slice(obj.start!, props[0]!.start!) + body + code.slice(props.at(-1)!.end!, obj.end!);
}

function indentAt(code: string, offset: number): string {
  const lineStart = code.lastIndexOf("\n", offset - 1) + 1;
  return /^[ \t]*/.exec(code.slice(lineStart))![0];
}
