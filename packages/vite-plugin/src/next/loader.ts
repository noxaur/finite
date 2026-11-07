import path from "node:path";
import { stamp } from "../stamp.ts";
import { addFiniteConfig } from "../tailwind.ts";

export type StampLoaderOptions = {
  /** The design root, which locs are relative to. */
  root: string;
  /** Stylesheets to import in place of others, absolute: the generated Tailwind sheet. */
  sheets: Record<string, string>;
  /** Tailwind v3 stylesheets, absolute, and Finite's config for each, which adds `.finite/`. */
  configs: Record<string, string>;
};

type LoaderContext = {
  resourcePath: string;
  getOptions(): StampLoaderOptions;
  callback(error: Error | null, code?: string, map?: unknown): void;
};

const CSS_IMPORT = /(\bimport\s*(?:[^'";]*?\bfrom\s*)?)(["'])([^"']+\.css)\2/g;

/**
 * The Turbopack loader (webpack's loader API) that stamps JSX in a Next.js project, the job
 * `finite:stamp` does in Vite. It runs before SWC, on the file as it is on disk, so locs and revs
 * match the source edits compare against. It also points imports of the project's Tailwind
 * stylesheet at Finite's copy, which adds `.finite/` as a source, and a Tailwind v3 stylesheet at
 * Finite's config, which adds `.finite/` to `content`.
 */
export default function finiteStamp(this: LoaderContext, source: string): void {
  const { root, sheets, configs } = this.getOptions();
  const file = this.resourcePath;
  if (file.endsWith(".css")) {
    const config = configs[file];
    this.callback(null, config ? addFiniteConfig(source, file, config) : source);
    return;
  }
  const relative = path.relative(root, file);
  if (
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    relative.split(path.sep).includes("node_modules")
  ) {
    this.callback(null, source);
    return;
  }
  const stamped = stamp(source, relative.split(path.sep).join("/"), file);
  const code = (stamped?.code ?? source).replace(CSS_IMPORT, (whole, head, quote, request) => {
    const sheet = sheets[path.resolve(path.dirname(file), request)];
    if (!sheet) return whole;
    let to = path.relative(path.dirname(file), sheet).split(path.sep).join("/");
    if (!to.startsWith(".")) to = `./${to}`;
    return `${head}${quote}${to}${quote}`;
  });
  this.callback(null, code, stamped ? JSON.parse(stamped.map.toString()) : undefined);
}
