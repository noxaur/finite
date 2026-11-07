import path from "node:path";
import type * as t from "@babel/types";
import MagicString from "magic-string";
import { parseModule, walk } from "./jsx.ts";

const EXTENSIONS = [".tsx", ".ts", ".jsx", ".js"];
const STYLE_EXTENSIONS = [".css", ".scss", ".sass", ".less"];

/** Every module specifier in the file: imports, re-exports and `import()`. */
export function specifiers(ast: t.File): t.StringLiteral[] {
  const out: t.StringLiteral[] = [];
  walk(ast, (node) => {
    if (
      (node.type === "ImportDeclaration" ||
        node.type === "ExportNamedDeclaration" ||
        node.type === "ExportAllDeclaration") &&
      node.source
    ) {
      out.push(node.source);
    } else if (node.type === "ImportExpression" && node.source.type === "StringLiteral") {
      out.push(node.source);
    } else if (
      node.type === "CallExpression" &&
      node.callee.type === "Import" &&
      node.arguments[0]?.type === "StringLiteral"
    ) {
      out.push(node.arguments[0]);
    }
  });
  return out;
}

export function isRelative(spec: string): boolean {
  return spec.startsWith("./") || spec.startsWith("../");
}

/** The root-relative path `spec` points at from `fromFile`, as written (extension may be missing). */
export function resolveSpec(fromFile: string, spec: string): string {
  return path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), spec));
}

/** The files `spec` could mean, in the order a bundler tries them. */
export function candidates(target: string): string[] {
  const out = [target];
  const ext = path.posix.extname(target);
  if (ext === ".js" || ext === ".jsx") {
    const base = target.slice(0, -ext.length);
    out.push(`${base}.tsx`, `${base}.ts`);
  }
  if (!EXTENSIONS.includes(ext) && !STYLE_EXTENSIONS.includes(ext)) {
    for (const e of EXTENSIONS) out.push(`${target}${e}`);
    for (const e of EXTENSIONS) out.push(`${target}/index${e}`);
  }
  return out;
}

/** A relative specifier from `fromFile` to `target`, keeping the extension only if `keepExt`. */
export function specTo(fromFile: string, target: string, keepExt: boolean): string {
  let rel = path.posix.relative(path.posix.dirname(fromFile), target);
  if (!keepExt) {
    const ext = path.posix.extname(rel);
    if (EXTENSIONS.includes(ext)) rel = rel.slice(0, -ext.length);
    if (rel.endsWith("/index")) rel = rel.slice(0, -"/index".length);
  }
  return rel.startsWith(".") ? rel : `./${rel}`;
}

function hasExt(spec: string): boolean {
  return path.posix.extname(spec) !== "";
}

function replaceLiteral(ms: MagicString, code: string, lit: t.StringLiteral, value: string): void {
  const quote = code[lit.start!] === "'" ? "'" : '"';
  ms.overwrite(lit.start!, lit.end!, `${quote}${value}${quote}`);
}

/** The code of `fromFile` as it should read at `toFile`: relative imports still reach the same files. */
export function moveImports(code: string, fromFile: string, toFile: string): string {
  const ms = new MagicString(code);
  for (const lit of specifiers(parseModule(code, fromFile))) {
    if (!isRelative(lit.value)) continue;
    const target = resolveSpec(fromFile, lit.value);
    replaceLiteral(ms, code, lit, specTo(toFile, target, true).replace(/\/$/, ""));
  }
  return ms.toString();
}

/** Points `importer`'s imports of `oldFile` at `newFile`. Undefined when it doesn't import `oldFile`. */
export function retarget(
  code: string,
  importer: string,
  oldFile: string,
  newFile: string,
): string | undefined {
  const ms = new MagicString(code);
  let found = false;
  for (const lit of specifiers(parseModule(code, importer))) {
    if (!isRelative(lit.value)) continue;
    if (!candidates(resolveSpec(importer, lit.value)).includes(oldFile)) continue;
    found = true;
    replaceLiteral(ms, code, lit, specTo(importer, newFile, hasExt(lit.value)));
  }
  return found ? ms.toString() : undefined;
}

/** Local names bound to a default or namespace import of a `*.module.{css,scss,sass,less}` file, and the file. */
const MODULE_SHEET = /\.module\.(css|scss|sass|less)$/;

