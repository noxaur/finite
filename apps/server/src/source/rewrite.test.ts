import { Refused, type SourceEdit, type Styling } from "@finite/protocol";
import { describe, expect, it } from "vite-plus/test";
import { rev } from "./files.ts";
import { rewrite, type RewriteContext } from "./rewrite.ts";

const FILE = "src/App.tsx";

const APP = `import styles from "./App.module.css";

export function App() {
  return (
    <main className="flex p-4">
      <h1 className="text-sm font-bold">Hello</h1>
      <p>One</p>
      <span style={{ color: "red" }}>Two</span>
    </main>
  );
}
`;

// Positions in APP: main 5:4, h1 6:6, p 7:6, span 8:6.
const L = (line: number, col = 6) => `${FILE}:${line}:${col}`;

type Edit = SourceEdit extends infer E ? (E extends SourceEdit ? Omit<E, "revs"> : never) : never;

function run(
  code: string,
  edits: Edit[],
  convention: Styling = "tailwind",
  ctx: Partial<RewriteContext> = {},
) {
  const r = rev(code);
  return rewrite(
    code,
    FILE,
    edits.map((e) => ({ ...e, revs: { [FILE]: r } }) as SourceEdit),
    convention,
    { theme: {}, files: {}, ...ctx },
  );
}

function ok(result: ReturnType<typeof run>) {
  if (result instanceof Refused) throw new Error(`refused: ${result.message}`);
  return result;
}

function refused(result: ReturnType<typeof run>) {
  if (!(result instanceof Refused)) throw new Error("expected a refusal");
  return { reason: result.message, code: result.code };
}

const conventions: Styling[] = ["tailwind", "css-modules", "inline", "stylex"];

describe.each(conventions)("structural edits (%s)", (convention) => {
  it("replaces plain text children", () => {
    expect(
      ok(run(APP, [{ kind: "text", loc: L(7), tag: "p", text: "Uno" }], convention)).code,
    ).toBe(APP.replace("<p>One</p>", "<p>Uno</p>"));
  });

  it("writes text JSX can't hold raw as a string expression", () => {
    expect(
      ok(run(APP, [{ kind: "text", loc: L(7), tag: "p", text: "a {b} <c>" }], convention)).code,
    ).toBe(APP.replace("<p>One</p>", `<p>{"a {b} <c>"}</p>`));
  });

  it("moves an element before a sibling and remaps every sibling that moved", () => {
    const out = ok(
      run(APP, [{ kind: "reorder", loc: L(8), tag: "span", before: L(6) }], convention),
    );
    expect(out.code).toBe(`import styles from "./App.module.css";

export function App() {
  return (
    <main className="flex p-4">
      <span style={{ color: "red" }}>Two</span>
      <h1 className="text-sm font-bold">Hello</h1>
      <p>One</p>
    </main>
  );
}
`);
    expect(out.remap).toEqual({ [L(6)]: L(7), [L(7)]: L(8), [L(8)]: L(6) });
  });

  it("moves an element to the end", () => {
    const out = ok(run(APP, [{ kind: "reorder", loc: L(6), tag: "h1", before: null }], convention));
    expect(out.code).toContain(`<p>One</p>
      <span style={{ color: "red" }}>Two</span>
      <h1 className="text-sm font-bold">Hello</h1>
    </main>`);
    expect(out.remap).toEqual({ [L(6)]: L(8), [L(7)]: L(6), [L(8)]: L(7) });
  });

  it("removes an element and its line", () => {
    const out = ok(run(APP, [{ kind: "remove", locs: [L(7)] }], convention));
    expect(out.code).toBe(APP.replace("\n      <p>One</p>", ""));
    expect(out.remap).toEqual({ [L(8)]: L(7) });
  });

  it("duplicates an element on the next line", () => {
    const out = ok(run(APP, [{ kind: "duplicate", locs: [L(7)] }], convention));
    expect(out.code).toBe(APP.replace("<p>One</p>", "<p>One</p>\n      <p>One</p>"));
    expect(out.remap).toEqual({ [L(8)]: L(9) });
  });

  it("sets, replaces and removes attributes", () => {
    const added = ok(
      run(APP, [{ kind: "attr", loc: L(7), name: "id", value: "intro" }], convention),
    ).code;
    expect(added).toBe(APP.replace("<p>One</p>", `<p id="intro">One</p>`));
    const replaced = ok(
      run(added, [{ kind: "attr", loc: L(7), name: "id", value: 'say "hi"' }], convention),
    ).code;
    expect(replaced).toBe(APP.replace("<p>One</p>", `<p id={"say \\"hi\\""}>One</p>`));
    expect(
      ok(run(replaced, [{ kind: "attr", loc: L(7), name: "id", value: null }], convention)).code,
    ).toBe(APP);
  });
});

