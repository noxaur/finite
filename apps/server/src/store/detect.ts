import fs from "node:fs/promises";
import path from "node:path";
import { Refused, type Router, type Styling } from "@finite/protocol";
import { exists, readJson } from "./files.ts";

const SUPPORTED =
  "Finite supports Vite apps that use React Router (react-router or react-router-dom) or TanStack Router (@tanstack/react-router).";

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

  if (!("vite" in deps)) {
    throw refuse(`${root} doesn't use Vite (no vite in package.json).`);
  }
  const router: Detected["router"] | undefined =
    "@tanstack/react-router" in deps
      ? "tanstack"
      : "react-router" in deps || "react-router-dom" in deps
        ? "react-router"
        : undefined;
  if (!router) throw refuse(`${root} has no supported router in package.json.`);

  const srcDir = (await exists(path.join(root, "src"))) ? "src" : "app";
  const sources = await sourceFiles(root, srcDir);
  const tailwindCss = sources.css.filter((f) => /@import\s+["']tailwindcss["']/.test(f.text));
  const styling = detectStyling(
    "tailwindcss" in deps || tailwindCss.length > 0,
    "@stylexjs/stylex" in deps,
    sources.code,
  );

  return {
    name: typeof pkg.name === "string" && pkg.name ? pkg.name : path.basename(root),
    router,
    styling,
    css: tailwindCss.length ? tailwindCss.map((f) => f.path) : entryCss(sources.code),
    brandDir: `${srcDir}/assets/brand`,
  };
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

/** True when the file imports `@stylexjs/stylex` and calls its `props`, under any local name. */
function callsStylexProps(text: string): boolean {
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

const ENTRIES = [
  "src/main.tsx",
  "src/main.jsx",
  "src/index.tsx",
  "src/index.jsx",
  "src/main.ts",
  "app/root.tsx",
  "app/root.jsx",
];

/** The global stylesheets the app's entry imports, relative to the root. */
function entryCss(code: SourceFile[]): string[] {
  const css: string[] = [];
  for (const entry of ENTRIES) {
    const file = code.find((f) => f.path === entry);
    if (!file) continue;
    for (const match of file.text.matchAll(
      /import\s+(?:[\w*{}\s,]+from\s+)?["'](\.{1,2}\/[^"'?]+\.css)(?:\?url)?["']/g,
    )) {
      if (match[1]!.includes(".module.")) continue;
      css.push(path.posix.normalize(path.posix.join(path.posix.dirname(entry), match[1]!)));
    }
    break;
  }
  return css;
}

type SourceFile = { path: string; text: string };

const SKIP = new Set(["node_modules", "dist", "build", ".finite", ".git"]);
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
      else if (/\.(tsx|jsx|ts|js)$/.test(entry.name) || entry.name.endsWith(".css")) {
        seen++;
        const text = await fs.readFile(path.join(root, child), "utf8");
        (entry.name.endsWith(".css") ? css : code).push({ path: child, text });
      }
    }
  }
  return { code, css };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}
