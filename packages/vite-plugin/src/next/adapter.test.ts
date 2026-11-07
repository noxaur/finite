import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { modifyConfig } from "./adapter.ts";
import { nextBundler } from "./index.ts";

const OPTIONS = {
  loader: "/finite/loader.ts",
  root: "/app",
  distDir: ".finite/runtime/next",
  sheets: {},
};
const LOADER = { loader: OPTIONS.loader, options: { root: OPTIONS.root, sheets: OPTIONS.sheets } };

describe("modifyConfig", () => {
  beforeEach(() => {
    process.env.FINITE_NEXT = JSON.stringify(OPTIONS);
  });
  afterEach(() => {
    delete process.env.FINITE_NEXT;
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

  test("keeps webpack from watching its own output in the distDir", () => {
    const watching = (ignored: RegExp | string[]) =>
      modifyConfig({}).webpack!({ module: { rules: [] }, watchOptions: { ignored } }, {})
        .watchOptions!.ignored;
    const next = watching(/node_modules/) as RegExp;
    expect(next.test("/app/node_modules/x.js")).toBe(true);
    expect(next.test("/app/.finite/runtime/next/static/chunks/app/layout.js")).toBe(true);
    expect(next.test("/app/.finite/runtime/frames.ts")).toBe(false);
    expect(watching(["**/dist/**"])).toEqual(["**/dist/**", "/app/.finite/runtime/next/**"]);
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
