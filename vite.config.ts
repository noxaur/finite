import { defineConfig } from "vite-plus";

export default defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  lint: {
    // Standalone projects with their own dependencies, installed only when a test copies them out.
    ignorePatterns: ["apps/server/scaffold/**", "apps/server/fixtures/**"],
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true },
  },
  run: {
    cache: true,
    tasks: {
      // The end-to-end test drives live processes, so it's never cached: a
      // cached run would replay an old pass without opening a browser. A
      // cached task also gets only the environment variables it lists, so
      // E2E_SKIP_BUILD, FINITE_CHROME and FINITE_REAL_AGENT wouldn't reach it.
      e2e: { command: "node e2e/run.mjs", cache: false },
    },
  },
});
