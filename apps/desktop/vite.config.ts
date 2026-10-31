import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    // Electron loads the main process as CommonJS, and sandboxed preloads must be CommonJS.
    entry: ["src/main.ts", "src/preload.ts"],
    format: "cjs",
    platform: "node",
    target: "node22",
    sourcemap: true,
    dts: false,
    deps: { neverBundle: ["electron"] },
  },
});
