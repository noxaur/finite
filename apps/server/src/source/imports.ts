import path from "node:path";
import type * as t from "@babel/types";
import MagicString from "magic-string";
import { parseModule, walk } from "./jsx.ts";

const EXTENSIONS = [".tsx", ".ts", ".jsx", ".js"];

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
  if (!EXTENSIONS.includes(ext) && ext !== ".css") {
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

/** Local names bound to a default or namespace import of a `*.module.css` file, and the file. */
export function cssModules(ast: t.File, file: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const node of ast.program.body) {
    if (node.type !== "ImportDeclaration" || !node.source.value.endsWith(".module.css")) continue;
    if (!isRelative(node.source.value)) continue;
    for (const spec of node.specifiers) {
      if (spec.type === "ImportDefaultSpecifier" || spec.type === "ImportNamespaceSpecifier") {
        out.set(spec.local.name, resolveSpec(file, node.source.value));
      }
    }
  }
  return out;
}
