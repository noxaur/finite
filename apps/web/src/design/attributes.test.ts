import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { isSafeAttr } from "./attributes";

// Recorded from the Rust rules by crates/design/tests/attributes.rs. The
// viewer guards the same shadow roots, so it must agree on every case.
const fixture = JSON.parse(
  readFileSync(
    new URL("../../../../crates/design/fixtures/attributes.json", import.meta.url),
    "utf8",
  ),
) as {
  readonly cases: ReadonlyArray<{
    readonly name: string;
    readonly value: string;
    readonly safe: boolean;
  }>;
};

describe("isSafeAttr", () => {
  it.each(fixture.cases.map((c) => [`${c.name}=${JSON.stringify(c.value)}`, c] as const))(
    "agrees with the server on %s",
    (_, c) => {
      expect(isSafeAttr(c.name, c.value)).toBe(c.safe);
    },
  );
});
