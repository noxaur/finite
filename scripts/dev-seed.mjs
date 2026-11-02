// Gives a dev server designs to look at. Copies each snapshot in
// crates/server/seed/designs/ into the dev data folder, unless that design is
// already there, so edits made in dev survive the next run.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const seed = path.join(root, "crates/server/seed/designs");
const designs = path.resolve(
  root,
  "crates/server",
  process.env.FINITE_DATA_DIR ?? "data",
  "designs",
);

fs.mkdirSync(designs, { recursive: true });
for (const file of fs.readdirSync(seed)) {
  const target = path.join(designs, file);
  if (fs.existsSync(target)) continue;
  fs.copyFileSync(path.join(seed, file), target);
  console.log(`dev-seed: added ${file}`);
}
