/**
 * Finite's Next.js adapter. `next-host.mjs` sets `NEXT_ADAPTER_PATH` to this file before it loads
 * Next, and Next calls `modifyConfig` on the project's own config: the one hook a custom server
 * has into the config `next dev` loads. The options come from `FINITE_NEXT` (`AdapterOptions`).
 *
 * A project's own `adapterPath` wins over the variable, so `next-host.mjs` sends Next's import of
 * that adapter here instead, with its URL in `?adapter=`. This adapter then wraps the project's:
 * the project's `modifyConfig` runs first, Finite's changes go on top, and its other hooks pass
 * through.
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
type Context = { phase?: string };
type Config = {
  distDir?: string;
  compress?: boolean;
  devIndicators?: unknown;
  output?: string;
  turbopack?: { rules?: Record<string, unknown> };
};

/** The files that may hold JSX. Next compiles JSX in `.js` too. */
const GLOBS = ["*.tsx", "*.jsx", "*.js"];

/** A Next.js adapter module: `modifyConfig`, and hooks such as `onBuildComplete`. */
export type Adapter = {
  name?: string;
  modifyConfig?: (config: Config, context?: Context) => Config | Promise<Config>;
  [hook: string]: unknown;
};

declare global {
  /** Set once Finite's adapter ran, which `next-host.mjs` checks. */
  var FINITE_NEXT_ADAPTED: boolean | undefined;
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
  globalThis.FINITE_NEXT_ADAPTED = true;
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
