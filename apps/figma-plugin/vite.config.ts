import { defineConfig } from "vite-plus";

// Figma runs `code.js` in a sandbox and the UI as a script in an inline page.
// Neither can import anything, so each entry is its own IIFE build.
const iife = {
  format: "iife",
  platform: "browser",
  target: "es2019",
  dts: false,
  outputOptions: { entryFileNames: "[name].js" },
} as const;

export default defineConfig({
  pack: [
    { ...iife, entry: { code: "src/code.ts" }, clean: true },
    // `scripts/inline-ui.mjs` reads `dist/ui.js` into `dist/ui.html` and removes it.
    { ...iife, entry: { ui: "src/ui.ts" }, clean: false },
  ],
});
