import fs from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import { rev, stamp } from "./stamp.ts";

const GOLDEN = new URL("./__golden__/", import.meta.url);

describe("stamp", () => {
  // Golden files end in .txt so the formatter and type checker leave them alone.
  for (const name of ["basic.tsx", "generic.tsx", "plain.jsx"]) {
    test(name, async () => {
      const code = fs.readFileSync(new URL(name.replace(".", ".input.") + ".txt", GOLDEN), "utf8");
      const result = stamp(code, `src/${name}`);
      await expect(result?.code).toMatchFileSnapshot(
        `./__golden__/${name.replace(".", ".output.")}.txt`,
      );
    });
  }

  test("uses the 1-based line and 0-based column of the <", () => {
    const result = stamp(`const a = (\n  <div />\n);\n`, "a.tsx");
    expect(result?.code).toContain(`data-finite-loc="a.tsx:2:2"`);
  });

  test("stamps the sha1 of the source as rev", () => {
    const code = "export const A = () => <p />;\n";
    expect(rev(code)).toMatch(/^[0-9a-f]{8}$/);
    expect(stamp(code, "a.tsx")?.code).toContain(`data-finite-rev="${rev(code)}"`);
  });

  test("leaves files without intrinsic elements or that don't parse alone", () => {
    expect(stamp(`export const A = () => <B><C.D /></B>;`, "a.tsx")).toBeNull();
    expect(stamp(`export const A = () => <div`, "a.tsx")).toBeNull();
  });

  test("maps stamped code back to the source", () => {
    const result = stamp(`export const A = () => <div>hi</div>;\n`, "a.tsx", "/abs/a.tsx")!;
    expect(result.map.sources).toEqual(["/abs/a.tsx"]);
    expect(result.map.mappings.split(",").length).toBeGreaterThan(10);
  });
});
