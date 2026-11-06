import react from "@vitejs/plugin-react";

// No `defineConfig` import: the repo lint would rewrite "vite" to "vite-plus".
export default { plugins: [react()] };
