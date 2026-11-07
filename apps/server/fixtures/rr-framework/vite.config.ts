import { reactRouter } from "@react-router/dev/vite";

// No `defineConfig` import: the repo lint would rewrite "vite" to "vite-plus".
export default { plugins: [reactRouter()] };