describe("tailwind styles", () => {
  it("edits a string className, preferring theme names", () => {
    const out = ok(
      run(
        APP,
        [
          {
            kind: "style",
            locs: [L(5, 4)],
            tag: "main",
            styles: { padding: "8px", "background-color": "#95CED7", width: "312px", gap: null },
          },
        ],
        "tailwind",
        { theme: { "--color-primary": "#95ced7" } },
      ),
    );
    expect(out.code).toBe(
      APP.replace(`<main className="flex p-4">`, `<main className="flex p-2 bg-primary w-78">`),
    );
  });

  it("falls back to arbitrary values and resolves conflicts", () => {
    const out = ok(
      run(APP, [
        {
          kind: "style",
          locs: [L(6)],
          tag: "h1",
          styles: { fontSize: "15px", fontWeight: "600", color: "#123456" },
        },
      ]),
    );
    expect(out.code).toContain(`<h1 className="text-[15px] font-semibold text-[#123456]">`);
  });

  it("removes a property's classes", () => {
    const out = ok(
      run(APP, [{ kind: "style", locs: [L(6)], tag: "h1", styles: { "font-weight": null } }]),
    );
    expect(out.code).toContain(`<h1 className="text-sm">`);
  });

  it("adds a className when there is none", () => {
    const out = ok(
      run(APP, [{ kind: "style", locs: [L(7)], tag: "p", styles: { marginTop: "-16px" } }]),
    );
    expect(out.code).toContain(`<p className="-mt-4">One</p>`);
  });

  it("edits the last literal argument of cn() and strips conflicts from the others", () => {
    const code = `export const A = (p) => <div className={cn("p-4 flex", p.active && "bg-red-500", "w-4")}>x</div>;\n`;
    const out = ok(
      rewrite(
        code,
        FILE,
        [
          {
            kind: "style",
            locs: [`${FILE}:1:24`],
            tag: "div",
            styles: { padding: "2px", width: "100%" },
            revs: { [FILE]: rev(code) },
          },
        ],
        "tailwind",
        { theme: {}, files: {} },
      ),
    );
    expect(out.code).toBe(
      `export const A = (p) => <div className={cn("flex", p.active && "bg-red-500", "p-0.5 w-full")}>x</div>;\n`,
    );
  });

  it('edits a className written as {"..."} or a plain template literal', () => {
    const code = "export const A = () => <div className={`flex`}>x</div>;\n";
    const out = ok(
      rewrite(
        code,
        FILE,
        [
          {
            kind: "style",
            locs: [`${FILE}:1:23`],
            tag: "div",
            styles: { display: "grid" },
            revs: { [FILE]: rev(code) },
          },
        ],
        "tailwind",
        { theme: {}, files: {} },
      ),
    );
    expect(out.code).toBe("export const A = () => <div className={`grid`}>x</div>;\n");
  });

  it("refuses a computed className", () => {
    const code = `export const A = ({ c }) => <div className={c}>x</div>;\n`;
    const result = rewrite(
      code,
      FILE,
      [
        {
          kind: "style",
          locs: [`${FILE}:1:28`],
          tag: "div",
          styles: { width: "1px" },
          revs: { [FILE]: rev(code) },
        },
      ],
      "tailwind",
      { theme: {}, files: {} },
    );
    expect(refused(result)).toEqual({
      reason: "Ask the agent to change this",
      code: "unsupported-style",
    });
  });
});

describe("css-modules styles", () => {
  const code = `import styles from "./Card.module.css";

export function Card() {
  return (
    <div className={styles.card}>
      <p className={styles["title"]}>Hi</p>
      <i>no class</i>
    </div>
  );
}
`;
  const css = `.card {
  padding: 4px;
  color: red;
}
`;
  const edit = (line: number, col: number, tag: string, styles: Record<string, string | null>) =>
    rewrite(
      code,
      FILE,
      [
        {
          kind: "style",
          locs: [`${FILE}:${line}:${col}`],
          tag,
          styles,
          revs: { [FILE]: rev(code) },
        },
      ],
      "css-modules",
      {
        theme: {},
        files: { "src/Card.module.css": css },
      },
    );

  it("edits the rule in the imported module and leaves the TSX alone", () => {
    const out = ok(edit(5, 4, "div", { padding: "12px", color: null, backgroundColor: "#fff" }));
    expect(out.code).toBe(code);
    expect(out.files["src/Card.module.css"]).toBe(`.card {
  padding: 12px;
  background-color: #fff;
}
`);
  });

  it("adds the rule when the module has none", () => {
    const out = ok(edit(6, 6, "p", { fontSize: "20px" }));
    expect(out.files["src/Card.module.css"]).toBe(`${css}
.title {
  font-size: 20px;
}
`);
  });

  it("falls back to an inline style when the element has no className", () => {
    const out = ok(edit(7, 6, "i", { color: "blue" }));
    expect(out.code).toContain(`<i style={{ color: "blue" }}>no class</i>`);
  });

  it("refuses a string className it can't map to a module", () => {
    const plain = `export const A = () => <div className="x">x</div>;\n`;
    const result = rewrite(
      plain,
      FILE,
      [
        {
          kind: "style",
          locs: [`${FILE}:1:23`],
          tag: "div",
          styles: { width: "1px" },
          revs: { [FILE]: rev(plain) },
        },
      ],
      "css-modules",
      { theme: {}, files: {} },
    );
    expect(refused(result).code).toBe("unsupported-style");
  });
});

