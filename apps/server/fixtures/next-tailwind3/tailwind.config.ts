import type { Config } from "tailwindcss";

export default {
  content: ["./app/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: { brand: "#95ced7" },
    },
  },
} satisfies Config;
