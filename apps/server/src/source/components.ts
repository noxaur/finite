import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type * as t from "@babel/types";
import type { ComponentInfo } from "@finite/protocol";
import { parseModule } from "./jsx.ts";

const PASCAL = /^[A-Z][A-Za-z0-9]*$/;
const WRAPPERS = new Set(["memo", "forwardRef", "observer"]);

/** Exported PascalCase function components in `src/**` (tests and stories left out). */
export async function listComponents(root: string): Promise<ComponentInfo[]> {
  let entries: string[];
  try {
    entries = await readdir(path.join(root, "src"), { recursive: true });
  } catch {
    return [];
  }
  const files = entries
    .map((e) => `src/${e.split(path.sep).join("/")}`)
    .filter((f) => /\.(tsx|jsx)$/.test(f) && !/\.(test|spec|stories)\.[jt]sx$/.test(f))
    .filter((f) => !f.split("/").some((part) => part === "node_modules" || part.startsWith(".")))
    .sort();
  const out: ComponentInfo[] = [];
  for (const file of files) {
    let ast: t.File;
    try {
      ast = parseModule(await readFile(path.join(root, file), "utf8"), file);
    } catch {
      continue; // a file that doesn't parse has no components we can copy
    }
    out.push(...exportedComponents(ast, file));
  }
  return out;
}

export function exportedComponents(ast: t.File, file: string): ComponentInfo[] {
  const local = new Set<string>();
  for (const node of ast.program.body) {
    const decl = node.type === "ExportNamedDeclaration" ? node.declaration : node;
    for (const name of componentNames(decl)) local.add(name);
  }

  const out: ComponentInfo[] = [];
  const add = (name: string, exportName: string) => {
    if (PASCAL.test(name) && !out.some((c) => c.exportName === exportName))
      out.push({ name, file, exportName });
  };
  for (const node of ast.program.body) {
    if (node.type === "ExportNamedDeclaration") {
      for (const name of componentNames(node.declaration)) add(name, name);
      if (!node.source) {
        for (const spec of node.specifiers) {
          if (spec.type !== "ExportSpecifier" || spec.local.type !== "Identifier") continue;
          const name = spec.local.name;
          if (!local.has(name)) continue;
          const exported =
            spec.exported.type === "Identifier" ? spec.exported.name : spec.exported.value;
          if (exported === "default") add(name, "default");
          else add(exported, exported);
        }
      }
    } else if (node.type === "ExportDefaultDeclaration") {
      const d = node.declaration;
      if (
        d.type === "FunctionDeclaration" ||
        d.type === "ArrowFunctionExpression" ||
        isWrapped(d)
      ) {
        const own = d.type === "FunctionDeclaration" ? d.id?.name : undefined;
        add(own ?? path.posix.basename(file).replace(/\.[jt]sx$/, ""), "default");
      } else if (d.type === "Identifier" && local.has(d.name)) {
        add(d.name, "default");
      }
    }
  }
  return out;
}

function componentNames(decl: t.Node | null | undefined): string[] {
  if (!decl) return [];
  if (decl.type === "FunctionDeclaration" && decl.id && PASCAL.test(decl.id.name))
    return [decl.id.name];
  if (decl.type !== "VariableDeclaration") return [];
  return decl.declarations.flatMap((d) =>
    d.id.type === "Identifier" && PASCAL.test(d.id.name) && d.init && isComponentInit(d.init)
      ? [d.id.name]
      : [],
  );
}

function isComponentInit(init: t.Node): boolean {
  return (
    init.type === "ArrowFunctionExpression" || init.type === "FunctionExpression" || isWrapped(init)
  );
}

/** `memo(...)`, `React.forwardRef(...)` and friends. */
function isWrapped(node: t.Node): boolean {
  if (node.type !== "CallExpression") return false;
  const callee = node.callee;
  const name =
    callee.type === "Identifier"
      ? callee.name
      : callee.type === "MemberExpression" && callee.property.type === "Identifier"
        ? callee.property.name
        : undefined;
  return name !== undefined && WRAPPERS.has(name);
}