describe("inline styles", () => {
  it("edits the style object, adding, replacing and removing keys", () => {
    const out = ok(
      run(
        APP,
        [
          {
            kind: "style",
            locs: [L(8)],
            tag: "span",
            styles: { color: "blue", "font-size": "14px", "--accent": "#95ced7" },
          },
        ],
        "inline",
      ),
    );
    expect(out.code).toContain(
      `<span style={{ color: "blue", fontSize: "14px", "--accent": "#95ced7" }}>Two</span>`,
    );
  });

  it("keeps a multi-line object multi-line", () => {
    const code = `export const A = () => (
  <div
    style={{
      color: "red",
      padding: 4,
    }}
  />
);
`;
    const out = ok(
      rewrite(
        code,
        FILE,
        [
          {
            kind: "style",
            locs: [`${FILE}:2:2`],
            tag: "div",
            styles: { color: null, margin: "2px" },
            revs: { [FILE]: rev(code) },
          },
        ],
        "inline",
        { theme: {}, files: {} },
      ),
    );
    expect(out.code).toBe(`export const A = () => (
  <div
    style={{
      padding: 4,
      margin: "2px",
    }}
  />
);
`);
  });

  it("drops the style attribute when nothing is left", () => {
    const out = ok(
      run(APP, [{ kind: "style", locs: [L(8)], tag: "span", styles: { color: null } }], "inline"),
    );
    expect(out.code).toContain(`<span>Two</span>`);
  });

  it("adds a style prop when there is none", () => {
    const out = ok(
      run(APP, [{ kind: "style", locs: [L(7)], tag: "p", styles: { opacity: "0.5" } }], "inline"),
    );
    expect(out.code).toContain(`<p style={{ opacity: "0.5" }}>One</p>`);
  });

  it("refuses a style that isn't an object literal", () => {
    const code = `export const A = ({ s }) => <div style={s}>x</div>;\n`;
    const result = rewrite(
      code,
      FILE,
      [
        {
          kind: "style",
          locs: [`${FILE}:1:28`],
          tag: "div",
          styles: { width: "1px" },
          revs: { [FILE]: rev(code) },
        },
      ],
      "inline",
      { theme: {}, files: {} },
    );
    expect(refused(result).code).toBe("unsupported-style");
  });
});

describe("refusals and batches", () => {
  it("refuses a stale rev", () => {
    const result = rewrite(
      APP,
      FILE,
      [{ kind: "remove", locs: [L(7)], revs: { [FILE]: "00000000" } }],
      "tailwind",
      { theme: {}, files: {} },
    );
    expect(refused(result)).toEqual({ reason: "The file changed; try again", code: "stale" });
  });

  it("refuses when the element at the loc has another tag", () => {
    expect(refused(run(APP, [{ kind: "text", loc: L(7), tag: "h2", text: "x" }]))).toEqual({
      reason: "The file changed; try again",
      code: "stale",
    });
  });

  it("refuses a loc with no element", () => {
    expect(refused(run(APP, [{ kind: "remove", locs: [L(7, 7)] }])).code).toBe("stale");
  });

  it("refuses text that mixes in elements", () => {
    expect(refused(run(APP, [{ kind: "text", loc: L(5, 4), tag: "main", text: "x" }])).code).toBe(
      "unsupported-style",
    );
  });

  it("refuses removing a component's root", () => {
    expect(refused(run(APP, [{ kind: "remove", locs: [L(5, 4)] }])).code).toBe("unsupported-style");
  });

  it("applies several edits by their original locs and chains the remap", () => {
    const out = ok(
      run(APP, [
        { kind: "duplicate", locs: [L(6)] },
        { kind: "text", loc: L(8), tag: "span", text: "Zwei" },
        { kind: "style", locs: [L(7)], tag: "p", styles: { color: "#000" } },
      ]),
    );
    expect(out.code).toContain(`      <h1 className="text-sm font-bold">Hello</h1>
      <h1 className="text-sm font-bold">Hello</h1>
      <p className="text-black">One</p>
      <span style={{ color: "red" }}>Zwei</span>`);
    expect(out.remap).toEqual({ [L(7)]: L(8), [L(8)]: L(9) });
  });

  it("skips an element whose parent an earlier edit removed", () => {
    const code = `export const A = () => (
  <div>
    <section>
      <b>x</b>
    </section>
  </div>
);
`;
    const r = rev(code);
    const out = ok(
      rewrite(
        code,
        FILE,
        [{ kind: "remove", locs: [`${FILE}:3:4`, `${FILE}:4:6`], revs: { [FILE]: r } }],
        "tailwind",
        { theme: {}, files: {} },
      ),
    );
    expect(out.code).toBe("export const A = () => (\n  <div>\n  </div>\n);\n");
  });

  it("ignores edits for other files", () => {
    const result = ok(
      rewrite(
        APP,
        FILE,
        [{ kind: "remove", locs: ["src/Other.tsx:1:0"], revs: { "src/Other.tsx": "00000000" } }],
        "tailwind",
        { theme: {}, files: {} },
      ),
    );
    expect(result.code).toBe(APP);
  });
});
