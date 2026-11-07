import fs from "node:fs";
import path from "node:path";

const TAILWIND_IMPORT = /@import\s+(["'])tailwindcss\1/;
const TAILWIND_DIRECTIVE = /@tailwind\s+(base|components|utilities)\b/;
const CONFIG_DIRECTIVE = /@config\s+(["'])([^"']+)\1\s*;?/;
/** Where Tailwind v3 looks for its config when nothing names one, in its order. */
const CONFIG_FILES = ["js", "cjs", "mjs", "ts", "cts", "mts"].map(
  (ext) => `tailwind.config.${ext}`,
);

/** Whether a stylesheet imports Tailwind v4, so its classes come from scanning sources. */
export function importsTailwind(css: string): boolean {
  return TAILWIND_IMPORT.test(css);
}

/** Whether a stylesheet holds Tailwind v3's `@tailwind` directives, which scan the config's `content`. */
export function hasTailwindDirectives(css: string): boolean {
  return TAILWIND_DIRECTIVE.test(css);
}

/**
 * Makes `.finite/` a Tailwind source, so classes used only in prototypes get generated: appends
 * `@source "<relative path to .finite>";` to the stylesheet that imports Tailwind. The file on
 * disk is left alone. Returns `null` for any other stylesheet.
 */
export function addFiniteSource(css: string, cssFile: string, root: string): string | null {
  if (!importsTailwind(css)) return null;
  let relative = path.relative(path.dirname(cssFile), path.join(root, ".finite"));
  relative = relative.split(path.sep).join("/");
  if (!relative.startsWith("../")) relative = `./${relative}`;
  return `${css}\n@source ${JSON.stringify(relative)};\n`;
}

/** Finite's Tailwind v3 config for a stylesheet with `@tailwind` directives, absolute. */
export function finiteConfigFile(root: string, cssFile: string): string {
  return path.join(
    root,
    ".finite/runtime/css",
    `${path.relative(root, cssFile)}.tailwind.config.cjs`,
  );
}

/**
 * Points a Tailwind v3 stylesheet at Finite's config with `@config`, in place of the one it names,
 * if any. Tailwind takes only a relative `@config` path, resolved from the stylesheet.
 */
export function addFiniteConfig(css: string, cssFile: string, configFile: string): string {
  let relative = path.relative(path.dirname(cssFile), configFile).split(path.sep).join("/");
  if (!relative.startsWith("../")) relative = `./${relative}`;
  return `@config ${JSON.stringify(relative)};\n${css.replace(CONFIG_DIRECTIVE, "")}`;
}

/**
 * Writes Finite's Tailwind v3 config for a stylesheet with `@tailwind` directives: the project's
 * own config (the one the sheet's `@config` names, else `tailwind.config.*` at the root) with
 * `.finite/` added to `content`, but not `.finite/runtime`. It loads the project's config when
 * Tailwind loads it, through Tailwind's own loader, so ESM and TypeScript configs work too.
 * `.finite/runtime/` gets a `.gitignore`, as under Next.js.
 */
export function writeFiniteConfig(root: string, cssFile: string, css: string): string {
  const named = CONFIG_DIRECTIVE.exec(css)?.[2];
  const project = named
    ? path.resolve(path.dirname(cssFile), named)
    : CONFIG_FILES.map((name) => path.join(root, name)).find((file) => fs.existsSync(file));
  const file = finiteConfigFile(root, cssFile);
  const code = [
    "// Written by Finite: the project's Tailwind config, with .finite/ as a content source.",
    `const path = require("node:path");`,
    `const project = ${JSON.stringify(project ?? null)};`,
    "let load;",
    "try {",
    `  load = require("tailwindcss/lib/lib/load-config").loadConfig;`,
    "} catch {",
    "  load = (file) => require(file).default ?? require(file);",
    "}",
    "const config = project ? load(project) : {};",
    "const content = config.content ?? [];",
    // With `relative: true`, Tailwind resolves globs against the config, which is now this file.
    "const absolute = (glob) =>",
    "  typeof glob !== 'string' || !content.relative ? glob",
    "  : glob.startsWith('!') ? `!${path.resolve(path.dirname(project), glob.slice(1))}`",
    "  : path.resolve(path.dirname(project), glob);",
    "const files = [",
    "  ...(Array.isArray(content) ? content : (content.files ?? [])).map(absolute),",
    `  ${JSON.stringify(path.join(root, ".finite/**/*.{tsx,jsx,ts,js}"))},`,
    `  ${JSON.stringify(`!${path.join(root, ".finite/runtime/**")}`)},`,
    "];",
    "module.exports = { ...config, content: Array.isArray(content) ? files : { ...content, files } };",
    "",
  ].join("\n");
  if (!fs.existsSync(file) || fs.readFileSync(file, "utf8") !== code) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, code);
  }
  const ignore = path.join(root, ".finite/runtime/.gitignore");
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, "*\n");
  return file;
}
