// Builds this crate for the browser: `dist/finite.wasm`, which the web app
// loads (apps/web/src/design/wasm.ts). Cargo rebuilds only what changed, so
// running it again with nothing to do takes under a second.
//
//   vp run wasm#build
//
// Needs the wasm32 target: rustup target add wasm32-unknown-unknown
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const target = "wasm32-unknown-unknown";
const cargo = spawnSync(
  "cargo",
  ["build", "--quiet", "-p", "finite-wasm", "--target", target, "--profile", "wasm"],
  { cwd: here, stdio: "inherit" },
);
if (cargo.error || cargo.status !== 0) {
  console.error(
    `Building finite-wasm failed. If Cargo says the ${target} target isn't installed, run:\n  rustup target add ${target}`,
  );
  process.exit(1);
}
const built = path.join(here, "../../target", target, "wasm/finite_wasm.wasm");
const out = path.join(here, "dist/finite.wasm");
fs.mkdirSync(path.dirname(out), { recursive: true });
// Copy only when it changed, so the web app's dev server doesn't reload for nothing.
const bytes = fs.readFileSync(built);
if (!fs.existsSync(out) || !bytes.equals(fs.readFileSync(out))) fs.writeFileSync(out, bytes);
