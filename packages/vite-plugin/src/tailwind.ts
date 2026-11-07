import path from "node:path";

const TAILWIND_IMPORT = /@import\s+(["'])tailwindcss\1/;

/** Whether a stylesheet imports Tailwind, so its classes come from scanning sources. */
export function importsTailwind(css: string): boolean {
  return TAILWIND_IMPORT.test(css);
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
