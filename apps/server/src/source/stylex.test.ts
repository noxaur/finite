import { Refused, type SourceEdit } from "@finite/protocol";
import { describe, expect, it } from "vite-plus/test";
import { rev } from "./files.ts";
import { rewrite } from "./rewrite.ts";

const FILE = "src/Card.tsx";

const CARD = `import * as stylex from "@stylexjs/stylex";

const styles = stylex.create({
  card: {
    padding: "16px",
    color: {
      default: "black",
      ":hover": "blue",
    },
  },
  on: { borderColor: "red" },
  title: { fontSize: "20px" },
});

export function Card({ active, style }: { active: boolean; style?: stylex.StyleXStyles }) {
  return (
    <div {...stylex.props(styles.card, active && styles.on, style)}>
      <h2 {...stylex.props(styles.title)}>Title</h2>
      <p>Body</p>
    </div>
  );
}
`;

// Positions in CARD: div 17:4, h2 18:6, p 19:6.
const L = (line: number, col = 6) => `${FILE}:${line}:${col}`;

function run(code: string, locs: string[], tag: string, styles: Record<string, string | null>) {
  const edit: SourceEdit = { kind: "style", locs, tag, styles, revs: { [FILE]: rev(code) } };
  return rewrite(code, FILE, [edit], "stylex", { theme: {}, files: {} });
}

function ok(result: ReturnType<typeof run>) {
  if (result instanceof Refused) throw new Error(`refused: ${result.message}`);
  return result;
}

function refused(result: ReturnType<typeof run>) {
  if (!(result instanceof Refused)) throw new Error("expected a refusal");
  expect(result.code).toBe("unsupported-style");
  expect(result.message).toContain("Ask the agent to change this");
  return result.message;
}

/** CARD with its `<div>`'s props spread and the create object swapped. */
function card(args: string, create = `card: { padding: "16px" }, on: { color: "red" },`) {
  return `import * as stylex from "@stylexjs/stylex";
import { shared } from "./shared.ts";

const styles = stylex.create({
  ${create}
});

export function Card({ active, style }: { active: boolean; style?: stylex.StyleXStyles }) {
  return <div {...stylex.props(${args})}>Body</div>;
}
`;
}
const DIV = L(9, 9);
/** The loc of the `<div` in `code`. */
function divAt(code: string) {
  const before = code.slice(0, code.indexOf("<div"));
  const line = before.split("\n").length;
  return L(line, before.length - before.lastIndexOf("\n") - 1);
}

