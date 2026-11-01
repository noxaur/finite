// Vitest's global setup: rebuilds finite.wasm before the tests run, so they
// test the current Rust code. Cargo skips the work when nothing changed.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export default function setup() {
  const script = fileURLToPath(new URL("../../../../crates/wasm/build.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [script], { stdio: "inherit" });
  if (result.status !== 0) throw new Error("building finite.wasm failed");
}
