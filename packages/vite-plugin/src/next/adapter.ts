/**
 * Finite's Next.js adapter. `next-host.mjs` sets `NEXT_ADAPTER_PATH` to this file before it loads
 * Next, and Next calls `modifyConfig` on the project's own config: the one hook a custom server
 * has into the config `next dev` loads. The options come from `FINITE_NEXT` (`AdapterOptions`).
 * It hands the settings Finite follows to `FINITE_NEXT_CONFIGURE`, before Next scans the routes.
 */

export type AdapterOptions = {
  /** The stamping loader (`loader.ts`, or `next-loader.mjs` in the desktop app), absolute. */
  loader: string;
  root: string;
  /** Where Next builds, relative to the root, so the project's own `.next` is left alone. */
  distDir: string;
  /** Stylesheets to import in place of others, absolute, as the loader takes them. */
  sheets: Record<string, string>;
};

/** What Finite follows in the project's config, as Next resolved it. */
export type NextSettings = {
  /** `""`, or the prefix of every URL, such as `/docs`. */
  basePath: string;
  /** The extensions of page, layout and route files, without the dot. */
  pageExtensions: string[];
};

type Rule = Record<string, unknown>;
type Config = {
  basePath?: string;
  pageExtensions?: string[];
  distDir?: string;
  compress?: boolean;
  devIndicators?: unknown;
  output?: string;
  turbopack?: { rules?: Record<string, unknown> };
};

/** Next's default `pageExtensions`. */
export const NEXT_PAGE_EXTENSIONS = ["tsx", "ts", "jsx", "js"];

/** The files that may hold JSX. Next compiles JSX in `.js` too. */
const GLOBS = ["*.tsx", "*.jsx", "*.js"];

export const name = "finite";

declare global {
  /**
   * Set by `next-host.mjs`, and called with the resolved config. A project's own `adapterPath`
   * keeps Finite's adapter from running, so it's never called.
   */
  var FINITE_NEXT_CONFIGURE: ((settings: NextSettings) => void) | undefined;
}

export function modifyConfig(config: Config, context?: { phase?: string }): Config {
  const options = JSON.parse(process.env.FINITE_NEXT ?? "null") as AdapterOptions | null;
  if (!options) return config;
  globalThis.FINITE_NEXT_CONFIGURE?.({
    basePath: config.basePath ?? "",
    pageExtensions: config.pageExtensions ?? NEXT_PAGE_EXTENSIONS,
  });
  const ours: Rule = {
    condition: { not: "foreign" },
    loaders: [{ loader: options.loader, options: { root: options.root, sheets: options.sheets } }],
  };
  const rules = { ...config.turbopack?.rules };
  // All matching rules run, in order: ours first, so it sees the file as it is on disk.
  for (const glob of GLOBS) rules[glob] = [ours, ...asRules(rules[glob])];
  // `output: "export"` forbids the Pages Router mount's getServerSideProps, and the preview is a
  // dev server, which never exports.
  const { output, ...rest } = config;
  const exported = output === "export" && context?.phase === "phase-development-server";
  return {
    ...(exported ? rest : config),
    distDir: options.distDir,
    // The host adds the bridge to HTML as it streams, which it can't do to a compressed body.
    compress: false,
    // Next's badge would sit in the corner of every frame on the canvas.
    devIndicators: false,
    turbopack: { ...config.turbopack, rules },
  };
}

/** A project's rule for one glob as a list of rule objects. A list of loaders is one rule. */
function asRules(rule: unknown): Rule[] {
  if (rule === undefined) return [];
  if (!Array.isArray(rule)) return [rule as Rule];
  const shorthand = rule.some((item) => typeof item === "string" || "loader" in item);
  return shorthand ? [{ loaders: rule }] : (rule as Rule[]);
}
