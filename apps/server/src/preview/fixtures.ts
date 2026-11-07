import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const FIXTURES = fileURLToPath(new URL("../../fixtures/", import.meta.url));

/**
 * Copies `apps/server/fixtures/<name>` to a temp folder and installs its dependencies there, so
 * tests run it like a person's own project, outside this workspace and its lockfile. The
 * fixtures pin exact versions; `--prefer-offline` takes them from the pnpm store when it can.
 * `sass` has an optional file watcher with a build script, which pnpm 12 otherwise fails on.
 */
export async function prepareFixture(name: string, options: { install?: boolean } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `finite-${name}-`)));
  fs.cpSync(path.join(FIXTURES, name), root, {
    recursive: true,
    filter: (source) => !source.split(path.sep).includes("node_modules"),
  });
  if (options.install !== false) {
    await promisify(execFile)(
      "pnpm",
      [
        "install",
        "--prefer-offline",
        "--ignore-workspace",
        "--no-lockfile",
        "--reporter=silent",
        "--config.strict-dep-builds=false",
      ],
      { cwd: root, timeout: 180_000 },
    );
  }
  return { root, remove: () => fs.rmSync(root, { recursive: true, force: true }) };
}
