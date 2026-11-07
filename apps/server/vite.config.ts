import { defineConfig } from "vite-plus";

export default defineConfig({
  // `vp run build` bundles the server into dist/main.mjs, which the desktop app runs with
  // Electron's Node (ELECTRON_RUN_AS_NODE). Development runs src/main.ts directly. Each design's
  // dev server is a child running vite-host.mjs with the Vite plugin, so those are bundled
  // beside it as plain JavaScript: the packaged app has no TypeScript sources to strip.
  pack: {
    entry: {
      main: "src/main.ts",
      "vite-host": "src/preview/vite-host.mjs",
      "vite-plugin": "../../packages/vite-plugin/src/index.ts",
      "vite-plugin-bridge": "../../packages/vite-plugin/src/client/bridge.ts",
    },
    format: "esm",
    platform: "node",
    target: "node22",
    sourcemap: true,
    dts: false,
    fixedExtension: true,
    deps: { onlyBundle: false, alwaysBundle: [/.*/] },
  },
});
