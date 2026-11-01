import { defineConfig } from "vite-plus";

export default defineConfig({
  // `vp test` in this folder. The workspace's vite.config.ts sets the same
  // for `vp test` at the root.
  test: { globalSetup: ["src/design/wasm.setup.ts"] },
});
