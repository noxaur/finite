import { reactRouter } from "@react-router/dev/vite";
import stylex from "@stylexjs/unplugin";

// No `defineConfig` import: the repo lint would rewrite "vite" to "vite-plus".
export default { plugins: [stylex.vite(), reactRouter()] };
