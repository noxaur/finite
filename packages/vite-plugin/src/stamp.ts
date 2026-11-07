import { createHash } from "node:crypto";
import MagicString, { type SourceMap } from "magic-string";
import { type AstNode, parseModule, walk } from "./ast.ts";

export const LOC_ATTR = "data-finite-loc";
export const REV_ATTR = "data-finite-rev";

/** The first 8 hex digits of the sha1 of a file's source, the `rev` source edits compare against. */
export function rev(code: string): string {
  return createHash("sha1").update(code).digest("hex").slice(0, 8);
}

/**
 * Adds `data-finite-loc="<file>:<line>:<col>"` (1-based line, 0-based column of the `<`) and
 * `data-finite-rev` to every intrinsic (lowercase) JSX element. Components, member expressions
 * and fragments are left alone. `file` is the posix path relative to the design root; `source`
 * names the file in the source map. Returns
 * `null` when there is nothing to stamp or the module doesn't parse (Vite reports that itself).
 */
export function stamp(
  code: string,
  file: string,
  source = file,
): { code: string; map: SourceMap } | null {
  const ast = parseModule(code, file);
  if (!ast) return null;
  const hash = rev(code);
  const s = new MagicString(code);
  walk(ast, (node) => {
    if (node.type !== "JSXOpeningElement") return;
    const name = node.name as AstNode;
    if (name.type !== "JSXIdentifier" || !/^[a-z]/.test(name.name as string)) return;
    const attributes = node.attributes as AstNode[];
    const stamped = attributes.some(
      (a) => a.type === "JSXAttribute" && (a.name as AstNode).name === LOC_ATTR,
    );
    if (stamped) return;
    const { line, column } = node.loc.start;
    s.appendLeft(name.end, ` ${LOC_ATTR}="${file}:${line}:${column}" ${REV_ATTR}="${hash}"`);
  });
  if (!s.hasChanged()) return null;
  return { code: s.toString(), map: s.generateMap({ hires: true, source, includeContent: true }) };
}
