import fs from "node:fs";
import path from "node:path";
import type { Route, Router } from "@finite/protocol";
import { type AstNode, parseModule, walk } from "./ast.ts";
import { nextRoutes } from "./next/routes.ts";

/** Loads a module through Vite (`server.ssrLoadModule`), for route configs that are code. */
export type LoadModule = (file: string) => Promise<Record<string, unknown>>;

const EXTENSIONS = [".tsx", ".ts", ".jsx", ".js", ".mts", ".mjs"];
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "coverage", "public"]);
const MAX_SCAN_FILES = 5_000;

/**
 * The app's routes: a scan of Next.js's `app/` or `pages/`, TanStack Router's generated route
 * tree, React Router's framework-mode `routes.ts`, or a scan of the source for
 * `createBrowserRouter([...])` and `<Route path>`.
 * `router` (from `.finite/design.json`) narrows which adapters run.
 */
export async function scanRoutes(
  root: string,
  router: Router | undefined,
  load: LoadModule,
): Promise<Route[]> {
  if (router === "none") return [];
  if (router === "next-app" || router === "next-pages") return nextRoutes(root);
  if (router !== "react-router") {
    const tanstack = tanstackRoutes(root);
    if (tanstack || router === "tanstack") return tanstack ?? [];
  }
  return (await frameworkRoutes(root, load)) ?? sourceRoutes(root);
}

/**
 * Dynamic segments: `:id` and `*` (React Router), `$id`, `{-$id}` and `$` (TanStack), `[id]`,
 * `[...slug]` and `[[...slug]]` (Next.js).
 */
export function routeParams(routePath: string): string[] {
  const params: string[] = [];
  for (const segment of routePath.split("/")) {
    const match =
      /^:([^?]+)\??$/.exec(segment) ??
      /^\{-?\$([^}]+)\}$/.exec(segment) ??
      /^\$(.+)$/.exec(segment) ??
      /^\[\[\.\.\.([^\]]+)\]\]$/.exec(segment) ??
      /^\[(?:\.\.\.)?([^\]]+)\]$/.exec(segment);
    if (match) params.push(match[1]!);
    else if (segment === "*") params.push("*");
    else if (segment === "$") params.push("_splat");
  }
  return params;
}

function route(routePath: string, file: string | undefined): Route {
  return { path: routePath, params: routeParams(routePath), ...(file ? { file } : {}) };
}

// TanStack Router

/** Reads `FileRoutesByFullPath` from the generated route tree. */
export function tanstackRoutes(root: string): Route[] | null {
  const generated = path.join(
    root,
    tanstackConfig(root).generatedRouteTree ?? "src/routeTree.gen.ts",
  );
  const code = readFile(generated);
  if (code === undefined) return null;
  const ast = parseModule(code, generated);
  if (!ast) return null;

  const imports = importsOf(ast);
  /** `const AboutRoute = AboutRouteImport.update(...)` → `AboutRouteImport`. */
  const updated = new Map<string, string>();
  const fullPaths: [string, string][] = [];
  walk(ast, (node) => {
    if (node.type === "VariableDeclarator") {
      const init = node.init as AstNode | null;
      const callee = init?.type === "CallExpression" ? (init.callee as AstNode) : undefined;
      const object = callee?.type === "MemberExpression" ? (callee.object as AstNode) : undefined;
      if (object?.type === "Identifier")
        updated.set(name(node.id as AstNode), object.name as string);
    }
    if (
      node.type === "TSInterfaceDeclaration" &&
      name(node.id as AstNode) === "FileRoutesByFullPath"
    ) {
      for (const member of (node.body as AstNode).body as AstNode[]) {
        const key = member.key as AstNode;
        const keyName = key.type === "StringLiteral" ? (key.value as string) : name(key);
        const type = (member.typeAnnotation as AstNode | undefined)?.typeAnnotation as
          | AstNode
          | undefined;
        const ref = type?.type === "TSTypeQuery" ? name(type.exprName as AstNode) : "";
        fullPaths.push([keyName, ref]);
      }
    }
  });

  const dir = path.dirname(generated);
  return fullPaths.map(([fullPath, ref]) => {
    const source = imports.get(updated.get(ref) ?? ref);
    return route(fullPath, source ? resolveFile(root, dir, source) : undefined);
  });
}

