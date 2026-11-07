import { parse } from "@babel/parser";

/** The few Babel AST fields this package reads. Babel's own types live in `@babel/types`. */
export type AstNode = {
  type: string;
  start: number;
  end: number;
  loc: { start: { line: number; column: number } };
  [key: string]: unknown;
};

/** Parses a module with the syntax its extension allows, or returns `null` when it doesn't parse. */
export function parseModule(code: string, file: string): AstNode | null {
  const ts = /\.[cm]?tsx?$/.test(file);
  const jsx = !/\.[cm]?ts$/.test(file);
  try {
    const ast = parse(code, {
      sourceType: "module",
      plugins: [...(ts ? (["typescript"] as const) : []), ...(jsx ? (["jsx"] as const) : [])],
    });
    return ast.program as unknown as AstNode;
  } catch {
    return null;
  }
}

export function isNode(value: unknown): value is AstNode {
  return typeof value === "object" && value !== null && typeof (value as AstNode).type === "string";
}

/** Visits every node depth-first, parents before children. */
export function walk(node: AstNode, visit: (node: AstNode) => void): void {
  visit(node);
  for (const key in node) {
    if (key === "loc" || key === "leadingComments" || key === "trailingComments") continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const item of value) if (isNode(item)) walk(item, visit);
    } else if (isNode(value)) {
      walk(value, visit);
    }
  }
}
