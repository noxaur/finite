import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { promisify } from "node:util";
import type { Theme } from "./tailwind.ts";

const CONFIGS = [
  "tailwind.config.ts",
  "tailwind.config.js",
  "tailwind.config.mjs",
  "tailwind.config.cjs",
];

/** The design's `tailwind.config.*`, when the tailwindcss it has installed is v3. */
export async function tailwind3Config(root: string): Promise<string | undefined> {
  let file: string | undefined;
  for (const name of CONFIGS) {
    if (await stat(path.join(root, name)).catch(() => undefined)) {
      file = path.join(root, name);
      break;
    }
  }
  if (!file) return undefined;
  try {
    const pkg = createRequire(path.join(root, "package.json")).resolve("tailwindcss/package.json");
    const { version } = JSON.parse(await readFile(pkg, "utf8")) as { version: string };
    return version.startsWith("3.") ? file : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Runs in a child `node` with the project as cwd: loads the config with the project's own
 * tailwindcss (`loadConfig` handles `.ts` and ESM since 3.3) and prints the resolved theme as
 * JSON. Functions (plugin options) drop out.
 */
const RESOLVE = `
const { createRequire } = require("node:module");
const [root, file] = process.argv.slice(1);
const req = createRequire(root + "/package.json");
let load;
try { load = req("tailwindcss/loadConfig"); } catch { load = req; }
let config = load(file);
config = config.default ?? config;
process.stdout.write(JSON.stringify(req("tailwindcss/resolveConfig")(config).theme));
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
  }).then(
    ({ stdout }) => v3Theme(JSON.parse(stdout) as Record<string, unknown>),
    (error: Error & { stderr?: string }) => {
      console.warn(
        `reading the Tailwind theme in ${file} failed, so hand edits write arbitrary values:`,
        error.stderr?.split("\n").find((l) => /^\w*Error\b/.test(l)) ?? error.message,
      );
      return {};
    },
  );
  cache.set(file, { mtime: mtimeMs, theme });
  return theme;
}

/** Which v3 theme key fills which `Theme` namespace. */
const NAMESPACES: Record<string, string> = {
  colors: "--color",
  spacing: "--spacing",
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
