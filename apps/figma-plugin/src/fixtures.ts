import { readFileSync } from "node:fs";

/**
 * A payload from `crates/transfer/fixtures/figma/`, which the Rust tests read
 * and write too. Tests that start from it fail when the two sides drift.
 */
export const fixture = (name: string): string =>
  readFileSync(
    new URL(`../../../crates/transfer/fixtures/figma/${name}.figma.json`, import.meta.url),
    "utf8",
  );