describe("stylex styles", () => {
  it("edits the create entry of the last unconditional argument, above the JSX", () => {
    const out = ok(
      run(CARD, [L(17, 4)], "div", { padding: "8px", "background-color": "#95ced7", gap: null }),
    );
    expect(out.code).toBe(
      CARD.replace(`    padding: "16px",`, `    padding: "8px",`).replace(
        `      ":hover": "blue",\n    },\n  },`,
        `      ":hover": "blue",\n    },\n    backgroundColor: "#95ced7",\n  },`,
      ),
    );
    expect(out.remap).toEqual({ [L(17, 4)]: L(18, 4), [L(18)]: L(19), [L(19)]: L(20) });
  });

  it("deletes a scalar property with null", () => {
    const out = ok(run(CARD, [L(17, 4)], "div", { padding: null }));
    expect(out.code).toBe(CARD.replace(`    padding: "16px",\n`, ""));
  });

  it("sets default in a conditional value and keeps the other branches", () => {
    const set = ok(run(CARD, [L(17, 4)], "div", { color: "#111" })).code;
    expect(set).toBe(CARD.replace(`default: "black"`, `default: "#111"`));
    const cleared = ok(run(CARD, [L(17, 4)], "div", { color: null })).code;
    expect(cleared).toBe(CARD.replace(`default: "black"`, `default: null`));
  });

  it("adds default to a conditional value that has none", () => {
    const code = card("styles.card", `card: { color: { ":hover": "blue" } },`);
    expect(ok(run(code, [DIV], "div", { color: "red" })).code).toBe(
      code.replace(`{ ":hover": "blue" }`, `{ ":hover": "blue", default: "red" }`),
    );
  });

  it("refuses a nested default", () => {
    const code = card(
      "styles.card",
      `card: { color: { default: { default: "red", "@media (min-width: 800px)": "blue" } } },`,
    );
    expect(refused(run(code, [DIV], "div", { color: "green" }))).toContain("nested default");
  });

  it("writes camelCase keys, quotes custom properties and fills an empty entry", () => {
    const code = card("styles.card", `card: {},`);
    expect(ok(run(code, [DIV], "div", { "border-radius": "4px", "--accent": "red" })).code).toBe(
      code.replace(`card: {},`, `card: { borderRadius: "4px", "--accent": "red" },`),
    );
  });

  it("matches keys written in camelCase or quoted kebab-case", () => {
    const code = card("styles.card", `card: { "font-size": "12px", lineHeight: "1" },`);
    expect(ok(run(code, [DIV], "div", { "font-size": "14px", "line-height": null })).code).toBe(
      code.replace(`{ "font-size": "12px", lineHeight: "1" }`, `{ "font-size": "14px" }`),
    );
  });

  it("refuses when a later argument it can resolve sets the same property", () => {
    expect(
      refused(run(card("styles.card, active && styles.on"), [DIV], "div", { color: "blue" })),
    ).toContain("active && styles.on comes later in stylex.props and sets color");
    expect(
      refused(run(card("styles.card, active ? styles.on : null"), [DIV], "div", { color: "blue" })),
    ).toContain("sets color");
  });

  it("refuses a later conditional array that sets the same property", () => {
    expect(
      refused(run(card("styles.card, active && [styles.on]"), [DIV], "div", { color: "blue" })),
    ).toContain("sets color");
    expect(
      refused(
        run(card("styles.card, [active ? styles.on : null]"), [DIV], "div", { color: "blue" }),
      ),
    ).toContain("sets color");
  });

  it("refuses when a parameter or local shadows the module-level sheet", () => {
    const signature =
      "export function Card({ active, style }: { active: boolean; style?: stylex.StyleXStyles }) {";
    const heads = [
      "export function Card({ styles }: { styles: any }) {",
      "export function Card({ a: [{ b: styles }] }: any) {",
      "export function Card(styles: any) {",
      `${signature}\n  const styles = {} as any;`,
      `${signature}\n  function styles() {}`,
    ];
    for (const head of heads) {
      const code = card("styles.card").replace(signature, head);
      const message = refused(run(code, [divAt(code)], "div", { padding: "4px" }));
      expect(message).toContain("styles.card");
      expect(message).toContain("not the module-level stylex.create object");
    }
  });

  it("refuses when a method parameter shadows the module-level sheet", () => {
    const body = `return <div {...stylex.props(styles.card)} />;`;
    const methods = [
      `export const Card = { render(styles: any) { ${body} } };`,
      `export class Card { render(styles: any) { ${body} } }`,
      `export class Card { #render(styles: any) { ${body} } }`,
      `export class Card { static render(styles: any) { ${body} } }`,
    ];
    for (const method of methods) {
      const code = card("styles.card").replace(/export function Card[\s\S]*$/, `${method}\n`);
      const message = refused(run(code, [divAt(code)], "div", { padding: "4px" }));
      expect(message).toContain("not the module-level stylex.create object");
    }
  });

  it("only counts a let, const or class declaration whose block encloses the element", () => {
    const signature =
      "export function Card({ active, style }: { active: boolean; style?: stylex.StyleXStyles }) {";
    const edited = (code: string) => ok(run(code, [divAt(code)], "div", { padding: "4px" })).code;
    for (const decl of [
      "const styles = {};",
      "let styles = {};",
      "class styles {}",
      "const { styles } = {} as any;",
    ]) {
      const code = card("styles.card").replace(
        signature,
        `${signature}\n  if (active) { ${decl} }`,
      );
      expect(edited(code)).toBe(code.replace(`padding: "16px"`, `padding: "4px"`));
    }
    const wrapped = card("styles.card")
      .replace("return <div", "{\n    const styles = {} as any;\n    return <div")
      .replace("</div>;", "</div>;\n  }");
    refused(run(wrapped, [divAt(wrapped)], "div", { padding: "4px" }));
    for (const decl of ["var styles = {};", "function styles() {}"]) {
      const code = card("styles.card").replace(
        signature,
        `${signature}\n  if (active) { ${decl} }`,
      );
      refused(run(code, [divAt(code)], "div", { padding: "4px" }));
    }
  });

  it("edits the module-level sheet when only a sibling function binds its name", () => {
    const code = card("styles.card").replace(
      "export function Card(",
      "function other(styles: any) {\n  return styles;\n}\n\nexport function Card(",
    );
    expect(ok(run(code, [divAt(code)], "div", { padding: "4px" })).code).toBe(
      code.replace(`padding: "16px"`, `padding: "4px"`),
    );
  });

  it("ignores later arguments that set other properties or that it can't resolve", () => {
    const code = card("styles.card, active && styles.on, style, active && shared.x");
    expect(ok(run(code, [DIV], "div", { padding: "4px" })).code).toBe(
      code.replace(`padding: "16px"`, `padding: "4px"`),
    );
  });

  it("picks the last unconditional argument and reads nested arrays", () => {
    const code = card("[styles.on, [styles.card]], active && styles.on");
    expect(ok(run(code, [DIV], "div", { padding: "4px" })).code).toBe(
      code.replace(`padding: "16px"`, `padding: "4px"`),
    );
  });

  it("works with named imports under any local name", () => {
    const code = `import { create as make, props as sx } from "@stylexjs/stylex";

export const styles = make({ box: { margin: "0" } });

export const Box = () => <section {...sx(styles.box)} />;
`;
    expect(ok(run(code, [`${FILE}:5:25`], "section", { margin: "8px" })).code).toBe(
      code.replace(`margin: "0"`, `margin: "8px"`),
    );
  });

  it("reads the sx prop StyleX compiles to a props spread", () => {
    const code = card("styles.card").replace(
      "<div {...stylex.props(styles.card)}>",
      "<div sx={[styles.card, active && styles.on]}>",
    );
    expect(ok(run(code, [DIV], "div", { padding: "4px" })).code).toBe(
      code.replace(`padding: "16px"`, `padding: "4px"`),
    );
  });

  it("refuses styles imported from another file", () => {
    expect(refused(run(card("shared.card"), [DIV], "div", { padding: "4px" }))).toContain(
      "shared.card comes from another file (./shared.ts)",
    );
  });

  it("refuses an entry built from code", () => {
    const fn = card("styles.card", `card: (size: string) => ({ padding: size }),`);
    expect(refused(run(fn, [DIV], "div", { padding: "4px" }))).toContain("dynamic style");
    const called = card("styles.card(4)", `card: (size: number) => ({ padding: size }),`);
    expect(refused(run(called, [DIV], "div", { padding: "4px" }))).toContain("dynamic style");
    const spread = card("styles.card", `card: { ...base, padding: "16px" },`);
    expect(refused(run(spread, [DIV], "div", { padding: "4px" }))).toContain("spread");
  });

  it("refuses when no argument always applies", () => {
    expect(
      refused(run(card("active && styles.card, style"), [DIV], "div", { padding: "4px" })),
    ).toContain("no style that always applies");
  });

  it("refuses more than one props spread on the element", () => {
    const code = card("styles.card").replace(
      "{...stylex.props(styles.card)}",
      "{...stylex.props(styles.card)} {...stylex.props(styles.on)}",
    );
    expect(refused(run(code, [DIV], "div", { padding: "4px" }))).toContain("more than once");
  });

  it("gives an element without a props spread an inline style", () => {
    expect(ok(run(CARD, [L(19)], "p", { color: "red" })).code).toBe(
      CARD.replace("<p>Body</p>", `<p style={{ color: "red" }}>Body</p>`),
    );
  });

  it("edits every element of a batch, then edits again through the remap", () => {
    const list = `import * as stylex from "@stylexjs/stylex";

const styles = stylex.create({
  a: {
    color: "red",
  },
  b: {
    color: "blue",
  },
});

export const List = () => (
  <ul>
    <li {...stylex.props(styles.a)}>A</li>
    <li {...stylex.props(styles.b)}>B</li>
  </ul>
);
`;
    const first = ok(run(list, [`${FILE}:14:4`, `${FILE}:15:4`], "li", { padding: "4px" }));
    expect(first.code).toBe(
      list
        .replace(`color: "red",`, `color: "red",\n    padding: "4px",`)
        .replace(`color: "blue",`, `color: "blue",\n    padding: "4px",`),
    );
    expect(first.remap).toEqual({
      [`${FILE}:13:2`]: `${FILE}:15:2`,
      [`${FILE}:14:4`]: `${FILE}:16:4`,
      [`${FILE}:15:4`]: `${FILE}:17:4`,
    });
    const locs = [first.remap[`${FILE}:14:4`]!, first.remap[`${FILE}:15:4`]!];
    const second = ok(run(first.code, locs, "li", { padding: null }));
    expect(second.code).toBe(list);
  });
});
