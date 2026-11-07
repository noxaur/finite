import path from "node:path";
import { Refused, type Styling, type Token, type TokenMode } from "@finite/protocol";
import postcss, {
  type AtRule,
  type ChildNode,
  type Container,
  type Declaration,
  type Node,
  type Root,
  type Rule,
} from "postcss";
import { BLOCK, parseCss, printCss, setDecls } from "./css.ts";
import { importCandidates, resolveSpec } from "./imports.ts";

/**
 * Tokens are CSS custom properties. Light values come from `@theme` blocks (and `:root`/`html`,
 * where shadcn-style themes keep them); dark values from `.dark` rules,
 * `@media (prefers-color-scheme: dark)`, and `@variant dark` blocks, the three ways a Tailwind v4
 * stylesheet writes dark mode. New dark tokens go in a `.dark` rule. The sheets may be `.css`,
 * `.scss` or `.less`. A top-level Sass `$var` in a `.scss` sheet or Less `@var` in a `.less` one is
 * a token too, named with its sigil, with a light value only. A `partial` (a local file a global
 * `.scss` sheet loads) gives its `$vars` only.
 */
export function readTokens(sheets: Sheet[]): Token[] {
  const tokens = new Map<string, Token>();
  const set = (name: string, mode: TokenMode, value: string) => {
    const token = tokens.get(name) ?? { name };
    token[mode] = value;
    tokens.set(name, token);
  };
  for (const { file, css, partial } of sheets) {
    parseCss(file, css).walk((node) => {
      const variable = variableOf(file, node);
      if (variable) return set(variable.name, "light", flagless(variable.value));
      if (partial || node.type !== "decl" || !node.prop.startsWith("--")) return;
      const mode = modeOf(node);
      if (mode) set(node.prop, mode, node.value);
    });
  }
  return [...tokens.values()];
}

/** A global stylesheet, or (`partial`) a local `.scss` file one of them loads. */
export type Sheet = { file: string; css: string; partial?: boolean };

/**
 * Where a Sass `$var` or Less `@var` token is defined: the file, and whether that file outputs CSS
 * of its own, or through a sheet it loads, which a module's `@use` of it would copy. Less sheets
 * never do, since a module imports them by reference. `unresolved` names a `$var` the file's
 * declarations use without defining it or loading it with `@use`/`@forward` (it got it from a
 * legacy `@import` chain), so a module's `@use` of it can't compile.
 */
export type VariableHome = {
  file: string;
  emitsCss: boolean;
  unresolved?: { name: string; definedIn?: string };
};

/**
 * The sheet that defines each Sass `$var` and Less `@var` token, by name. A name declared twice
 * belongs to the last, the one `readTokens` shows.
 */
export function variableSheets(sheets: Sheet[]): Record<string, VariableHome> {
  const roots = new Map(sheets.map((s) => [s.file, parseCss(s.file, s.css)]));
  const out: Record<string, VariableHome> = {};
  for (const [file, root] of roots) {
    const scss = path.posix.extname(file) === ".scss";
    const home: VariableHome = { file, emitsCss: scss && emitsCss(file, roots) };
    const unresolved = scss ? unresolvedRef(file, roots) : undefined;
    if (unresolved) home.unresolved = unresolved;
    for (const node of root.nodes) {
      const variable = variableOf(file, node);
      if (variable) out[variable.name] = home;
    }
  }
  return out;
}

const QUIET = new Set(["use", "forward", "mixin", "function"]);

