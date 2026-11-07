import type * as t from "@babel/types";
import { Refused, type Token, type TokenMode } from "@finite/protocol";
import { candidates, isRelative, resolveSpec, specTo } from "./imports.ts";
import { parseModule, walk } from "./jsx.ts";
import { kebab } from "./tailwind.ts";

const SOURCES = new Set(["@stylexjs/stylex", "stylex"]);
const ASK = "Ask the agent to change this";

/**
 * How a file names StyleX: its namespace imports, named `props`, `create` and `defineVars`, and its
 * `create` objects.
 */
type Bindings = {
  namespaces: Set<string>;
  props: Set<string>;
  create: Set<string>;
  defineVars: Set<string>;
  /** Local name → the module it's imported from, for every non-StyleX import. */
  imported: Map<string, string>;
  /** `const <name> = create(<arg>)` at the top level. */
  sheets: Map<string, t.Node>;
};

/** A `name.key` or `name.key(...)` argument of `props`; `sheet` is the root of `name`. */
type Ref = { sheet: string; key: string; call: boolean; nested: boolean; member: t.Node };

/**
 * The overwrite that sets `styles` on the `stylex.create` entry that `el`'s `stylex.props` spread
 * resolves to, or `undefined` when the element has no spread. A value that names a `defineVars`
 * token (`colors.brand`, from `vars`, token name → its `*.stylex.ts` file) is written as that
 * member expression, with `import`, the import to add when the file doesn't import its group yet.
 * A token inside a longer value is written as a template literal, `${colors.brand}` in its place.
 */
