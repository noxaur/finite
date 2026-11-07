import path from "node:path";

/**
 * Finite's Next.js adapter. `next-host.mjs` sets `NEXT_ADAPTER_PATH` to this file before it loads
 * Next, and Next calls `modifyConfig` on the project's own config: the one hook a custom server
 * has into the config `next dev` loads. The options come from `FINITE_NEXT` (`AdapterOptions`).
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

type Rule = Record<string, unknown>;
type WebpackConfig = {
  module: { rules: unknown[] };
  watchOptions?: { ignored?: RegExp | string | string[] };
};
type Webpack = (config: WebpackConfig, context: unknown) => WebpackConfig;
type Config = {
  distDir?: string;
  compress?: boolean;
  devIndicators?: unknown;
  output?: string;
  turbopack?: { rules?: Record<string, unknown> };
  webpack?: Webpack | null;
};

/** The files that may hold JSX. Next compiles JSX in `.js` too. */
const GLOBS = ["*.tsx", "*.jsx", "*.js"];
const FILES = /\.(tsx|jsx|js)$/;

export const name = "finite";

declare global {
  /** Set once Finite's adapter ran, which a project's own `adapterPath` prevents. */
  var FINITE_NEXT_ADAPTED: boolean | undefined;
}

/**
 * Adds the stamping loader for both bundlers: a Turbopack rule, and a webpack rule chained onto
 * the project's own `webpack` function. `next-host.mjs` picks which one `next dev` runs.
 */
export function modifyConfig(config: Config, context?: { phase?: string }): Config {
  const options = JSON.parse(process.env.FINITE_NEXT ?? "null") as AdapterOptions | null;
  if (!options) return config;
  globalThis.FINITE_NEXT_ADAPTED = true;
  const loader = {
    loader: options.loader,
    options: { root: options.root, sheets: options.sheets },
  };
  const ours: Rule = { condition: { not: "foreign" }, loaders: [loader] };
  const rules = { ...config.turbopack?.rules };
  // All matching rules run, in order: ours first, so it sees the file as it is on disk.
  for (const glob of GLOBS) rules[glob] = [ours, ...asRules(rules[glob])];
  const projectWebpack = config.webpack;
  const webpack: Webpack = (webpackConfig, webpackContext) => {
    const result = projectWebpack ? projectWebpack(webpackConfig, webpackContext) : webpackConfig;
    // Pre loaders run before normal ones (SWC), and the last pre rule runs first, so ours sees
    // the file as it is on disk even when the project adds pre loaders of its own.
    result.module.rules.push({
      test: FILES,
      enforce: "pre",
      exclude: /node_modules/,
      use: [loader],
    });
    // Next ignores `.next` but not another distDir. Tailwind watches the whole root, so each
    // build's output would start the next build, and every rebuild refreshes open pages.
    const dist = path.join(options.root, options.distDir).split(path.sep).join("/");
    const ignored = result.watchOptions?.ignored;
    result.watchOptions = {
      ...result.watchOptions,
      ignored:
        ignored instanceof RegExp
          ? new RegExp(`${ignored.source}|^${dist.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(/|$)`)
          : [...(ignored === undefined ? [] : [ignored].flat()), `${dist}/**`],
    };
    return result;
  };
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
    webpack,
  };
}

/** A project's rule for one glob as a list of rule objects. A list of loaders is one rule. */
function asRules(rule: unknown): Rule[] {
  if (rule === undefined) return [];
  if (!Array.isArray(rule)) return [rule as Rule];
  const shorthand = rule.some((item) => typeof item === "string" || "loader" in item);
  return shorthand ? [{ loaders: rule }] : (rule as Rule[]);
}