/** A `@use` or `@forward` of a plain `.css` file, which Sass copies into its output. */
const PLAIN_CSS = /^\s*(["'])[^"']*\.css\1/;

/**
 * Whether a Sass sheet outputs CSS: anything at its top level but comments, `$vars`, `@use`,
 * `@forward`, `@mixin` and `@function`, a `@use` or `@forward` of a `.css` file, or a local sheet
 * it `@use`s or `@forward`s that does.
 */
function emitsCss(file: string, roots: Map<string, Root>, seen = new Set([file])): boolean {
  const root = roots.get(file)!;
  const own = root.nodes.some(
    (n) =>
      n.type !== "comment" &&
      !(n.type === "decl" && n.prop.startsWith("$")) &&
      !(n.type === "atrule" && QUIET.has(n.name) && !PLAIN_CSS.test(n.params)),
  );
  return (
    own ||
    loads(file, roots).some(({ dep }) => {
      if (seen.has(dep)) return false;
      seen.add(dep);
      return emitsCss(dep, roots, seen);
    })
  );
}

/** The local sheets `file` loads with `@use` or `@forward`, and whether a `@use` is `as *`. */
function loads(
  file: string,
  roots: Map<string, Root>,
): { dep: string; rule: "use" | "forward"; star: boolean }[] {
  return roots.get(file)!.nodes.flatMap((n) => {
    if (n.type !== "atrule" || (n.name !== "use" && n.name !== "forward")) return [];
    const spec = /["']([^"']+)["']/.exec(n.params)?.[1];
    if (spec === undefined) return [];
    // Sass looks for a bare `@use "tokens"` next to the sheet.
    const target = spec.startsWith("/")
      ? spec.slice(1)
      : resolveSpec(file, /^\.{1,2}\//.test(spec) ? spec : `./${spec}`);
    const dep = importCandidates(file, target).find((c) => roots.has(c));
    return dep ? [{ dep, rule: n.name, star: /\bas\s+\*/.test(n.params) }] : [];
  });
}

/**
 * A `$var` the top-level declarations of the Sass sheet `file` use that it neither defines nor
 * reaches bare: through `@use … as *`, or a `@forward` of a sheet that is, with a sheet that
 * defines it. Under `@import` it's all one scope; as a module, `file` can't see it.
 */
function unresolvedRef(
  file: string,
  roots: Map<string, Root>,
): VariableHome["unresolved"] | undefined {
  const defined = (f: string) =>
    new Set(roots.get(f)!.nodes.flatMap((n) => variableOf(f, n)?.name ?? []));
  // A module sees its own private `$vars`; other modules see only the public ones.
  const visible = new Set(
    roots
      .get(file)!
      .nodes.flatMap((n) => (n.type === "decl" && n.prop.startsWith("$") ? n.prop : [])),
  );
  const seen = new Set<string>();
  const expose = (dep: string) => {
    if (seen.has(dep)) return;
    seen.add(dep);
    for (const name of defined(dep)) visible.add(name);
    for (const next of loads(dep, roots)) if (next.rule === "forward") expose(next.dep);
  };
  for (const { dep, rule, star } of loads(file, roots)) if (rule === "use" && star) expose(dep);
  for (const node of roots.get(file)!.nodes) {
    const value = variableOf(file, node)?.value;
    if (value === undefined) continue;
    const name = variableRefs({ value }).find((ref) => ref[0] === "$" && !visible.has(ref));
    if (name === undefined) continue;
    const definedIn = [...roots.keys()].find((f) => f !== file && defined(f).has(name));
    return definedIn ? { name, definedIn } : { name };
  }
  return undefined;
}

/** A token name that's a Sass `$var` or Less `@var` rather than a custom property. */
export const isVariable = (name: string) => name.startsWith("$") || name.startsWith("@");

const DIALECTS = { $: { ext: ".scss", kind: "Sass" }, "@": { ext: ".less", kind: "Less" } };
const dialectOf = (name: string) => DIALECTS[name[0] as "$" | "@"];

/** Sass keeps `$_name` and `$-name` private to their module, so a `@use` can't reach them. */
const PRIVATE = /^\$[_-]/;

/** A top-level `$name: value;` in a `.scss` sheet or `@name: value;` in a `.less` one. */
function variableOf(file: string, node: Node): { name: string; value: string } | undefined {
  if (node.parent?.type !== "root") return undefined;
  const ext = path.posix.extname(file);
  const decl = node as Declaration;
  if (
    ext === ".scss" &&
    decl.type === "decl" &&
    decl.prop.startsWith("$") &&
    !PRIVATE.test(decl.prop)
  )
    return { name: decl.prop, value: decl.value };
  const at = node as AtRule & { variable?: boolean; value?: string };
  if (ext === ".less" && at.type === "atrule" && at.variable && !at.nodes)
    return { name: `@${at.name}`, value: at.value ?? at.params };
  return undefined;
}

/** Sass's `!default` and `!global` flags, which a value keeps when it's changed. */
const FLAGS = /(\s*!(default|global))+\s*$/;
const flagless = (value: string) => value.replace(FLAGS, "");

/** Light values with `var(--x)` references followed, for matching hand-edited values to theme names. */
export function lightTheme(tokens: Token[]): Record<string, string> {
  const raw = new Map(
    tokens.flatMap((t) =>
      t.light === undefined || isVariable(t.name) ? [] : [[t.name, t.light] as const],
    ),
  );
  const resolve = (value: string, depth = 0): string => {
    const ref = /^var\((--[\w-]+)\)$/.exec(value.trim());
    const next = ref ? raw.get(ref[1]!) : undefined;
    return next === undefined || depth > 8 ? value : resolve(next, depth + 1);
  };
  return Object.fromEntries([...raw].map(([k, v]) => [k, resolve(v)]));
}

export function hasToken(file: string, css: string, name: string, mode: TokenMode): boolean {
  const root = parseCss(file, css);
  return (isVariable(name) ? findVariable(file, root, name) : find(root, name, mode)) !== undefined;
}

/**
 * Sets (or with `null`, removes) one token in one mode. A new light token goes in `@theme` for a
 * Tailwind design, else in the first `:root` rule. A Sass or Less variable has no dark mode; a new
 * one goes after the sheet's last top-level variable, else after its `@use`s and `@import`s.
 */
export function writeToken(
  file: string,
  css: string,
  name: string,
  mode: TokenMode,
  value: string | null,
  styling: Styling,
): string {
  const root = parseCss(file, css);
  if (isVariable(name)) return writeVariable(file, root, name, mode, value) ?? css;
  const existing = find(root, name, mode);
  if (existing) {
    setDecls(existing.parent as Container, { [name]: value });
    return printCss(file, root);
  }
  if (value === null) return css;
  const block =
    mode === "dark" ? darkBlock(root) : styling === "tailwind" ? themeBlock(root) : rootBlock(root);
  setDecls(block, { [name]: value });
  return printCss(file, root);
}

function writeVariable(
  file: string,
  root: Root,
  name: string,
  mode: TokenMode,
  value: string | null,
): string | undefined {
  const { ext, kind } = dialectOf(name);
  if (mode === "dark")
    throw new Refused(
      `${name} is a ${kind} variable, which has one value and no dark mode. Set its light value, or use a CSS custom property (--${name.slice(1)}) for a token that changes in dark mode.`,
      "invalid",
    );
  if (path.posix.extname(file) !== ext)
    throw new Refused(`${name} is a ${kind} variable, so it can't go in ${file}`, "invalid");
  const existing = findVariable(file, root, name);
  if (existing && value === null) existing.remove();
  else if (existing?.type === "decl")
    existing.value = value + (FLAGS.exec(existing.value)?.[0] ?? "");
  else if (existing) Object.assign(existing, { value, params: value });
  else if (value === null) return undefined;
  else {
    const node =
      ext === ".scss"
        ? postcss.decl({ prop: name, value, raws: { between: ": " } })
        : Object.assign(
            postcss.atRule({ name: name.slice(1), params: value, raws: { afterName: ": " } }),
            { variable: true, value },
          );
    const after =
      root.nodes.findLast((n) => variableOf(file, n)) ??
      root.nodes.findLast((n) => n.type === "atrule" && PREAMBLE.has(n.name));
    if (after) {
      after.after(node);
      node.raws.before = "\n";
    } else {
      root.prepend(node);
      node.raws.before = "";
      const next = node.next();
      if (next && !/\n\s*\n/.test(next.raws.before ?? "")) next.raws.before = "\n\n";
    }
  }
  return printCss(file, root);
}

function findVariable(file: string, root: Root, name: string): ChildNode | undefined {
  return root.nodes.findLast((n) => variableOf(file, n)?.name === name);
}

export function tokenName(name: string): string {
  const n = name.trim();
  if (!/^(--|\$|@)?[A-Za-z_][\w-]*$/.test(n))
    throw new Refused(
      `${name} isn't a CSS custom property, Sass variable or Less variable name`,
      "invalid",
    );
  return n.startsWith("--") || isVariable(n) ? n : `--${n}`;
}

/**
 * Where `name` lives for `tokens.set`: the last sheet that has it, else the first of its dialect that
 * outputs no CSS (so a module can `@use` it), else the first of its dialect.
 */
export function variableHome(name: string, sheets: Sheet[]): Sheet {
  const { ext, kind } = dialectOf(name);
  const ofDialect = sheets.filter((s) => path.posix.extname(s.file) === ext);
  const roots = new Map(sheets.map((s) => [s.file, parseCss(s.file, s.css)]));
  const home =
    sheets.findLast((s) => hasToken(s.file, s.css, name, "light")) ??
    ofDialect.find((s) => ext === ".scss" && !emitsCss(s.file, roots)) ??
    ofDialect[0];
  if (!home)
    throw new Refused(
      `${name} is a ${kind} variable, but none of this design's stylesheets is ${ext}. Add one to css in .finite/design.json, or use a CSS custom property (--${name.slice(1)}).`,
      "invalid",
    );
  return home;
}

function find(root: Root, name: string, mode: TokenMode): Declaration | undefined {
  let found: Declaration | undefined;
  root.walkDecls(name, (decl) => {
    if (modeOf(decl) === mode) found = decl;
  });
  return found;
}

function modeOf(decl: Declaration): TokenMode | undefined {
  let light = false;
  for (
    let node: Node | undefined = decl.parent as Node | undefined;
    node && node.type !== "root";
    node = node.parent as Node | undefined
  ) {
    if (node.type === "rule" && isDarkSelector((node as Rule).selector)) return "dark";
    if (node.type === "atrule") {
      const at = node as AtRule;
      if (at.name === "media" && /prefers-color-scheme:\s*dark/.test(at.params)) return "dark";
      if (at.name === "variant" && at.params.trim() === "dark") return "dark";
      if (at.name === "theme") light = true;
    }
    if (node.type === "rule" && /^(:root|html)$/.test((node as Rule).selector.trim())) light = true;
  }
  return light ? "light" : undefined;
}

function isDarkSelector(selector: string): boolean {
  return selector
    .split(",")
    .some((s) => /^(:root|html)?(\.dark|\[data-theme=["']?dark["']?\])$/.test(s.trim()));
}

/** The first `@theme` block, added after the imports when there's none. */
function themeBlock(root: Root): Container {
  let theme: AtRule | undefined;
  root.walkAtRules("theme", (at) => {
    theme ??= at;
  });
  if (theme) return theme;
  const block = postcss.atRule({
    name: "theme",
    params: "",
    raws: { ...BLOCK, afterName: "", before: "\n\n" },
  });
  const imports = root.nodes.filter((n) => n.type === "atrule" && n.name === "import");
  const last = imports.at(-1);
  if (last) last.after(block);
  else root.prepend(block);
  return block;
}

const PREAMBLE = new Set(["charset", "use", "forward", "import"]);

/** The first top-level `:root` rule, added after the `@use`, `@forward` and `@import`s when there's none. */
function rootBlock(root: Root): Container {
  const existing = root.nodes.find(
    (n): n is Rule => n.type === "rule" && n.selector.trim() === ":root",
  );
  if (existing) return existing;
  const rule = postcss.rule({ selector: ":root", raws: { ...BLOCK, before: "\n\n" } });
  const last = root.nodes.findLast((n) => n.type === "atrule" && PREAMBLE.has(n.name));
  if (last) last.after(rule);
  else root.prepend(rule);
  rule.raws.before = last ? "\n\n" : "";
  const next = rule.next();
  if (next && !/\n\s*\n/.test(next.raws.before ?? "")) next.raws.before = "\n\n";
  return rule;
}

/** The first dark-mode block, or a new `.dark` rule at the end. */
function darkBlock(root: Root): Container {
  let dark: Container | undefined;
  root.walk((node) => {
    if (dark) return;
    if (node.type === "rule" && isDarkSelector(node.selector)) dark = node;
    else if (node.type === "atrule" && node.name === "variant" && node.params.trim() === "dark")
      dark = node;
    else if (
      node.type === "rule" &&
      /^(:root|html)$/.test(node.selector.trim()) &&
      node.parent?.type === "atrule"
    ) {
      const parent = node.parent as AtRule;
      if (parent.name === "media" && /prefers-color-scheme:\s*dark/.test(parent.params))
        dark = node;
    }
  });
  if (dark) return dark;
  const rule = postcss.rule({ selector: ".dark", raws: { ...BLOCK, before: "\n\n" } });
  root.append(rule);
  return rule;
}

const REF = /(?<![\w.$@-])[$@][A-Za-z_][\w-]*/g;
const QUOTED = /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|url\((?![^)]*\$)[^)]*\))/;

/**
 * Runs `change` on a value outside its quoted strings and `url(...)` without a `$`, and on the
 * `#{…}` interpolations of the quoted strings.
 */
function outsideQuotes(value: string, change: (text: string) => string): string {
  return value
    .split(QUOTED)
    .map((part, i) => (i % 2 === 0 ? change(part) : part.replace(/#\{[^}]*\}/g, change)))
    .join("");
}

/**
 * The Sass `$var` and Less `@var` references in style values, like `$brand` in `1px solid $brand`.
 * Text in quotes and `url(...)` without a `$` isn't one: `url("/img/@logo.svg")` is a path, while
 * `url($asset)` is a reference.
 */
export function variableRefs(styles: Record<string, string | null>): string[] {
  const refs = new Set<string>();
  for (const value of Object.values(styles))
    if (value) outsideQuotes(value, (text) => text.replace(REF, (ref) => (refs.add(ref), ref)));
  return [...refs];
}

/**
 * Lets the module sheet `file` use the variables `styles` refer to: one it defines or already
 * imports is left alone, `@use "x" as ns` turns `$brand` into `ns.$brand`, and otherwise the file
 * that defines it (`variables`, from `variableSheets`) is imported after the module's own: Sass
 * gets `@use "<path>" as *;`, Less `@import (reference) "<path>";`. Sass has no reference-only
 * import, so a Sass file that outputs CSS is refused rather than copied into the module.
 */
export function useVariables(
  file: string,
  css: string,
  styles: Record<string, string | null>,
  variables: Record<string, VariableHome>,
): { css: string; styles: Record<string, string | null> } {
  const refs = variableRefs(styles);
  if (refs.length === 0) return { css, styles };
  const ext = path.posix.extname(file);
  const wrong = refs.find((ref) => dialectOf(ref).ext !== ext);
  if (wrong)
    throw new Refused(
      `${wrong} is a ${dialectOf(wrong).kind} variable, which ${file} can't use. Pick a CSS custom property (--name) token instead, or ask the agent.`,
      "unsupported-style",
    );
  const root = parseCss(file, css);
  const renamed: Record<string, string> = {};
  for (const ref of refs) {
    if (findVariable(file, root, ref) || PRIVATE.test(ref)) continue;
    const home = variables[ref];
    if (!home)
      throw new Refused(
        `${ref} isn't a variable in this design's global stylesheets. Add it under Tokens first, or ask the agent.`,
        "not-found",
      );
    const seen = imported(file, root, home.file);
    if (seen === undefined && home.emitsCss) {
      const partial = path.posix.join(path.posix.dirname(home.file), "_tokens.scss");
      throw new Refused(
        `${ref} is defined in ${home.file}, which also outputs CSS, and a @use would copy all of that CSS into ${file}. Move the $vars into a partial (${partial}) that ${path.posix.basename(home.file)} @uses, then pick it again, or ask the agent.`,
        "unsupported-style",
      );
    }
    if (seen === undefined && home.unresolved) {
      const { name, definedIn } = home.unresolved;
      const use = definedIn
        ? ` Add @use "${useSpec(home.file, definedIn)}" as * to ${home.file},`
        : " Fix that,";
      throw new Refused(
        `${ref} is defined in ${home.file}, which uses ${name} without loading the sheet that defines it (it relies on a legacy @import chain), so a @use of it fails to compile.${use} then pick it again, or ask the agent.`,
        "unsupported-style",
      );
    }
    if (seen === undefined) addImport(file, root, home.file);
    else if (seen !== "*") renamed[ref] = `${seen}.${ref}`;
  }
  const rename = (v: string | null) =>
    v === null ? null : outsideQuotes(v, (text) => text.replace(REF, (ref) => renamed[ref] ?? ref));
  return {
    css: printCss(file, root),
    styles: Object.fromEntries(Object.entries(styles).map(([k, v]) => [k, rename(v)])),
  };
}

/**
 * How the module sees `sheet`'s variables: `*` when it imports it whole (`@import`, `@use … as *`),
 * the namespace of a plain `@use`, or `undefined` when it doesn't load it.
 */
function imported(file: string, root: Root, sheet: string): string | undefined {
  for (const node of root.nodes) {
    if (node.type !== "atrule" || (node.name !== "use" && node.name !== "import")) continue;
    for (const [, spec] of node.params.matchAll(/["']([^"']+)["']/g)) {
      const rel = /^(\.{1,2}\/|\/)/.test(spec!) ? spec! : `./${spec}`;
      if (!importCandidates(file, resolveSpec(file, rel)).includes(sheet)) continue;
      if (node.name === "import") return "*";
      const as = /\bas\s+(\*|[\w-]+)/.exec(node.params)?.[1];
      return (
        as ??
        path.posix
          .basename(spec!)
          .replace(/\.s[ac]ss$/, "")
          .replace(/^_/, "")
      );
    }
  }
  return undefined;
}

/** The `@use` specifier for the Sass sheet `sheet`, from `file`: no extension and no partial underscore. */
const useSpec = (file: string, sheet: string) =>
  path.posix
    .relative(path.posix.dirname(file), sheet)
    .replace(/\.scss$/, "")
    .replace(/(^|\/)_([^/]*)$/, "$1$2");

function addImport(file: string, root: Root, sheet: string): void {
  const sass = path.posix.extname(file) === ".scss";
  const rel = sass ? useSpec(file, sheet) : path.posix.relative(path.posix.dirname(file), sheet);
  const node = sass
    ? postcss.atRule({ name: "use", params: `"${rel}" as *` })
    : postcss.atRule({ name: "import", params: `(reference) "${rel}"` });
  const after = root.nodes.findLast(
    (n) =>
      n.type === "atrule" && (sass ? ["charset", "use", "forward"] : ["import"]).includes(n.name),
  );
  if (after) {
    after.after(node);
    node.raws.before = "\n";
  } else {
    root.prepend(node);
    node.raws.before = "";
    const next = node.next();
    // `prepend` gave the old first node the second one's spacing.
    if (next) next.raws.before = "\n\n";
  }
}