function tanstackConfig(root: string): { generatedRouteTree?: string } {
  const text = readFile(path.join(root, "tsr.config.json"));
  if (text === undefined) return {};
  try {
    return JSON.parse(text) as { generatedRouteTree?: string };
  } catch {
    return {};
  }
}

// React Router framework mode

type RouteConfigEntry = {
  path?: string;
  index?: boolean;
  file: string;
  children?: RouteConfigEntry[];
};

/** Loads `<appDirectory>/routes.ts` when the app uses `@react-router/dev`. */
export async function frameworkRoutes(root: string, load: LoadModule): Promise<Route[] | null> {
  if (!dependsOn(root, "@react-router/dev")) return null;
  const configFile = findModule(root, "react-router.config");
  const config = configFile
    ? ((await load(configFile)).default as { appDirectory?: string } | undefined)
    : undefined;
  const appDirectory = config?.appDirectory ?? "app";
  const routesFile = findModule(path.join(root, appDirectory), "routes");
  if (!routesFile) return null;
  const entries = (await (load(routesFile).then((m) => m.default) as Promise<unknown>)) as
    | RouteConfigEntry[]
    | undefined;

  const routes = new Map<string, Route>();
  const visit = (list: RouteConfigEntry[], parent: string) => {
    for (const entry of list) {
      const full = entry.path === undefined ? parent : joinPath(parent, entry.path);
      const file = path.relative(root, path.resolve(root, appDirectory, entry.file));
      if (entry.index || entry.path !== undefined) routes.set(full, route(full, toPosix(file)));
      if (entry.children) visit(entry.children, full);
    }
  };
  visit(entries ?? [], "/");
  return [...routes.values()];
}

// React Router data and declarative mode

const ROUTER_CALLS = new Set([
  "createBrowserRouter",
  "createHashRouter",
  "createMemoryRouter",
  "useRoutes",
]);

type ScanCache = Map<string, { mtimeMs: number; size: number; routes: Route[] }>;
const scanCache: ScanCache = new Map();

/** Finds `createBrowserRouter([...])`, `createRoutesFromElements(...)` and `<Routes>` in the source. */
export function sourceRoutes(root: string): Route[] {
  const routes = new Map<string, Route>();
  for (const file of sourceFiles(root)) {
    const stat = fs.statSync(file);
    let cached = scanCache.get(file);
    if (!cached || cached.mtimeMs !== stat.mtimeMs || cached.size !== stat.size) {
      cached = { mtimeMs: stat.mtimeMs, size: stat.size, routes: routesInFile(root, file) };
      scanCache.set(file, cached);
    }
    for (const found of cached.routes) routes.set(found.path, found);
  }
  return [...routes.values()];
}

function routesInFile(root: string, file: string): Route[] {
  const code = readFile(file);
  if (!code || !/create\w*Router|createRoutesFromElements|useRoutes|<Routes/.test(code)) return [];
  const ast = parseModule(code, file);
  if (!ast) return [];
  const scope = { root, file, ast, imports: importsOf(ast) };
  const routes = new Map<string, Route>();
  const add = (found: Route) => routes.set(found.path, found);

  walk(ast, (node) => {
    if (node.type === "CallExpression") {
      const callee = name(node.callee as AstNode);
      const arg = (node.arguments as AstNode[])[0];
      if (!arg) return;
      if (ROUTER_CALLS.has(callee)) {
        const list = resolveArray(scope, arg);
        if (list) objectRoutes(list.scope, list.array, "/", add);
      } else if (callee === "createRoutesFromElements") {
        jsxRoutes(scope, [arg], "/", add);
      }
    }
    if (node.type === "JSXElement" && jsxName(node) === "Routes") {
      jsxRoutes(scope, node.children as AstNode[], "/", add);
    }
  });
  return [...routes.values()];
}

type Scope = { root: string; file: string; ast: AstNode; imports: Map<string, string> };

