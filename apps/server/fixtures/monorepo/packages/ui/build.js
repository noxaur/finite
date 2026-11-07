import fs from "node:fs";

// A stand-in for a real bundler: the app imports dist/, so it fails until this runs.
fs.mkdirSync("dist", { recursive: true });
fs.copyFileSync("src/index.js", "dist/index.js");
fs.writeFileSync(
  "dist/index.d.ts",
  'import type { ReactNode } from "react";\nexport declare function Badge(props: { children: ReactNode }): ReactNode;\n',
);
