import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { promisify } from "node:util";
import type { Theme } from "./tailwind.ts";

/** Where Tailwind v3 looks for its config when no `@config` names one, in its order. */
const CONFIGS = ["js", "cjs", "mjs", "ts", "cts", "mts"].map((ext) => `tailwind.config.${ext}`);
const CONFIG_DIRECTIVE = /@config\s+(["'])([^"']+)\1/;

/**
 * The design's Tailwind v3 config, absolute, when the tailwindcss it has installed is v3: the
 * file a sheet's `@config` names (relative to that sheet), else `tailwind.config.*` at the root.
 * `sheets` are the design's global stylesheets, by root-relative path.
 */
export async function tailwind3Config(
  root: string,
  sheets: { file: string; css: string }[],
): Promise<string | undefined> {
  try {
    const pkg = createRequire(path.join(root, "package.json")).resolve("tailwindcss/package.json");
    const { version } = JSON.parse(await readFile(pkg, "utf8")) as { version: string };
    if (!version.startsWith("3.")) return undefined;
  } catch {
    return undefined;
  }
  const exists = async (file: string) => (await stat(file).catch(() => undefined))?.isFile();
  for (const { file, css } of sheets) {
    const named = CONFIG_DIRECTIVE.exec(css)?.[2];
    const config = named && path.resolve(root, path.dirname(file), named);
    if (config && (await exists(config))) return config;
  }
  for (const name of CONFIGS) if (await exists(path.join(root, name))) return path.join(root, name);
  return undefined;
}

/**
 * Runs in a child `node` with the project as cwd: loads the config with the project's own
 * tailwindcss (`loadConfig` handles `.ts` and ESM since 3.3) and prints the resolved theme as
 * JSON after `MARK`, so a config that logs to stdout doesn't break it. Functions (plugin
 * options) drop out.
 */
const MARK = "@@finite-theme@@";
const RESOLVE = `const MARK = ${JSON.stringify(MARK)};
const { createRequire } = require("node:module");
const [root, file] = process.argv.slice(1);
const req = createRequire(root + "/package.json");
let load;
try { load = req("tailwindcss/loadConfig"); } catch { load = req; }
let config = load(file);
config = config.default ?? config;
process.stdout.write("\\n" + MARK + JSON.stringify(req("tailwindcss/resolveConfig")(config).theme));
`;

const cache = new Map<string, { mtime: number; theme: Promise<Theme> }>();

/**
 * The resolved theme of a v3 config as `Theme` names, cached by the config's mtime. Resolving
 * runs the project's code, so it happens in a short-lived child. When it fails the theme is
 * empty, which turns every value into an arbitrary class.
 */
export async function configTheme(root: string, file: string): Promise<Theme> {
  const { mtimeMs } = await stat(file);
  const hit = cache.get(file);
  if (hit?.mtime === mtimeMs) return hit.theme;
  const theme = promisify(execFile)(process.execPath, ["-e", RESOLVE, root, file], {
    cwd: root,
    timeout: 20_000,
    maxBuffer: 16 * 1024 * 1024,
  })
    .then(({ stdout }) => {
      const at = stdout.lastIndexOf(MARK);
      if (at < 0) throw new Error("the child printed no theme");
      return v3Theme(JSON.parse(stdout.slice(at + MARK.length)) as Record<string, unknown>);
    })
    .catch((error: Error & { stderr?: string }) => {
      console.warn(
        `reading the Tailwind theme in ${file} failed, so hand edits write arbitrary values:`,
        error.stderr?.split("\n").find((l) => /^\w*Error\b/.test(l)) ?? error.message,
      );
      return {};
    });
  cache.set(file, { mtime: mtimeMs, theme });
  return theme;
}

/** Which v3 theme key fills which `Theme` namespace. */
const NAMESPACES: Record<string, string> = {
  colors: "--color",
  spacing: "--spacing",
  padding: "--padding",
  margin: "--margin",
  gap: "--gap",
  inset: "--inset",
  width: "--width",
  height: "--height",
  minWidth: "--min-width",
  minHeight: "--min-height",
  maxWidth: "--container",
  maxHeight: "--max-height",
  fontSize: "--text",
  fontWeight: "--font-weight",
  fontFamily: "--font",
  lineHeight: "--leading",
  letterSpacing: "--tracking",
  borderRadius: "--radius",
  borderWidth: "--border-width",
  boxShadow: "--shadow",
  zIndex: "--z-index",
  opacity: "--opacity",
};

/**
 * Flattens a resolved v3 theme into `Theme` names: nested colors join with `-` and a nested
 * `DEFAULT` names its parent (`red.DEFAULT` is `--color-red`), while a top-level `DEFAULT` stays
 * `--radius-DEFAULT`, the bare class `rounded`. `fontSize: [size, opts]` keeps the size, and a
 * font family list joins with commas.
 */
export function v3Theme(resolved: Record<string, unknown>): Theme {
  const out: Theme = {};
  const walk = (ns: string, prefix: string, values: unknown, family: boolean) => {
    if (!values || typeof values !== "object") return;
    for (const [k, v] of Object.entries(values)) {
      const key = k === "DEFAULT" && prefix !== ns ? prefix : `${prefix}-${k}`;
      const value = Array.isArray(v)
        ? family
          ? (Array.isArray(v[0]) ? v[0] : v).filter((f) => typeof f === "string").join(", ")
          : v[0]
        : v;
      if (typeof value === "string" || typeof value === "number") out[key] = String(value);
      else if (!Array.isArray(v)) walk(ns, key, v, family);
    }
  };
  for (const [key, ns] of Object.entries(NAMESPACES))
    walk(ns, ns, resolved[key], key === "fontFamily");
  return out;
}