export function cssModules(ast: t.File, file: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const node of ast.program.body) {
    if (node.type !== "ImportDeclaration" || !MODULE_SHEET.test(node.source.value)) continue;
    if (!isRelative(node.source.value)) continue;
    for (const spec of node.specifiers) {
      if (spec.type === "ImportDefaultSpecifier" || spec.type === "ImportNamespaceSpecifier") {
        out.set(spec.local.name, resolveSpec(file, node.source.value));
      }
    }
  }
  return out;
}

// Comments go; strings and unquoted `url(...)` stay, since `//` can appear inside them.
const KEEP = String.raw`("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|url\(\s*[^"')\s][^)]*\))`;
const CSS_COMMENTS = new RegExp(String.raw`${KEEP}|/\*[\s\S]*?\*/`, "gi");
const DIALECT_COMMENTS = new RegExp(String.raw`${KEEP}|/\*[\s\S]*?\*/|//[^\n]*`, "gi");
const NAMES = /"([^"]*)"|'([^']*)'|url\(\s*([^"')\s][^)]*?)\s*\)/g;

/** The stylesheet's `@import`, `@use`, `@forward` and `url()` specifiers, with comments ignored. */
export function sheetSpecifiers(
  file: string,
  code: string,
): { spec: string; rule: "import" | "use" | "forward" | "url" }[] {
  const ext = path.posix.extname(file);
  const dialect = ext === ".scss" || ext === ".sass" || ext === ".less";
  const plain = code.replace(
    dialect ? DIALECT_COMMENTS : CSS_COMMENTS,
    (_, keep?: string) => keep ?? "",
  );
  const specs: { spec: string; rule: "import" | "use" | "forward" | "url" }[] = [];
  if (dialect) {
    // Sass and Less look for a bare `@use "tokens"` next to the sheet, so it reads as `./tokens`.
    const end = ext === ".sass" ? String.raw`\n` : ";{}";
    for (const m of plain.matchAll(new RegExp(`@(import|use|forward)\\s+([^${end}]*)`, "g"))) {
      const names = [...m[2]!.matchAll(NAMES)].map((n) => n[1] ?? n[2] ?? n[3]!);
      const rule = m[1] as "import" | "use" | "forward";
      for (const spec of rule === "import" ? names : names.slice(0, 1)) {
        if (/^(\/(?!\/)|\.{1,2}\/)/.test(spec)) specs.push({ spec, rule });
        else if (!/^([a-z][\w+.-]*:|\/\/|~)|[#@]\{/i.test(spec))
          specs.push({ spec: `./${spec}`, rule });
      }
    }
  } else {
    for (const m of plain.matchAll(/@import\s+(?:url\(\s*)?["']([^"']+)["']/g))
      specs.push({ spec: m[1]!, rule: "import" });
  }
  for (const m of plain.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g))
    specs.push({ spec: m[1]!, rule: "url" });
  return specs;
}

/**
 * The files an import from `fromFile` could mean. In Sass `@use "a/b"` is `a/b.scss`, the partial
 * `a/_b.scss`, or `a/b/index` (`_index`); a Sass `@import` (`fromImport`) tries the import-only
 * `a/b.import.scss` and `a/_b.import.scss` first. Less adds `.less`. No load paths, only the
 * sheet's folder.
 */
export function importCandidates(fromFile: string, target: string, fromImport = false): string[] {
  const ext = path.posix.extname(fromFile);
  const sass = ext === ".scss" || ext === ".sass";
  if (!sass && ext !== ".less") return candidates(target);
  const partial = (file: string) =>
    path.posix.join(path.posix.dirname(file), `_${path.posix.basename(file)}`);
  if (!sass) return path.posix.extname(target) === ".less" ? [target] : [target, `${target}.less`];
  const targetExt = path.posix.extname(target);
  if (STYLE_EXTENSIONS.includes(targetExt)) {
    const only = `${target.slice(0, -targetExt.length)}.import${targetExt}`;
    return [...(fromImport ? [only, partial(only)] : []), target, partial(target)];
  }
  const exts = [".scss", ".sass", ".css"];
  return [
    ...(fromImport
      ? exts.flatMap((e) => [`${target}.import${e}`, partial(`${target}.import${e}`)])
      : []),
    target,
    ...exts.map((e) => `${target}${e}`),
    ...exts.map((e) => partial(`${target}${e}`)),
    ...exts.map((e) => `${target}/index${e}`),
    ...exts.map((e) => `${target}/_index${e}`),
  ];
}
