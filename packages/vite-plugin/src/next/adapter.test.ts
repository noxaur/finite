import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { type AdapterOptions, modifyConfig, wrap } from "./adapter.ts";
import { nextBundler } from "./index.ts";

const OPTIONS: AdapterOptions = {
  loader: "/finite/loader.ts",
  root: "/project",
  distDir: ".finite/runtime/next",
  sheets: {},
  configs: {},
};
const LOADER = {
  loader: OPTIONS.loader,
  options: { root: OPTIONS.root, sheets: OPTIONS.sheets, configs: OPTIONS.configs },
};

afterEach(() => {
  delete process.env.FINITE_NEXT;
});

describe("wrap", () => {
  test("runs the project's modifyConfig first and applies Finite's changes on top", async () => {
    process.env.FINITE_NEXT = JSON.stringify(OPTIONS);
    const seen: unknown[] = [];
    const adapter = wrap({
      name: "mine",
      modifyConfig: (config, context) => {
        seen.push(context);
        return {
          ...config,
          distDir: "build",
          compress: true,
          turbopack: { rules: { "*.tsx": { loaders: ["mine-loader"] } } },
        };
      },
    });
    const context = { phase: "phase-development-server" };
    const config = await adapter.modifyConfig!({ output: "standalone" }, context);
    expect(seen).toEqual([context]);
    expect(config).toMatchObject({
      output: "standalone",
      distDir: ".finite/runtime/next",
      compress: false,
    });
    expect(config.turbopack?.rules?.["*.tsx"]).toEqual([
      expect.objectContaining({ loaders: [expect.objectContaining({ loader: OPTIONS.loader })] }),
      { loaders: ["mine-loader"] },
    ]);
  });

  test("passes the project's other hooks through", () => {
    const onBuildComplete = () => {};
    const adapter = wrap({ name: "mine", onBuildComplete });
    expect(adapter.onBuildComplete).toBe(onBuildComplete);
    expect(adapter.name).toBe("finite");
  });
});

describe("modifyConfig", () => {
  beforeEach(() => {
    process.env.FINITE_NEXT = JSON.stringify(OPTIONS);
  });

  test("chains the stamping loader onto the project's own webpack function, as a pre rule last", () => {
    const theirs = { test: /\.mdx$/, use: ["mdx-loader"] };
    const config = modifyConfig({
      webpack: (webpack, context) => {
        webpack.module.rules.push(theirs);
        return { ...webpack, context } as typeof webpack;
      },
    });
    const result = config.webpack!({ module: { rules: [] } }, { isServer: true });
    expect(result).toMatchObject({ context: { isServer: true } });
    expect(result.module.rules).toEqual([
      theirs,
      { test: /\.(tsx|jsx|js)$/, enforce: "pre", exclude: /node_modules/, use: [LOADER] },
    ]);
  });

  test("adds the webpack rule to a project without a webpack function", () => {
    const result = modifyConfig({}).webpack!({ module: { rules: [] } }, {});
    expect(result.module.rules).toHaveLength(1);
  });

  test("adds a webpack rule for the Tailwind v3 sheets by path, never one for every .css", () => {
    const sheet = "/project/app/globals.css";
    process.env.FINITE_NEXT = JSON.stringify({ ...OPTIONS, configs: { [sheet]: "/config.cjs" } });
    const result = modifyConfig({}).webpack!({ module: { rules: [] } }, {});
    expect(result.module.rules[1]).toMatchObject({ test: [sheet], enforce: "pre" });
  });

  test("keeps webpack from watching its own output in the distDir", () => {
    const watching = (ignored: RegExp | string[]) =>
      modifyConfig({}).webpack!({ module: { rules: [] }, watchOptions: { ignored } }, {})
        .watchOptions!.ignored;
    const next = watching(/node_modules/) as RegExp;
    expect(next.test("/project/node_modules/x.js")).toBe(true);
    expect(next.test("/project/.finite/runtime/next/static/chunks/project/layout.js")).toBe(true);
    expect(next.test("/project/.finite/runtime/frames.ts")).toBe(false);
    expect(watching(["**/dist/**"])).toEqual(["**/dist/**", "/project/.finite/runtime/next/**"]);
  });

  test("puts the Turbopack rule before the project's own", () => {
    const config = modifyConfig({ turbopack: { rules: { "*.tsx": ["their-loader"] } } });
    expect(config.turbopack!.rules!["*.tsx"]).toEqual([
      { condition: { not: "foreign" }, loaders: [LOADER] },
      { loaders: ["their-loader"] },
    ]);
  });
});

describe("nextBundler", () => {
  const plain = { webpack: false, turbopack: false };
  const webpackOnly = { webpack: true, turbopack: false };

  test("follows the flag on the script that runs next dev, the dev script first", () => {
    expect(nextBundler({ dev: "next dev --webpack" }, plain)).toBe("webpack");
    expect(nextBundler({ dev: "next dev --turbopack" }, webpackOnly)).toBe("turbopack");
    expect(nextBundler({ start: "next dev", dev: "next dev --webpack -p 3001" }, plain)).toBe(
      "webpack",
    );
    expect(nextBundler({ web: "next dev --webpack" }, plain)).toBe("webpack");
    // A flag for another command isn't one for next dev.
    expect(nextBundler({ dev: "next build --webpack && next dev" }, plain)).toBe("turbopack");
  });

  test("without a flag, picks webpack only for a webpack config with no turbopack config", () => {
    expect(nextBundler({ dev: "next dev" }, plain)).toBe("turbopack");
    expect(nextBundler({ dev: "next dev" }, webpackOnly)).toBe("webpack");
    expect(nextBundler({ dev: "node server.js" }, webpackOnly)).toBe("webpack");
    expect(nextBundler(undefined, { webpack: true, turbopack: true })).toBe("turbopack");
  });
});