/** An array literal, or an identifier bound to one in this file or (one hop) the file it's imported from. */
function resolveArray(scope: Scope, node: AstNode): { scope: Scope; array: AstNode } | null {
  const value = unwrap(node);
  if (value.type === "ArrayExpression") return { scope, array: value };
  if (value.type !== "Identifier") return null;
  const local = findBinding(scope.ast, value.name as string);
  if (local) return local.type === "ArrayExpression" ? { scope, array: local } : null;
  const source = scope.imports.get(value.name as string);
  const file = source ? resolveModule(path.dirname(scope.file), source) : undefined;
  const code = file ? readFile(file) : undefined;
  const ast = file && code ? parseModule(code, file) : null;
  if (!file || !ast) return null;
  const exported = findBinding(ast, value.name as string) ?? findDefaultExport(ast);
  if (exported?.type !== "ArrayExpression") return null;
  return { scope: { root: scope.root, file, ast, imports: importsOf(ast) }, array: exported };
}

function objectRoutes(scope: Scope, array: AstNode, parent: string, add: (r: Route) => void) {
  for (const element of array.elements as (AstNode | null)[]) {
    if (element?.type !== "ObjectExpression") continue;
    const props = new Map<string, AstNode>();
    for (const prop of element.properties as AstNode[]) {
      if (prop.type === "ObjectProperty")
        props.set(name(prop.key as AstNode), unwrap(prop.value as AstNode));
    }
    const routePath = stringValue(props.get("path"));
    const index = props.get("index")?.value === true;
    const full = routePath === undefined ? parent : joinPath(parent, routePath);
    if (routePath !== undefined || index) {
      add(
        route(
          full,
          componentFile(scope, props.get("element") ?? props.get("Component") ?? props.get("lazy")),
        ),
      );
    }
    const children = props.get("children");
    if (children?.type === "ArrayExpression") objectRoutes(scope, children, full, add);
  }
}

function jsxRoutes(scope: Scope, nodes: AstNode[], parent: string, add: (r: Route) => void) {
  for (const node of nodes) {
    if (node.type === "JSXFragment") {
      jsxRoutes(scope, node.children as AstNode[], parent, add);
      continue;
    }
    if (node.type !== "JSXElement" || jsxName(node) !== "Route") continue;
    const attrs = new Map<string, AstNode | null>();
    for (const attr of (node.openingElement as AstNode).attributes as AstNode[]) {
      if (attr.type !== "JSXAttribute") continue;
      const value = attr.value as AstNode | null;
      attrs.set(
        name(attr.name as AstNode),
        value?.type === "JSXExpressionContainer" ? unwrap(value.expression as AstNode) : value,
      );
    }
    const routePath = stringValue(attrs.get("path") ?? undefined);
    const index =
      attrs.has("index") && (attrs.get("index") === null || attrs.get("index")?.value === true);
    const full = routePath === undefined ? parent : joinPath(parent, routePath);
    if (routePath !== undefined || index) {
      const component = attrs.get("element") ?? attrs.get("Component") ?? attrs.get("lazy");
      add(route(full, componentFile(scope, component ?? undefined)));
    }
    jsxRoutes(scope, node.children as AstNode[], full, add);
  }
}

/** The file a route's `element={<Home />}`, `Component: Home` or `lazy: () => import("./x")` comes from. */
function componentFile(scope: Scope, node: AstNode | undefined): string | undefined {
  if (!node) return undefined;
  let source: string | undefined;
  let component: string | undefined;
  if (node.type === "JSXElement") component = jsxName(node);
  else if (node.type === "Identifier") component = node.name as string;
  else if (node.type === "ArrowFunctionExpression" || node.type === "FunctionExpression") {
    walk(node, (inner) => {
      if (inner.type === "ImportExpression") source ??= stringValue(inner.source as AstNode);
      if (inner.type === "CallExpression" && (inner.callee as AstNode).type === "Import") {
        source ??= stringValue((inner.arguments as AstNode[])[0]);
      }
    });
  }
  if (component) {
    source = scope.imports.get(component);
    if (!source)
      return findBinding(scope.ast, component)
        ? toPosix(path.relative(scope.root, scope.file))
        : undefined;
  }
  return source ? resolveFile(scope.root, path.dirname(scope.file), source) : undefined;
}

// Helpers

function importsOf(ast: AstNode): Map<string, string> {
  const imports = new Map<string, string>();
  for (const statement of ast.body as AstNode[]) {
    if (statement.type !== "ImportDeclaration") continue;
    const source = (statement.source as AstNode).value as string;
    for (const specifier of statement.specifiers as AstNode[]) {
      imports.set(name(specifier.local as AstNode), source);
    }
  }
  return imports;
}

