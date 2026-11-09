import path from "node:path";

/**
 * Finite's Next.js adapter. `next-host.mjs` sets `NEXT_ADAPTER_PATH` to this file before it loads
 * Next, and Next calls `modifyConfig` on the project's own config: the one hook a custom server
 * has into the config `next dev` loads. The options come from `FINITE_NEXT` (`AdapterOptions`).
 *
 * A project's own `adapterPath` wins over the variable, so `next-host.mjs` sends Next's import of
 * that adapter here instead, with its URL in `?adapter=`. This adapter then wraps the project's:
 * the project's `modifyConfig` runs first, Finite's changes go on top, and its other hooks pass
 * through. It hands the settings Finite follows, as the project's `modifyConfig` left them, to
 * `FINITE_NEXT_CONFIGURE`, before Next scans the routes.
 */

export type AdapterOptions = {
  /** The stamping loader (`loader.ts`, or `next-loader.mjs` in the desktop app), absolute. */
  loader: string;
  root: string;
  /** Where Next builds, relative to the root, so the project's own `.next` is left alone. */
  distDir: string;
  /** Stylesheets to import in place of others, absolute, as the loader takes them. */
  sheets: Record<string, string>;
  /** Tailwind v3 stylesheets and the config each should use, absolute, as the loader takes them. */
  configs: Record<string, string>;
};

/** What Finite follows in the project's config, as Next resolved it. */
export type NextSettings = {
  /** `""`, or the prefix of every URL, such as `/docs`. */
  basePath: string;
  /** The extensions of page, layout and route files, without the dot. */
  pageExtensions: string[];
};

type Rule = Record<string, unknown>;
type Context = { phase?: string };
type WebpackConfig = {
  module: { rules: unknown[] };
  watchOptions?: { ignored?: RegExp | string | string[] };
};
type Webpack = (config: WebpackConfig, context: unknown) => WebpackConfig;
type Config = {
  basePath?: string;
  pageExtensions?: string[];
  distDir?: string;
  compress?: boolean;
  devIndicators?: unknown;
  output?: string;
  turbopack?: { rules?: Record<string, unknown> };
  webpack?: Webpack | null;
};

/** Next's default `pageExtensions`. */
export const NEXT_PAGE_EXTENSIONS = ["tsx", "ts", "jsx", "js"];

/** The files that may hold JSX. Next compiles JSX in `.js` too. */
const GLOBS = ["*.tsx", "*.jsx", "*.js"];
const FILES = /\.(tsx|jsx|js)$/;

/** A Next.js adapter module: `modifyConfig`, and hooks such as `onBuildComplete`. */
export type Adapter = {
  name?: string;
  modifyConfig?: (config: Config, context?: Context) => Config | Promise<Config>;
  [hook: string]: unknown;
};

declare global {
  /**
   * Set by `next-host.mjs`, and called with the resolved config. Never called means Finite's
   * adapter didn't run, which `next-host.mjs` checks.
   */
  var FINITE_NEXT_CONFIGURE: ((settings: NextSettings) => void) | undefined;
}

/** Finite's adapter around a project's own, or around none. */
export function wrap(project: Adapter = {}): Adapter {
  return {
    ...project,
    name: "finite",
    modifyConfig: async (config, context) =>
      modifyConfig(
        project.modifyConfig ? await project.modifyConfig(config, context) : config,
        context,
      ),
  };
}

const own = new URL(import.meta.url).searchParams.get("adapter");
const project = own ? ((await import(own)) as { default?: Adapter } & Adapter) : undefined;
// Next takes an adapter's default export when it has one, as it does here.
export default wrap(project?.default ?? project);

export function modifyConfig(config: Config, context?: Context): Config {
  const options = JSON.parse(process.env.FINITE_NEXT ?? "null") as AdapterOptions | null;
  if (!options) return config;
  globalThis.FINITE_NEXT_CONFIGURE?.({
    basePath: config.basePath ?? "",
    pageExtensions: config.pageExtensions ?? NEXT_PAGE_EXTENSIONS,
  });
  const loader = {
    loader: options.loader,
    options: { root: options.root, sheets: options.sheets, configs: options.configs },
  };
  const ours: Rule = { condition: { not: "foreign" }, loaders: [loader] };
  const rules = { ...config.turbopack?.rules };
  // All matching rules run, in order: ours first, so it sees the file as it is on disk. Both
  // bundlers run PostCSS after the loaders on a stylesheet, so Tailwind v3 sees the `@config` it
  // adds.
  const css = Object.keys(options.configs).length > 0;
  for (const glob of css ? [...GLOBS, "*.css"] : GLOBS)
    rules[glob] = [ours, ...asRules(rules[glob])];
  const projectWebpack = config.webpack;
  const webpack: Webpack = (webpackConfig, webpackContext) => {
    const result = projectWebpack ? projectWebpack(webpackConfig, webpackContext) : webpackConfig;
    // Pre loaders run before normal ones (SWC, PostCSS), and the last pre rule runs first, so
    // ours sees the file as it is on disk even when the project adds pre loaders of its own.
    result.module.rules.push({
      test: FILES,
      enforce: "pre",
      exclude: /node_modules/,
      use: [loader],
    });
    // Only the Tailwind v3 sheets, by path: a rule whose `test` can match any `.css` file turns
    // Next's built-in CSS support off.
    if (css)
      result.module.rules.push({
        test: Object.keys(options.configs),
        enforce: "pre",
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
