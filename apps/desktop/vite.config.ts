import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    // Electron loads the main process as CommonJS.
    entry: ["src/main.ts"],
    format: "cjs",
    platform: "node",
    target: "node22",
    sourcemap: true,
    dts: false,
    // Bundle everything else, electron-updater included, so the packaged app
    // ships no node_modules (electron-builder.yml).
    deps: { neverBundle: ["electron"], onlyBundle: false },
  },
});
