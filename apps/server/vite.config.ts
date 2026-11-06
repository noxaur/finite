import { defineConfig } from "vite-plus";

export default defineConfig({
  // `vp run build` bundles the server into dist/main.mjs, which the desktop app runs with
  // Electron's Node (ELECTRON_RUN_AS_NODE). Development runs src/main.ts directly.
  pack: {
    entry: { main: "src/main.ts" },
    format: "esm",
    platform: "node",
    target: "node22",
    sourcemap: true,
    dts: false,
    fixedExtension: true,
    deps: { onlyBundle: false, alwaysBundle: [/.*/] },
  },
});
