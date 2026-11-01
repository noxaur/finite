// Builds finite-server for each architecture the app is packaged for, and
// copies it to server/<arch>/, where electron-builder.yml picks it up.
//
//   node scripts/stage-server.mjs           # this machine's architecture
//   node scripts/stage-server.mjs arm64 x64 # both Mac builds
//
// Architectures use Node's names (x64, arm64), as electron-builder does.
// Cross-compiling needs the Rust target: rustup target add x86_64-apple-darwin
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const triples = {
  darwin: { arm64: "aarch64-apple-darwin", x64: "x86_64-apple-darwin" },
  linux: { arm64: "aarch64-unknown-linux-gnu", x64: "x86_64-unknown-linux-gnu" },
  win32: { arm64: "aarch64-pc-windows-msvc", x64: "x86_64-pc-windows-msvc" },
};
const exe = process.platform === "win32" ? "finite-server.exe" : "finite-server";
const arches = process.argv.length > 2 ? process.argv.slice(2) : [process.arch];

for (const arch of arches) {
  const triple = triples[process.platform]?.[arch];
  if (!triple) {
    console.error(`No Rust target for ${process.platform} ${arch}`);
    process.exit(1);
  }
  const cargo = spawnSync(
    "cargo",
    ["build", "--release", "--locked", "-p", "finite-server", "--target", triple],
    { cwd: root, stdio: "inherit" },
  );
  if (cargo.error || cargo.status !== 0) {
    console.error(`Building finite-server for ${triple} failed`);
    process.exit(1);
  }
  const out = path.join(here, "../server", arch);
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  fs.copyFileSync(path.join(root, "target", triple, "release", exe), path.join(out, exe));
}
