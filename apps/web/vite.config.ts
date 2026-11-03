import { resolve } from "node:path";
import { defineConfig } from "vite-plus";

export default defineConfig({
  // `vp test` in this folder. The workspace's vite.config.ts sets the same
  // for `vp test` at the root.
  // The `@/` imports the app resolves through tsconfig.
  resolve: { alias: { "@": resolve(__dirname, "src") } },
  test: { globalSetup: ["src/design/wasm.setup.ts"] },
});