export function stylexEdit(
  code: string,
  ast: t.File,
  el: t.JSXElement,
  styles: Record<string, string | null>,
  file: string,
  vars: Record<string, string>,
): { start: number; end: number; text: string; import?: { at: number; text: string } } | undefined {
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
  if (shadowed(ast, el, target.sheet))
    throw refuse(
      `${name} refers to a parameter or local named ${target.sheet}, not the module-level stylex.create object`,
    );
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

  const used = useVars(code, ast, file, styles, vars);
  const valueText = (v: string | null) => (v === null ? "null" : used.text(v));
  const existing = new Set(keys(entry));
  const added = [...wanted]
    .filter(([k, v]) => v !== null && !existing.has(k))
    .map(([k, v]) => `${key(k)}: ${valueText(v)}`);
  const text = rebuild(
    code,
    entry,
    (p, k) => {
      if (!wanted.has(k)) return undefined;
      const v = wanted.get(k)!;
      const value = p.value;
      const around = (inner: string) =>
        `${code.slice(p.start!, value.start!)}${inner}${code.slice(value.end!, p.end!)}`;
      if (value.type !== "ObjectExpression") return v === null ? null : around(valueText(v));
      // A conditional value ({ default, ":hover", "@media …" }): set `default`, keep the rest.
      const literal = valueText(v);
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
  return {
    start: entry.start!,
    end: entry.end!,
    text,
    ...(used.import && { import: used.import }),
  };
}

function refuse(why: string): Refused {
  return new Refused(`${why}. ${ASK}.`, "unsupported-style");
}

function bindings(ast: t.File): Bindings {
  const b: Bindings = {
    namespaces: new Set(),
    props: new Set(),
    create: new Set(),
    defineVars: new Set(),
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
        if (name === "defineVars") b.defineVars.add(spec.local.name);
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
function calls(b: Bindings, callee: t.Node, fn: "props" | "create" | "defineVars"): boolean {
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

/** The refs a conditional argument may apply: `on && styles.x`, `on ? styles.x : [styles.y]`. */
function conditional(node: t.Node): Ref[] {
  if (node.type === "ArrayExpression")
    return node.elements.flatMap((e) => (e === null ? [] : conditional(e)));
  if (node.type === "LogicalExpression")
    return [...conditional(node.left), ...conditional(node.right)];
  if (node.type === "ConditionalExpression")
    return [...conditional(node.consequent), ...conditional(node.alternate)];
  const r = ref(node);
  return r ? [r] : [];
}

/**
 * True when a function around `el` binds `name` as a parameter or a local, hiding the module's. A
 * `let`, `const` or class declaration counts only when its block encloses `el`; `var` and function
 * declarations are scoped to the whole function.
 */
function shadowed(ast: t.File, el: t.JSXElement, name: string): boolean {
  const parents = new Map<t.Node, t.Node | undefined>();
  walk(ast, (node, parent) => void parents.set(node, parent));
  const above = new Set<t.Node>();
  for (let n = parents.get(el); n; n = parents.get(n)) above.add(n);
  const functionOf = (node: t.Node | undefined) => {
    while (node && !FUNCTIONS.has(node.type)) node = parents.get(node);
    return node as t.Function | undefined;
  };
  /** Whether the block a declaration sits in contains `el`. */
  const reaches = (declaration: t.Node) => {
    let block = parents.get(declaration);
    while (block && !BLOCKS.has(block.type)) block = parents.get(block);
    return block !== undefined && above.has(block);
  };
  for (let fn = functionOf(parents.get(el)); fn; fn = functionOf(parents.get(fn))) {
    if (fn.params.some((p) => binds(p, name))) return true;
    let found = false;
    walk(fn.body, (node) => {
      let id: t.Node | null | undefined;
      let scoped = false;
      if (node.type === "VariableDeclarator") {
        id = node.id;
        const declaration = parents.get(node);
        scoped = declaration?.type === "VariableDeclaration" && declaration.kind !== "var";
        if (scoped) node = declaration!;
      } else if (node.type === "ClassDeclaration") {
        id = node.id;
        scoped = true;
      } else if (node.type === "FunctionDeclaration") id = node.id;
      if (
        id &&
        functionOf(parents.get(node)) === fn &&
        binds(id, name) &&
        (!scoped || reaches(node))
      )
        found = true;
    });
    if (found) return true;
  }
  return false;
}

const FUNCTIONS = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
  "ObjectMethod",
  "ClassMethod",
  "ClassPrivateMethod",
]);

/** The nodes that scope a `let`, `const` or class declaration. */
const BLOCKS = new Set([
  "BlockStatement",
  "ForStatement",
  "ForInStatement",
  "ForOfStatement",
  "SwitchStatement",
  "StaticBlock",
]);

/** Whether a parameter or declaration pattern introduces `name`. */
function binds(pattern: t.Node, name: string): boolean {
  switch (pattern.type) {
    case "Identifier":
      return pattern.name === name;
    case "AssignmentPattern":
      return binds(pattern.left, name);
    case "RestElement":
      return binds(pattern.argument, name);
    case "ArrayPattern":
      return pattern.elements.some((e) => e !== null && binds(e, name));
    case "ObjectPattern":
      return pattern.properties.some((p) => binds(p.type === "RestElement" ? p : p.value, name));
    case "TSParameterProperty":
      return binds(pattern.parameter, name);
    default:
      return false;
  }
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

// `defineVars` tokens

/** A whole value that names a `defineVars` token, `<group>.<key>`. No CSS value has this shape. */
const VAR_REF = /^([A-Za-z_$][\w$]*)\.([A-Za-z_][\w-]*)$/;

/** A `<group>.<key>` inside a longer value, as a whole word: not part of a longer name or file name. */
const VAR_WORD = /(?<![\w$.-])[A-Za-z_$][\w$]*\.[A-Za-z_][\w-]*(?![\w$.-])/g;

/** A quoted CSS string, or the contents of a `url(...)`. Text of CSS, never a token. */
const CSS_TEXT =
  /"(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?|(?<![\w-])url\((?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^)])*\)?/gi;

/** The `<group>.<key>` words of `value` that are CSS, outside quoted strings and `url(...)`. */
function varWords(value: string): RegExpExecArray[] {
  const text = [...value.matchAll(CSS_TEXT)].map((m) => [m.index, m.index + m[0].length] as const);
  return [...value.matchAll(VAR_WORD)].filter(
    (m) => !text.some(([from, to]) => m.index >= from && m.index < to),
  ) as RegExpExecArray[];
}

/** Whether a token name is a StyleX `defineVars` variable, `<group>.<key>`. */
export const isStylexVar = (name: string) => VAR_REF.test(name);

/** Whether a value in `styles` may hold a token reference, so the design's tokens are worth loading. */
export const mentionsVar = (styles: Record<string, string | null>) =>
  Object.values(styles).some((v) => v !== null && varWords(v).length > 0);

/** The values in `styles` that name a `defineVars` token, like `colors.brand`. */
export function varRefs(styles: Record<string, string | null>): string[] {
  return [
    ...new Set(Object.values(styles).filter((v): v is string => v !== null && isStylexVar(v))),
  ];
}

/**
 * `text` writes a value of `styles`: a whole token as its member expression, a value with known
 * tokens inside as a template literal, anything else as a string. `import` is the import to add
 * for the groups `file` doesn't import yet: `import { colors } from "../tokens.stylex";` after the
 * other imports. A group imported under another local name is used by that name; a group whose
 * name is taken by something else refuses.
 */
function useVars(
  code: string,
  ast: t.File,
  file: string,
  styles: Record<string, string | null>,
  vars: Record<string, string>,
): { text: (value: string) => string; import?: { at: number; text: string } } {
  const refs: Record<string, string> = {};
  const missing = new Map<string, Set<string>>();
  const inside = (value: string) =>
    isStylexVar(value)
      ? []
      : varWords(value)
          .map((m) => m[0])
          .filter((m) => vars[m]);
  const named = Object.values(styles).filter((v): v is string => v !== null);
  for (const ref of new Set([...varRefs(styles), ...named.flatMap(inside)])) {
    const home = vars[ref];
    if (!home)
      throw new Refused(
        `${ref} isn't a StyleX token in this design's *.stylex.ts files. Add it under Tokens first, or ask the agent.`,
        "not-found",
      );
    const [group, k] = ref.split(".") as [string, string];
    let local = importedAs(ast, file, group, home);
    if (local === undefined) {
      if (bound(ast, group))
        throw refuse(
          `${file} already has something named ${group} that isn't imported from ${home}, so Finite can't import the StyleX token ${ref}`,
        );
      local = group;
      missing.set(home, (missing.get(home) ?? new Set()).add(group));
    }
    refs[ref] = /^[A-Za-z_$][\w$]*$/.test(k) ? `${local}.${k}` : `${local}[${JSON.stringify(k)}]`;
  }
  const text = (value: string) => {
    if (refs[value] !== undefined && isStylexVar(value)) return refs[value]!;
    const found = inside(value);
    if (found.length === 0) return JSON.stringify(value);
    const escape = (raw: string) => raw.replace(/[\\`]|\$\{/g, (c) => `\\${c}`);
    let at = 0;
    let out = "";
    for (const m of varWords(value)) {
      if (!vars[m[0]]) continue;
      out += `${escape(value.slice(at, m.index))}\${${refs[m[0]]}}`;
      at = m.index + m[0].length;
    }
    return `\`${out}${escape(value.slice(at))}\``;
  };
  if (missing.size === 0) return { text };
  const imports = ast.program.body.filter((s) => s.type === "ImportDeclaration");
  const last = imports.at(-1);
  const quote = last ? code[last.source.start!] : '"';
  const semi = last ? code.slice(last.start!, last.end!).endsWith(";") : true;
  const lines = [...missing].map(
    ([home, groups]) =>
      `import { ${[...groups].join(", ")} } from ${quote}${specTo(file, home, false)}${quote}${semi ? ";" : ""}`,
  );
  if (last) return { text, import: { at: last.end!, text: lines.map((l) => `\n${l}`).join("") } };
  return { text, import: { at: ast.program.body[0]?.start ?? 0, text: `${lines.join("\n")}\n\n` } };
}

/** The local name `file` imports `group` from `home` under, if it does. */
function importedAs(ast: t.File, file: string, group: string, home: string): string | undefined {
  for (const stmt of ast.program.body) {
    if (stmt.type !== "ImportDeclaration" || stmt.importKind === "type") continue;
    const spec = stmt.source.value;
    if (!isRelative(spec) || !candidates(resolveSpec(file, spec)).includes(home)) continue;
    for (const s of stmt.specifiers) {
      if (s.type !== "ImportSpecifier" || s.importKind === "type") continue;
      const name = s.imported.type === "Identifier" ? s.imported.name : s.imported.value;
      if (name === group) return s.local.name;
    }
  }
  return undefined;
}

/** Whether the module's top level binds `name`: an import, a variable, a function, a class or an enum. */
function bound(ast: t.File, name: string): boolean {
  return ast.program.body.some((stmt) => {
    if (stmt.type === "ImportDeclaration")
      return stmt.specifiers.some((s) => s.local.name === name);
    const decl =
      stmt.type === "ExportNamedDeclaration" || stmt.type === "ExportDefaultDeclaration"
        ? stmt.declaration
        : stmt;
    if (decl?.type === "VariableDeclaration")
      return decl.declarations.some((d) => binds(d.id, name));
    if (
      decl?.type === "FunctionDeclaration" ||
      decl?.type === "ClassDeclaration" ||
      decl?.type === "TSEnumDeclaration"
    )
      return decl.id?.name === name;
    return false;
  });
}

const DARK = /^@media\s*\(\s*prefers-color-scheme\s*:\s*dark\s*\)$/;
const DARK_KEY = JSON.stringify("@media (prefers-color-scheme: dark)");

/** The `export const <group> = stylex.defineVars({…})` objects at the top level, by group. */
function defineVars(ast: t.File): Map<string, t.ObjectExpression> {
  const b = bindings(ast);
  const out = new Map<string, t.ObjectExpression>();
  for (const stmt of ast.program.body) {
    if (stmt.type !== "ExportNamedDeclaration") continue;
    if (stmt.declaration?.type !== "VariableDeclaration") continue;
    for (const d of stmt.declaration.declarations) {
      const arg = d.init?.type === "CallExpression" ? d.init.arguments[0] : undefined;
      if (
        d.id.type === "Identifier" &&
        d.init?.type === "CallExpression" &&
        calls(b, d.init.callee, "defineVars") &&
        arg?.type === "ObjectExpression"
      )
        out.set(d.id.name, arg);
    }
  }
  return out;
}

/** A plain, non-computed key, or `undefined` for a spread, a method or a computed key. */
function propKey(p: t.Node): string | undefined {
  return p.type === "ObjectProperty" && !p.computed ? keyName(p.key) : undefined;
}

/** A value written as a literal: a string, a number (negative too) or a template without `${}`. */
function literalOf(node: t.Node): string | undefined {
  if (node.type === "StringLiteral") return node.value;
  if (node.type === "NumericLiteral") return String(node.value);
  if (
    node.type === "UnaryExpression" &&
    node.operator === "-" &&
    node.argument.type === "NumericLiteral"
  )
    return String(-node.argument.value);
  if (node.type === "TemplateLiteral" && node.expressions.length === 0)
    return node.quasis[0]!.value.cooked ?? undefined;
  return undefined;
}

/**
 * A `*.stylex.ts` file's `defineVars` groups and their tokens, named `<group>.<key>`. Light is a
 * literal value or a conditional value's `default`, dark its `@media (prefers-color-scheme: dark)`
 * branch. Values built from code are left out.
 */
export function readVars(file: string, code: string): { groups: string[]; tokens: Token[] } {
  const groups = defineVars(parseModule(code, file));
  const tokens: Token[] = [];
  for (const [group, obj] of groups) {
    for (const p of obj.properties) {
      const k = propKey(p);
      if (k === undefined || !isStylexVar(`${group}.${k}`)) continue;
      const value = (p as t.ObjectProperty).value;
      const token: Token = { name: `${group}.${k}` };
      const light = literalOf(value);
      if (light !== undefined) token.light = light;
      else if (value.type === "ObjectExpression") {
        for (const q of value.properties) {
          const qk = propKey(q);
          const v = qk === undefined ? undefined : literalOf((q as t.ObjectProperty).value);
          if (v === undefined) continue;
          if (qk === "default") token.light = v;
          else if (DARK.test(qk!)) token.dark = v;
        }
      }
      if (token.light !== undefined || token.dark !== undefined) tokens.push(token);
    }
  }
  return { groups: [...groups.keys()], tokens };
}

/**
 * Sets (or with `null`, removes) one `defineVars` token's value in one mode, keeping its other
 * branches. A dark value turns a plain value into `{ default, "@media (prefers-color-scheme: dark)" }`,
 * and removing it turns that back into the plain value. A new token goes after the group's others.
 */
export function writeVar(
  file: string,
  code: string,
  name: string,
  mode: TokenMode,
  value: string | null,
): string {
  const [group, k] = name.split(".") as [string, string];
  const obj = defineVars(parseModule(code, file)).get(group);
  if (!obj) throw new Refused(`${file} has no defineVars named ${group}`, "not-found");
  const splice = (node: t.Node, text: string) =>
    code.slice(0, node.start!) + text + code.slice(node.end!);
  const literal = value === null ? "null" : JSON.stringify(value);
  const prop = obj.properties.find((p) => propKey(p) === k) as t.ObjectProperty | undefined;
  const top = (edit: string | null) =>
    splice(
      obj,
      rebuild(code, obj, (p) => (p === prop ? edit : undefined), []),
    );
  if (!prop) {
    if (value === null) return code;
    if (mode === "dark")
      throw new Refused(
        `${name} doesn't exist yet. Set its Light value first: a StyleX variable needs a default.`,
        "invalid",
      );
    const keyText = /^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k);
    return splice(
      obj,
      rebuild(code, obj, () => undefined, [`${keyText}: ${literal}`]),
    );
  }
  const v = prop.value;
  const head = code.slice(prop.start!, v.start!);
  if (literalOf(v) !== undefined) {
    if (mode === "light") return top(value === null ? null : `${head}${literal}`);
    if (value === null) return code;
    const branches = [`default: ${code.slice(v.start!, v.end!)}`, `${DARK_KEY}: ${literal}`];
    const indent = indentAt(code, prop.start!);
    const text = code.slice(obj.start!, obj.end!).includes("\n")
      ? `{\n${branches.map((b) => `${indent}  ${b},`).join("\n")}\n${indent}}`
      : `{ ${branches.join(", ")} }`;
    return splice(v, text);
  }
  if (v.type !== "ObjectExpression" || v.properties.some((q) => propKey(q) === undefined))
    throw refuse(`${name} is built from code, so Finite can't edit it by hand`);
  const isBranch = (q: t.Node) =>
    mode === "light" ? propKey(q) === "default" : DARK.test(propKey(q)!);
  const branch = v.properties.find(isBranch) as t.ObjectProperty | undefined;
  if (branch?.value.type === "ObjectExpression")
    throw refuse(
      `${name} has a nested ${mode === "light" ? "default" : "dark"} value, so Finite can't tell which to edit`,
    );
  const rest = v.properties.filter((q) => q !== branch) as t.ObjectProperty[];
  if (value === null) {
    if (!branch) return code;
    if (mode === "light" && rest.length > 0)
      throw new Refused(
        `${name} needs a default while it has other values, since StyleX requires one. Clear its Dark value first.`,
        "invalid",
      );
    if (rest.length === 0) return top(null);
    // Only the default left: back to a plain value.
    if (rest.length === 1 && propKey(rest[0]!) === "default")
      return splice(v, code.slice(rest[0]!.value.start!, rest[0]!.value.end!));
  }
  return splice(
    v,
    rebuild(
      code,
      v,
      (q) =>
        q !== branch
          ? undefined
          : value === null
            ? null
            : `${code.slice(q.start!, q.value.start!)}${literal}`,
      branch || value === null ? [] : [`${mode === "light" ? "default" : DARK_KEY}: ${literal}`],
    ),
  );
}
