import { afterEach, describe, expect, test } from "vite-plus/test";
import { type AdapterOptions, wrap } from "./adapter.ts";

const OPTIONS: AdapterOptions = {
  loader: "/finite/loader.ts",
  root: "/project",
  distDir: ".finite/runtime/next",
  sheets: {},
  configs: {},
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
