import fs from "node:fs/promises";
import path from "node:path";
import { Refused, type Router, type Styling } from "@finite/protocol";
import { exists, readJson } from "./files.ts";

const SUPPORTED =
  "Finite supports Next.js apps (App Router or Pages Router) and Vite apps that use React Router (react-router or react-router-dom) or TanStack Router (@tanstack/react-router).";

export type Detected = {
  name: string;
  router: Exclude<Router, "none">;
  styling: Styling;
  css: string[];
  brandDir: string;
};

/** What kind of project `root` is, or a refusal (`unsupported-project`) that says what's supported. */
export async function detectProject(root: string): Promise<Detected> {
  const refuse = (why: string) => new Refused(`${why} ${SUPPORTED}`, "unsupported-project");
  const stat = await fs.stat(root).catch(() => undefined);
  if (!stat?.isDirectory()) throw refuse(`${root} isn't a folder.`);

  let pkg: { name?: unknown; dependencies?: unknown; devDependencies?: unknown } | undefined;
  try {
    pkg = (await readJson(path.join(root, "package.json"))) as typeof pkg;
  } catch {
    throw refuse(`${root}/package.json isn't valid JSON.`);
  }
  if (!pkg || typeof pkg !== "object") throw refuse(`${root} has no package.json.`);
  const deps = { ...asRecord(pkg.dependencies), ...asRecord(pkg.devDependencies) };

  const hasSrc = await exists(path.join(root, "src"));
  const layout = "next" in deps ? await nextLayout(root, hasSrc) : viteLayout(deps, hasSrc);
  if (typeof layout === "string") throw refuse(`${root} ${layout}`);
  const sources = await sourceFiles(root, layout.scanDir);
  // `@import "tailwindcss"` on v4, `@tailwind` directives on v3.
  const tailwindCss = sources.css.filter((f) =>
    /@import\s+["']tailwindcss["']|@tailwind\s+(base|components|utilities)\b/.test(f.text),
  );
  const styling = detectStyling(
    "tailwindcss" in deps || tailwindCss.length > 0,
    "@stylexjs/stylex" in deps,
    sources.code,
  );

  return {
    name: typeof pkg.name === "string" && pkg.name ? pkg.name : path.basename(root),
    router: layout.router,
    styling,
    css: tailwindCss.length
      ? tailwindCss.map((f) => f.path)
      : entryCss(sources.code, layout.entries),
    brandDir: layout.brandDir,
  };
}

type Layout = {
  router: Detected["router"];
  /** The folder the styling scan reads, relative to the root. */
  scanDir: string;
  /** The files whose stylesheet imports are the global CSS; the first that exists wins. */
  entries: string[];
  brandDir: string;
};

/** A Next.js app's router. As in Next, `app/` or `pages/` at the root win over `src/`. */
async function nextLayout(root: string, hasSrc: boolean): Promise<Layout | string> {
  const atRoot = (await exists(path.join(root, "app"))) || (await exists(path.join(root, "pages")));
  const base = atRoot ? "" : "src";
  const app = path.posix.join(base, "app");
  const pages = path.posix.join(base, "pages");
  const router = (await exists(path.join(root, app)))
    ? "next-app"
    : (await exists(path.join(root, pages)))
      ? "next-pages"
      : undefined;
  if (!router) return "uses Next.js but has no app/ or pages/ folder.";
  return {
    router,
    scanDir: base,
    entries: [`${app}/layout.tsx`, `${app}/layout.jsx`, `${pages}/_app.tsx`, `${pages}/_app.jsx`],
    // Without src/, brand assets sit at the root rather than among the routes in app/.
    brandDir: hasSrc ? "src/assets/brand" : "assets/brand",
  };
}

function viteLayout(deps: Record<string, unknown>, hasSrc: boolean): Layout | string {
  if (!("vite" in deps)) return "doesn't use Vite or Next.js (no vite or next in package.json).";
  const router =
    "@tanstack/react-router" in deps
      ? "tanstack"
      : "react-router" in deps || "react-router-dom" in deps
        ? "react-router"
        : undefined;
  if (!router) return "has no supported router in package.json.";
  const srcDir = hasSrc ? "src" : "app";
  return { router, scanDir: srcDir, entries: VITE_ENTRIES, brandDir: `${srcDir}/assets/brand` };
}

/**
 * StyleX if it's a dependency and at least as many files call its `props` as use class strings;
 * then Tailwind if the project has it; CSS modules if more files import them than use class
 * strings; else inline.
 */
function detectStyling(tailwind: boolean, stylex: boolean, code: SourceFile[]): Styling {
  if (stylex) {
    const props = code.filter((f) => callsStylexProps(f.text)).length;
    const classes = code.filter((f) => /className=["'{`]/.test(f.text)).length;
    if (props > 0 && props >= classes) return "stylex";
  }
  if (tailwind) return "tailwind";
  let modules = 0;
  let classStrings = 0;
  for (const file of code) {
    if (/from\s+["'][^"']+\.module\.(css|scss|sass|less)["']/.test(file.text)) modules++;
    else if (/className=["'{`]/.test(file.text)) classStrings++;
  }
  return modules > 0 && modules >= classStrings ? "css-modules" : "inline";
}

/** True when the file imports `@stylexjs/stylex` and calls its `props` outside comments, under any local name. */
function callsStylexProps(source: string): boolean {
  const text = stripComments(source);
  const names: string[] = [];
  for (const m of text.matchAll(/import\s+([^;'"]*?)\s*from\s*["']@stylexjs\/stylex["']/g)) {
    const ns = /\*\s*as\s+([\w$]+)/.exec(m[1]!)?.[1];
    if (ns) names.push(`${ns}.props`);
    for (const spec of /\{([^}]*)\}/.exec(m[1]!)?.[1]?.split(",") ?? []) {
      const named = /^\s*props(?:\s+as\s+([\w$]+))?\s*$/.exec(spec);
      if (named) names.push(named[1] ?? "props");
    }
  }
  return names.some((name) =>
    // Not `obj.props(`, but `{...props(` is a call.
    new RegExp(`(?<![\\w$])(?<![\\w$)\\]]\\.)${name.replace(/[.$]/g, "\\$&")}\\s*\\(`).test(text),
  );
}

/**
 * `source` without its line and block comments. Strings and template literals are copied as they
 * are, so a `//` in a URL doesn't hide the code after it. A `//` after a `:` isn't a comment, as in
 * JSX text such as `http://example.com`.
 */
function stripComments(source: string): string {
  let out = "";
  let i = 0;
  let inTemplate = false;
  // For each open `${`, how many `{` are open inside it.
  const braces: number[] = [];
  while (i < source.length) {
    const c = source[i]!;
    let len = 1;
    if (inTemplate) {
      if (c === "\\") len = 2;
      else if (c === "`") inTemplate = false;
      else if (source.startsWith("${", i)) {
        braces.push(0);
        inTemplate = false;
        len = 2;
      }
    } else if (c === "`") {
      inTemplate = true;
    } else if (c === '"' || c === "'") {
      // An unterminated quote ends with its line, as in JSX text such as `don't`.
      while (i + len < source.length && source[i + len] !== c && source[i + len] !== "\n")
        len += source[i + len] === "\\" ? 2 : 1;
      len++;
    } else if (source.startsWith("//", i) && source[i - 1] !== ":") {
      const eol = source.indexOf("\n", i);
      i = eol === -1 ? source.length : eol;
      continue;
    } else if (source.startsWith("/*", i)) {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 2;
      continue;
    } else if (c === "{" && braces.length > 0) {
      braces[braces.length - 1]!++;
    } else if (c === "}" && braces.length > 0) {
      if (braces[braces.length - 1] === 0) {
        braces.pop();
        inTemplate = true;
      } else braces[braces.length - 1]!--;
    }
    out += source.slice(i, i + len);
    i += len;
  }
  return out;
}

const VITE_ENTRIES = [
  "src/main.tsx",
  "src/main.jsx",
  "src/index.tsx",
  "src/index.jsx",
  "src/main.ts",
  "app/root.tsx",
  "app/root.jsx",
];

/** The global stylesheets the app's first existing entry imports, relative to the root. */
function entryCss(code: SourceFile[], entries: string[]): string[] {
  const css: string[] = [];
  for (const entry of entries) {
    const file = code.find((f) => f.path === entry);
    if (!file) continue;
    for (const match of file.text.matchAll(
      /import\s+(?:[\w*{}\s,]+from\s+)?["'](\.{1,2}\/[^"'?]+\.(?:css|scss|less))(?:\?url)?["']/g,
    )) {
      if (match[1]!.includes(".module.")) continue;
      css.push(path.posix.normalize(path.posix.join(path.posix.dirname(entry), match[1]!)));
    }
    break;
  }
  return css;
}

type SourceFile = { path: string; text: string };

const SKIP = new Set(["node_modules", "dist", "build", ".finite", ".git", ".next"]);
const MAX_FILES = 2_000;

/** The code and CSS files under `dir`, paths relative to the root (posix). */
async function sourceFiles(
  root: string,
  dir: string,
): Promise<{ code: SourceFile[]; css: SourceFile[] }> {
  const code: SourceFile[] = [];
  const css: SourceFile[] = [];
  const queue = [dir];
  let seen = 0;
  while (queue.length && seen < MAX_FILES) {
    const rel = queue.shift()!;
    const entries = await fs.readdir(path.join(root, rel), { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (SKIP.has(entry.name)) continue;
      const child = path.posix.join(rel, entry.name);
      if (entry.isDirectory()) queue.push(child);
      else if (/\.(tsx|jsx|ts|js|css|scss|less)$/.test(entry.name)) {
        seen++;
        const text = await fs.readFile(path.join(root, child), "utf8");
        (/\.(css|scss|less)$/.test(entry.name) ? css : code).push({ path: child, text });
      }
    }
  }
  return { code, css };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}
