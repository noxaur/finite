import { defineConfig } from "vite-plus";

const shared = {
  format: "esm" as const,
  platform: "node" as const,
  target: "node22",
  sourcemap: true,
  dts: false,
  fixedExtension: true,
  deps: { onlyBundle: false as const, alwaysBundle: [/.*/] },
};

export default defineConfig({
  // `vp run build` bundles the server into dist/main.mjs, which the desktop app runs with
  // Electron's Node (ELECTRON_RUN_AS_NODE). Development runs src/main.ts directly. Each design's
  // dev server is a child running vite-host.mjs (or next-host.mjs) with the Vite plugin, so those
  // are bundled beside it as plain JavaScript: the packaged app has no TypeScript sources to strip.
  // The bridge, and the adapter and loader Next loads by path, are builds of their own, so each is
  // one file that shares no chunk: the plugin serves the bridge's text as a module.
  pack: [
    {
      ...shared,
      entry: {
        main: "src/main.ts",
        "vite-host": "src/preview/vite-host.mjs",
        "next-host": "src/preview/next-host.mjs",
        "vite-plugin": "../../packages/vite-plugin/src/index.ts",
      },
    },
    ...Object.entries({
      "vite-plugin-bridge": "../../packages/vite-plugin/src/client/bridge.ts",
      "next-adapter": "../../packages/vite-plugin/src/next/adapter.ts",
      "next-loader": "../../packages/vite-plugin/src/next/loader.ts",
    }).map(([name, file]) => ({ ...shared, entry: { [name]: file }, clean: false })),
  ],
});
