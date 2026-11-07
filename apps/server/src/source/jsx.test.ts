import { describe, expect, it } from "vite-plus/test";
import { snapLoc } from "./jsx.ts";

const HERO = `import { Button } from "./Button";

export default function Hero() {
  return (
    <section className="p-8">
      <img src="/mark.svg" alt="Mint mark" />
      <h1 className="text-4xl">Fresh mint</h1>
      <p>Grown <b>daily</b></p>
      <Button>Buy</Button>
    </section>
  );
}
`;
const FILE = "src/HomeHeroMint.tsx";
const snap = (near: Parameters<typeof snapLoc>[2]) => snapLoc(HERO, FILE, near);

describe("snapLoc", () => {
  it("keeps a loc that is already an element's `<`", () => {
    expect(snap({ line: 7, column: 6 })).toBe(`${FILE}:7:6`);
  });

  it("snaps a 1-based or in-tag column to the element whose tag holds it", () => {
    expect(snap({ line: 7, column: 7 })).toBe(`${FILE}:7:6`);
    expect(snap({ line: 7, column: 20 })).toBe(`${FILE}:7:6`);
    expect(snap({ line: 8, column: 15 })).toBe(`${FILE}:8:15`);
  });

  it("snaps a position in an element's content to that element", () => {
    expect(snap({ line: 7, column: 32 })).toBe(`${FILE}:7:6`);
  });

  it("finds the element on a line, or showing some text", () => {
    expect(snap({ line: 8 })).toBe(`${FILE}:8:6`);
    expect(snap({ line: 8, match: "daily" })).toBe(`${FILE}:8:15`);
    expect(snap({ match: "fresh MINT" })).toBe(`${FILE}:7:6`);
    expect(snap({ match: "Mint mark" })).toBe(`${FILE}:6:6`);
  });

  it("refuses a component or a spot with no element, naming elements nearby", () => {
    expect(() => snap({ line: 9, column: 7 })).toThrow(
      /<Button> .* is a component.*<p> src\/HomeHeroMint.tsx:8:6/,
    );
    expect(() => snap({ line: 1, column: 0 })).toThrow(
      /no HTML element at line 1, column 0.*<section>/,
    );
    expect(() => snap({ match: "nothing like this" })).toThrow(/showing "nothing like this"/);
  });
});
