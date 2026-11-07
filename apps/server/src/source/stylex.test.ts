import { Refused, type SourceEdit } from "@finite/protocol";
import { describe, expect, it } from "vite-plus/test";
import { rev } from "./files.ts";
import { rewrite } from "./rewrite.ts";
import { mentionsVar, readVars, writeVar } from "./stylex.ts";

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

  it("adds a create entry and a spread to an element without one, and remaps what moved", () => {
    const out = ok(run(CARD, [L(19)], "p", { color: "red", gap: null }));
    expect(out.code).toBe(
      CARD.replace(
        `  title: { fontSize: "20px" },\n`,
        `  title: { fontSize: "20px" },\n  text: {\n    color: "red",\n  },\n`,
      ).replace("<p>Body</p>", "<p {...stylex.props(styles.text)}>Body</p>"),
    );
    expect(out.remap).toEqual({ [L(17, 4)]: L(20, 4), [L(18)]: L(21), [L(19)]: L(22) });
  });

  it("keeps an inline style for an element with style, className or a spread it can't read", () => {
    for (const p of [`<p style={{ margin: 0 }}>`, `<p className="x">`, `<p {...rest}>`]) {
      const code = CARD.replace("<p>", p);
      const out = ok(run(code, [L(19)], "p", { color: "red" })).code;
      expect(out).toContain(`style={{`);
      expect(out).toContain(`color: "red"`);
      expect(out).not.toContain("styles.text");
    }
  });

  it("does nothing when every style is removed", () => {
    expect(ok(run(CARD, [L(19)], "p", { color: null })).code).toBe(CARD);
  });

  it("uses the file's named imports, and the namespace when props isn't one", () => {
    const named = `import { create as make, props as sx } from "@stylexjs/stylex";

const styles = make({ box: { margin: "0" } });

export const Box = () => <section {...sx(styles.box)}><p>Hi</p></section>;
`;
    expect(ok(run(named, [`${FILE}:5:54`], "p", { color: "red" })).code).toBe(
      named
        .replace(`{ box: { margin: "0" } }`, `{ box: { margin: "0" }, text: { color: "red" } }`)
        .replace("<p>", "<p {...sx(styles.text)}>"),
    );
    const createOnly = `import { create } from "@stylexjs/stylex";

const styles = create({});

export const Box = () => <p>Hi</p>;
`;
    expect(ok(run(createOnly, [`${FILE}:5:25`], "p", { color: "red" })).code).toBe(
      createOnly
        .replace(
          `import { create } from "@stylexjs/stylex";`,
          `import { create } from "@stylexjs/stylex";\nimport * as stylex from "@stylexjs/stylex";`,
        )
        .replace(`create({})`, `create({ text: { color: "red" } })`)
        .replace("<p>", "<p {...stylex.props(styles.text)}>"),
    );
  });

  it("adds a create object after the imports, and the import when the file has none", () => {
    const bare = `import { Link } from "react-router";

export function Hero() {
  return <section>Hi</section>;
}
`;
    const sheet = `const styles = stylex.create({\n  section: {\n    padding: "8px",\n  },\n});`;
    expect(ok(run(bare, [`${FILE}:4:9`], "section", { padding: "8px" })).code).toBe(
      bare
        .replace(
          `from "react-router";\n`,
          `from "react-router";\nimport * as stylex from "@stylexjs/stylex";\n\n${sheet}\n`,
        )
        .replace("<section>", "<section {...stylex.props(styles.section)}>"),
    );
    const none = `export default () => <section>Hi</section>;\n`;
    expect(ok(run(none, [`${FILE}:1:21`], "section", { padding: "8px" })).code).toBe(
      `import * as stylex from "@stylexjs/stylex";\n\n${sheet}\n\n` +
        none.replace("<section>", "<section {...stylex.props(styles.section)}>"),
    );
    const imported = `import * as sx from "@stylexjs/stylex";\n\n${none}`;
    expect(ok(run(imported, [`${FILE}:3:21`], "section", { padding: "8px" })).code).toBe(
      imported
        .replace(`\n\n`, `\n\n${sheet.replace("stylex.create", "sx.create")}\n\n`)
        .replace("<section>", "<section {...sx.props(styles.section)}>"),
    );
  });

  it("imports the namespace when the file names props but not create", () => {
    const code = `import { props } from "@stylexjs/stylex";\n\nexport const A = () => <p>Hi</p>;\n`;
    expect(ok(run(code, [`${FILE}:3:23`], "p", { color: "red" })).code).toBe(
      `import { props } from "@stylexjs/stylex";\nimport * as stylex from "@stylexjs/stylex";\n\n` +
        `const styles = stylex.create({\n  text: {\n    color: "red",\n  },\n});\n\n` +
        `export const A = () => <p {...props(styles.text)}>Hi</p>;\n`,
    );
  });

  it("picks free names for the namespace and the sheet, and ignores type-only imports", () => {
    const bare = `export const A = () => <p>Hi</p>;\n`;
    for (const [head, namespace, sheet] of [
      [`import { stylex } from "./helpers";`, "stylex2", "styles"],
      [`import type * as stylex from "@stylexjs/stylex";`, "stylex2", "styles"],
      [`import { type props } from "@stylexjs/stylex";`, "stylex", "styles"],
      [`import type { Styles as styles } from "./types";`, "stylex", "styles2"],
      [
        `import * as stylex from "stylex";\nfunction styles() {}\nclass styles2 {}`,
        "stylex",
        "styles3",
      ],
      [`const stylex = 1, { styles } = {};`, "stylex2", "styles2"],
      [`enum styles { A }`, "stylex", "styles2"],
      [`export const enum styles { A }`, "stylex", "styles2"],
      [`namespace stylex { export const a = 1; }`, "stylex2", "styles"],
      [`declare namespace styles { const a: number; }`, "stylex", "styles2"],
      [`namespace styles.inner { export const a = 1; }`, "stylex", "styles2"],
      [`namespace styles { export interface A {} export type B = 1; }`, "stylex", "styles"],
    ]) {
      const code = `${head}\n\n${bare}`;
      const line = code.split("\n").length - 1;
      const out = ok(run(code, [`${FILE}:${line}:23`], "p", { color: "red" })).code;
      expect(out).toContain(`const ${sheet} = ${namespace}.create({`);
      expect(out).toContain(`<p {...${namespace}.props(${sheet}.text)}>`);
      expect(out.includes(`import * as ${namespace} from "@stylexjs/stylex";`)).toBe(
        !code.includes(`* as ${namespace} from "stylex"`),
      );
    }
  });

  it("names the entry after the element's id or role, else its tag, without reusing a key", () => {
    const code = card("styles.card", `card: { padding: "16px" }, heading: {}, `).replace(
      "<div {...stylex.props(styles.card)}>Body</div>",
      `<div {...stylex.props(styles.card)}><h1>A</h1><b id="price-tag">B</b><i role="note">C</i><Link.Item>D</Link.Item></div>`,
    );
    const at = (tag: string) => {
      const i = code.indexOf(`<${tag}`);
      return `${FILE}:${code.slice(0, i).split("\n").length}:${i - code.lastIndexOf("\n", i) - 1}`;
    };
    const named = (tag: string, loc = at(tag)) =>
      /stylex\.props\(styles\.(\w+)\)\}>[A-D]</.exec(
        ok(run(code, [loc], tag.split(" ")[0]!, { color: "red" })).code,
      )![1];
    expect(named("h1")).toBe("heading2");
    expect(named("b")).toBe("priceTag");
    expect(named("i")).toBe("note");
    expect(named("Link.Item")).toBe("item");
  });

  it("refuses a new entry when a local hides the sheet or StyleX's namespace", () => {
    const code = CARD.replace(
      "export function Card({ active, style }",
      "export function Card({ active, style, styles }",
    );
    expect(refused(run(code, [L(19)], "p", { color: "red" }))).toContain(
      "A parameter or local named styles hides the module-level one",
    );
  });

  it("refuses a new entry in a create object built from code", () => {
    const code = `import * as stylex from "@stylexjs/stylex";\n\nconst styles = stylex.create(base);\n\nexport const A = () => <p>Hi</p>;\n`;
    expect(refused(run(code, [`${FILE}:5:23`], "p", { color: "red" }))).toContain(
      "styles is built from code",
    );
  });

  it("gives each element of a batch its own new entry", () => {
    const list = `import * as stylex from "@stylexjs/stylex";

const styles = stylex.create({
  list: {
    margin: "0",
  },
});

export const List = () => (
  <ul {...stylex.props(styles.list)}>
    <li>A</li>
    <li>B</li>
  </ul>
);
`;
    const first = ok(run(list, [`${FILE}:11:4`, `${FILE}:12:4`], "li", { padding: "4px" }));
    expect(first.code).toBe(
      list
        .replace(
          `  },\n});`,
          `  },\n  item: {\n    padding: "4px",\n  },\n  item2: {\n    padding: "4px",\n  },\n});`,
        )
        .replace("<li>A", "<li {...stylex.props(styles.item)}>A")
        .replace("<li>B", "<li {...stylex.props(styles.item2)}>B"),
    );
    expect(first.remap).toEqual({
      [`${FILE}:10:2`]: `${FILE}:16:2`,
      [`${FILE}:11:4`]: `${FILE}:17:4`,
      [`${FILE}:12:4`]: `${FILE}:18:4`,
    });
    const locs = [first.remap[`${FILE}:11:4`]!, first.remap[`${FILE}:12:4`]!];
    const second = ok(run(first.code, locs, "li", { padding: "8px" }));
    expect(second.code).toBe(first.code.replaceAll(`padding: "4px"`, `padding: "8px"`));
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

describe("defineVars tokens", () => {
  const VARS = `import * as stylex from "@stylexjs/stylex";

export const colors = stylex.defineVars({
  brand: "#95ced7",
  ink: {
    default: "#1d2a2e",
    "@media (prefers-color-scheme: dark)": "#e3f1f3",
  },
  typed: stylex.types.color("#000"),
  alias: brand,
  "line-soft": \`#c8d3d6\`,
});

const local = stylex.defineVars({ hidden: "1px" });
`;
  const F = "src/tokens.stylex.ts";

  it("reads plain and conditional values and skips values built from code", () => {
    expect(readVars(F, VARS)).toEqual({
      groups: ["colors"],
      tokens: [
        { name: "colors.brand", light: "#95ced7" },
        { name: "colors.ink", light: "#1d2a2e", dark: "#e3f1f3" },
        { name: "colors.line-soft", light: "#c8d3d6" },
      ],
    });
    const named = `import { defineVars as dv } from "@stylexjs/stylex";\nexport const space = dv({ gap: 8 });\n`;
    expect(readVars(F, named).tokens).toEqual([{ name: "space.gap", light: "8" }]);
  });

  it("reads a negative number and keeps it when a dark branch is added", () => {
    const code = `import * as stylex from "@stylexjs/stylex";\nexport const space = stylex.defineVars({ offset: -8, nudge: +2 });\n`;
    expect(readVars(F, code).tokens).toEqual([{ name: "space.offset", light: "-8" }]);
    expect(writeVar(F, code, "space.offset", "light", "-12")).toBe(
      code.replace("offset: -8", `offset: "-12"`),
    );
    expect(writeVar(F, code, "space.offset", "dark", "-4")).toBe(
      code.replace(
        "offset: -8",
        `offset: { default: -8, "@media (prefers-color-scheme: dark)": "-4" }`,
      ),
    );
  });

  it("sets a light value and keeps the other branches", () => {
    expect(writeVar(F, VARS, "colors.brand", "light", "#000")).toBe(
      VARS.replace(`brand: "#95ced7"`, `brand: "#000"`),
    );
    expect(writeVar(F, VARS, "colors.ink", "light", "#111")).toBe(
      VARS.replace(`default: "#1d2a2e"`, `default: "#111"`),
    );
    expect(writeVar(F, VARS, "colors.ink", "dark", "#fff")).toBe(
      VARS.replace(`dark)": "#e3f1f3"`, `dark)": "#fff"`),
    );
  });

  it("adds the dark branch to a plain value, and clearing it makes the value plain again", () => {
    const dark = writeVar(F, VARS, "colors.brand", "dark", "#1a6f7b");
    expect(dark).toBe(
      VARS.replace(
        `brand: "#95ced7",`,
        `brand: {\n    default: "#95ced7",\n    "@media (prefers-color-scheme: dark)": "#1a6f7b",\n  },`,
      ),
    );
    expect(readVars(F, dark).tokens[0]).toEqual({
      name: "colors.brand",
      light: "#95ced7",
      dark: "#1a6f7b",
    });
    expect(writeVar(F, dark, "colors.brand", "dark", null)).toBe(VARS);
    const inline = `import * as stylex from "@stylexjs/stylex";\nexport const c = stylex.defineVars({ a: "1px" });\n`;
    expect(writeVar(F, inline, "c.a", "dark", "2px")).toBe(
      inline.replace(
        `a: "1px"`,
        `a: { default: "1px", "@media (prefers-color-scheme: dark)": "2px" }`,
      ),
    );
  });

  it("adds a new token after the group's others and removes one", () => {
    expect(writeVar(F, VARS, "colors.accent", "light", "#f0c")).toBe(
      VARS.replace("`#c8d3d6`,\n", '`#c8d3d6`,\n  accent: "#f0c",\n'),
    );
    expect(writeVar(F, VARS, "colors.brand", "light", null)).toBe(
      VARS.replace(`  brand: "#95ced7",\n`, ""),
    );
  });

  it("refuses what it can't write", () => {
    expect(() => writeVar(F, VARS, "colors.accent", "dark", "#000")).toThrow(
      /Set its Light value first/,
    );
    expect(() => writeVar(F, VARS, "colors.ink", "light", null)).toThrow(
      /Clear its Dark value first/,
    );
    expect(() => writeVar(F, VARS, "colors.typed", "light", "#fff")).toThrow(/built from code/);
    expect(() => writeVar(F, VARS, "space.gap", "light", "1px")).toThrow(
      /no defineVars named space/,
    );
  });
});

describe("picking a defineVars token", () => {
  const VARS = {
    "colors.brand": "src/tokens.stylex.ts",
    "colors.line-soft": "src/tokens.stylex.ts",
  };
  const pick = (
    code: string,
    styles: Record<string, string | null>,
    at = L(17, 4),
    tag = "div",
  ) => {
    const edit: SourceEdit = {
      kind: "style",
      locs: [at],
      tag,
      styles,
      revs: { [FILE]: rev(code) },
    };
    return rewrite(code, FILE, [edit], "stylex", { theme: {}, files: {}, stylexVars: VARS });
  };

  it("writes the member expression and imports the group after the other imports", () => {
    const out = ok(pick(CARD, { color: "colors.brand", margin: "colors.line-soft" }));
    expect(out.code).toBe(
      CARD.replace(
        `import * as stylex from "@stylexjs/stylex";\n`,
        `import * as stylex from "@stylexjs/stylex";\nimport { colors } from "./tokens.stylex";\n`,
      )
        .replace(`default: "black"`, "default: colors.brand")
        .replace(
          `":hover": "blue",\n    },\n`,
          `":hover": "blue",\n    },\n    margin: colors["line-soft"],\n`,
        ),
    );
    // The import and the new margin moved the div down two lines.
    expect(out.remap[L(17, 4)]).toBe(L(19, 4));
    // Picking again reuses the import.
    const again = ok(pick(out.code, { padding: "colors.brand" }, L(19, 4))).code;
    expect(again.match(/tokens\.stylex/g)).toHaveLength(1);
    expect(again).toContain("padding: colors.brand,");
  });

  it("uses the local name of an aliased import and a free name when the group's is taken", () => {
    const aliased = CARD.replace(
      `\n\nconst styles`,
      `\nimport { colors as c } from "./tokens.stylex";\n\nconst styles`,
    );
    expect(ok(pick(aliased, { padding: "colors.brand" }, L(18, 4))).code).toContain(
      "padding: c.brand,",
    );
    const taken = CARD.replace(`\n\nconst styles`, `\nconst colors = ["red"];\n\nconst styles`);
    const renamed = ok(pick(taken, { color: "colors.brand" }, L(18, 4))).code;
    expect(renamed).toContain(`import { colors as colors2 } from "./tokens.stylex";\n`);
    expect(renamed).toContain("default: colors2.brand,");
  });

  it("refuses a token it doesn't know, and one on an element with a style but no spread", () => {
    expect(pick(CARD, { color: "colors.nope" })).toMatchObject({ code: "not-found" });
    const styled = CARD.replace("<p>", `<p style={{ margin: 0 }}>`);
    expect(pick(styled, { color: "colors.brand" }, L(19), "p")).toMatchObject({
      code: "unsupported-style",
      message: expect.stringContaining("no stylex.props spread"),
    });
  });

  it("gives a bare element a new entry with the token and imports the group once", () => {
    const out = ok(pick(CARD, { color: "colors.brand", margin: "calc(colors.brand)" }, L(19), "p"));
    expect(out.code).toBe(
      CARD.replace(
        `import * as stylex from "@stylexjs/stylex";\n`,
        `import * as stylex from "@stylexjs/stylex";\nimport { colors } from "./tokens.stylex";\n`,
      )
        .replace(
          `title: { fontSize: "20px" },\n`,
          'title: { fontSize: "20px" },\n  text: {\n    color: colors.brand,\n    margin: `calc(${colors.brand})`,\n  },\n',
        )
        .replace("<p>", "<p {...stylex.props(styles.text)}>"),
    );
    expect(out.remap[L(19)]).toBe(L(24));
  });

  it("adds the StyleX import and the token import together, in the file's style and under free names", () => {
    const code = `import { useState } from 'react'\n\nenum stylex { A }\nconst colors = 1\n\nexport const A = () => <p>{useState(colors)[0]}</p>\n`;
    const edit: SourceEdit = {
      kind: "style",
      locs: [`${FILE}:6:23`],
      tag: "p",
      styles: { color: "colors.brand" },
      revs: { [FILE]: rev(code) },
    };
    const out = ok(
      rewrite(code, FILE, [edit], "stylex", { theme: {}, files: {}, stylexVars: VARS }),
    ).code;
    expect(out).toBe(
      code
        .replace(
          `from 'react'\n`,
          `from 'react'\nimport * as stylex2 from '@stylexjs/stylex'\nimport { colors as colors2 } from './tokens.stylex'\n\nconst styles = stylex2.create({\n  text: {\n    color: colors2.brand,\n  },\n});\n`,
        )
        .replace("<p>", "<p {...stylex2.props(styles.text)}>"),
    );
  });

  it("refuses a token on a Tailwind, CSS-modules or inline element", () => {
    const code = `export const A = () => <div className="p-2">x</div>;\n`;
    for (const convention of ["tailwind", "css-modules", "inline"] as const) {
      const edit: SourceEdit = {
        kind: "style",
        locs: [`${FILE}:1:23`],
        tag: "div",
        styles: { color: "colors.brand" },
        revs: { [FILE]: rev(code) },
      };
      const result = rewrite(code, FILE, [edit], convention, {
        theme: {},
        files: {},
        stylexVars: VARS,
      });
      expect(result).toMatchObject({
        code: "unsupported-style",
        message: expect.stringContaining("is a StyleX token"),
      });
    }
  });

  it("writes a template literal when a token sits inside a value", () => {
    const mixed = "color-mix(in srgb, colors.brand 50%, transparent)";
    const out = ok(pick(CARD, { color: mixed, padding: "1.5rem", margin: "0.5" }));
    expect(out.code).toBe(
      CARD.replace(
        `import * as stylex from "@stylexjs/stylex";\n`,
        `import * as stylex from "@stylexjs/stylex";\nimport { colors } from "./tokens.stylex";\n`,
      )
        .replace(
          `default: "black"`,
          "default: `color-mix(in srgb, ${colors.brand} 50%, transparent)`",
        )
        .replace(`padding: "16px"`, `padding: "1.5rem"`)
        .replace(`":hover": "blue",\n    },\n`, `":hover": "blue",\n    },\n    margin: "0.5",\n`),
    );
  });

  it("leaves a value with only unknown names a string and escapes the template text", () => {
    const out = ok(
      pick(CARD, {
        padding: "url(a.png)",
        margin: "calc(colors.brand + `x` + \\ + ${y})",
      }),
    ).code;
    expect(out).toContain(`padding: "url(a.png)"`);
    expect(out).toContain("margin: `calc(${colors.brand} + \\`x\\` + \\\\ + \\${y})`");
    expect(out.match(/tokens\.stylex/g)).toHaveLength(1);
  });

  it("keeps token names inside urls, quoted strings and longer words out of the template", () => {
    const out = ok(
      pick(CARD, {
        backgroundImage: "url(colors.brand.png)",
        fontFamily: `"colors.brand", 'colors.brand', sans-serif`,
        margin: "url( 'colors.brand' )",
        padding: "colors.brand.png",
        gap: "1px colors.brandx",
      }),
    ).code;
    expect(out).toContain(`backgroundImage: "url(colors.brand.png)"`);
    expect(out).toContain(`fontFamily: "\\"colors.brand\\", 'colors.brand', sans-serif"`);
    expect(out).toContain(`margin: "url( 'colors.brand' )"`);
    expect(out).toContain(`padding: "colors.brand.png"`);
    expect(out).toContain(`gap: "1px colors.brandx"`);
    expect(out).not.toContain("tokens.stylex");
  });

  it("still interpolates a token that sits next to a url or a quoted string", () => {
    const out = ok(
      pick(CARD, {
        backgroundImage: `linear-gradient(colors.brand, transparent), url(colors.brand.png)`,
      }),
    ).code;
    expect(out).toContain(
      "backgroundImage: `linear-gradient(${colors.brand}, transparent), url(colors.brand.png)`",
    );
  });

  it("only looks for tokens outside urls and quoted strings when deciding to load them", () => {
    expect(mentionsVar({ color: "colors.brand" })).toBe(true);
    expect(mentionsVar({ color: "color-mix(in srgb, colors.brand 50%, red)" })).toBe(true);
    expect(mentionsVar({ a: "url(colors.brand.png)", b: `"colors.brand", serif`, c: null })).toBe(
      false,
    );
    expect(mentionsVar({ a: "colors.brand.png" })).toBe(false);
  });

  it("still writes a custom property pick as a string", () => {
    expect(ok(pick(CARD, { padding: "var(--gap)" })).code).toContain(`padding: "var(--gap)",`);
  });
});
