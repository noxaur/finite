import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";

// No `defineConfig` import: the repo lint would rewrite "vite" to "vite-plus".
// `API_` exposes finite.json's API_PORT to the page as import.meta.env.API_PORT.
export default { plugins: [react(), tailwindcss()], envPrefix: ["VITE_", "API_"] };