/** The initializer of a top-level `const name = ...` (exported or not). */
function findBinding(ast: AstNode, binding: string): AstNode | undefined {
  for (let statement of ast.body as AstNode[]) {
    if (statement.type === "ExportNamedDeclaration" && statement.declaration) {
      statement = statement.declaration as AstNode;
    }
    if (statement.type === "FunctionDeclaration" && name(statement.id as AstNode) === binding) {
      return statement;
    }
    if (statement.type !== "VariableDeclaration") continue;
    for (const declarator of statement.declarations as AstNode[]) {
      if (name(declarator.id as AstNode) === binding && declarator.init) {
        return unwrap(declarator.init as AstNode);
      }
    }
  }
  return undefined;
}

function findDefaultExport(ast: AstNode): AstNode | undefined {
  const statement = (ast.body as AstNode[]).find((s) => s.type === "ExportDefaultDeclaration");
  return statement ? unwrap(statement.declaration as AstNode) : undefined;
}

/** Looks through `x as T`, `x satisfies T` and `(x)`. */
function unwrap(node: AstNode): AstNode {
  while (
    node.type === "TSAsExpression" ||
    node.type === "TSSatisfiesExpression" ||
    node.type === "TSNonNullExpression" ||
    node.type === "ParenthesizedExpression"
  ) {
    node = node.expression as AstNode;
  }
  return node;
}

function name(node: AstNode | null | undefined): string {
  if (!node) return "";
  if (node.type === "Identifier" || node.type === "JSXIdentifier") return node.name as string;
  if (node.type === "StringLiteral") return node.value as string;
  return "";
}

function jsxName(node: AstNode): string {
  return name((node.openingElement as AstNode).name as AstNode);
}

function stringValue(node: AstNode | undefined): string | undefined {
  if (node?.type === "StringLiteral") return node.value as string;
  if (node?.type === "TemplateLiteral" && (node.expressions as AstNode[]).length === 0) {
    return ((node.quasis as AstNode[])[0]!.value as { cooked: string }).cooked;
  }
  return undefined;
}

function joinPath(parent: string, child: string): string {
  if (child.startsWith("/")) return child;
  return `${parent.replace(/\/$/, "")}/${child}`.replace(/\/$/, "") || "/";
}

function resolveFile(root: string, dir: string, source: string): string | undefined {
  const file = resolveModule(dir, source);
  return file ? toPosix(path.relative(root, file)) : undefined;
}

/** A relative import's file, trying the usual extensions and `index` files. */
function resolveModule(dir: string, source: string): string | undefined {
  if (!source.startsWith(".")) return undefined;
  const base = path.resolve(dir, source);
  const candidates = [
    base,
    ...EXTENSIONS.map((ext) => base + ext),
    ...EXTENSIONS.map((ext) => path.join(base, `index${ext}`)),
  ];
  // `./Home.js` may name `Home.tsx` (TypeScript's NodeNext style).
  if (/\.[cm]?js$/.test(base)) {
    const stem = base.replace(/\.[cm]?js$/, "");
    candidates.push(stem + ".tsx", stem + ".ts");
  }
  return candidates.find((file) => fs.statSync(file, { throwIfNoEntry: false })?.isFile());
}

function findModule(dir: string, stem: string): string | undefined {
  return EXTENSIONS.map((ext) => path.join(dir, stem + ext)).find((file) => fs.existsSync(file));
}

function sourceFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (files.length >= MAX_SCAN_FILES) return;
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) visit(full);
      } else if (EXTENSIONS.includes(path.extname(entry.name)) && !entry.name.endsWith(".d.ts")) {
        files.push(full);
      }
    }
  };
  visit(root);
  return files;
}

function dependsOn(root: string, dependency: string): boolean {
  try {
    const pkg = JSON.parse(readFile(path.join(root, "package.json")) ?? "{}") as Record<
      string,
      Record<string, string> | undefined
    >;
    return Boolean(pkg.dependencies?.[dependency] ?? pkg.devDependencies?.[dependency]);
  } catch {
    return false;
  }
}

function readFile(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

function toPosix(file: string): string {
  return file.split(path.sep).join("/");
}
