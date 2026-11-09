import { type NewNode, Refused, type SourceEdit, type Styling } from "@finite/protocol";
import type * as t from "@babel/types";
import { describe, expect, it } from "vite-plus/test";
import { rev } from "./files.ts";
import { parseTsx } from "./jsx.ts";
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
      ok(
        run(
          APP,
          [
            {
              kind: "inline",
              loc: L(7),
              tag: "p",
              content: [{ t: "text", text: "Uno", marks: [] }],
            },
          ],
          convention,
        ),
      ).code,
    ).toBe(APP.replace("<p>One</p>", "<p>Uno</p>"));
  });

  it("writes text JSX can't hold raw as a string expression", () => {
    expect(
      ok(
        run(
          APP,
          [
            {
              kind: "inline",
              loc: L(7),
              tag: "p",
              content: [{ t: "text", text: "a {b} <c>", marks: [] }],
            },
          ],
          convention,
        ),
      ).code,
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
  it.each(conventions)(
    "refuses a Sass or Less variable on an element no module rule styles (%s)",
    (convention) => {
      for (const [value, sheet] of [
        ["$brand", ".module.scss"],
        ["1px solid @line", ".module.less"],
      ]) {
        const result = refused(
          run(
            APP,
            [{ kind: "style", locs: [L(7)], tag: "p", styles: { color: value! } }],
            convention,
          ),
        );
        expect(result.code).toBe("unsupported-style");
        expect(result.reason).toContain(sheet);
        expect(result.reason).toMatch(/Pick a CSS custom property \(--name\) token instead/);
      }
    },
  );

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
    expect(
      refused(
        run(APP, [
          { kind: "inline", loc: L(7), tag: "h2", content: [{ t: "text", text: "x", marks: [] }] },
        ]),
      ),
    ).toEqual({
      reason: "The file changed; try again",
      code: "stale",
    });
  });

  it("refuses a loc with no element", () => {
    expect(refused(run(APP, [{ kind: "remove", locs: [L(7, 7)] }])).code).toBe("stale");
  });

  it("refuses text that mixes in elements", () => {
    expect(
      refused(run(APP, [{ kind: "inline", loc: L(5, 4), tag: "main", content: [] }])).code,
    ).toBe("unsupported-style");
  });

  it("refuses removing a component's root", () => {
    expect(refused(run(APP, [{ kind: "remove", locs: [L(5, 4)] }])).code).toBe("unsupported-style");
  });

  it("applies several edits by their original locs and chains the remap", () => {
    const out = ok(
      run(APP, [
        { kind: "duplicate", locs: [L(6)] },
        {
          kind: "inline",
          loc: L(8),
          tag: "span",
          content: [{ t: "text", text: "Zwei", marks: [] }],
        },
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

describe("insert", () => {
  const rect = {
    tag: "div",
    ref: "r",
    name: "Rectangle",
    styles: { position: "absolute", left: "40px", width: "200px", "background-color": "#d9d9d9" },
  };
  const insert = (place: "start" | "end" | "before" | "after", node: NewNode = rect) => ({
    kind: "insert" as const,
    loc: L(5, 4),
    tag: "main",
    place,
    node,
  });

  it("writes classes in a Tailwind file and answers the new loc", () => {
    const out = ok(run(APP, [insert("end")]));
    expect(out.code).toContain(
      `<span style={{ color: "red" }}>Two</span>\n      <div data-name="Rectangle" className="absolute left-10 w-50 bg-[#d9d9d9]" />\n    </main>`,
    );
    expect(out.created).toEqual({ r: `${FILE}:9:6` });
  });

  it("writes an inline style in an inline file", () => {
    expect(ok(run(APP, [insert("end")], "inline")).code).toContain(
      `<div data-name="Rectangle" style={{ position: "absolute", left: "40px", width: "200px", backgroundColor: "#d9d9d9" }} />`,
    );
  });

  it("adds a stylex.create entry in a StyleX file", () => {
    const out = ok(run(APP, [insert("end")], "stylex")).code;
    expect(out).toMatch(/<div data-name="Rectangle" \{\.\.\.stylex\.props\(styles2\.div\)\} \/>/);
    expect(out).toMatch(/backgroundColor: "#d9d9d9"/);
  });

  describe("CSS modules", () => {
    const sheet = "src/App.module.css";
    const css = ".title { color: red; }\n";
    const files = { [sheet]: css };

    it("gives the element a class in the one sheet the file imports", () => {
      const out = ok(run(APP, [insert("end")], "css-modules", { files }));
      expect(out.code).toContain(`<div data-name="Rectangle" className={styles.rectangle} />`);
      expect(out.files[sheet]).toMatch(/\.rectangle \{[^}]*background-color: #d9d9d9/s);
    });

    it("picks a class name nothing uses", () => {
      const taken = { [sheet]: `${css}.rectangle { color: blue; }\n` };
      const out = ok(run(APP, [insert("end")], "css-modules", { files: taken }));
      expect(out.code).toContain("className={styles.rectangle2}");
    });

    it("stays inline when the file imports no sheet", () => {
      const bare = APP.replace(`import styles from "./App.module.css";\n`, "");
      const out = ok(
        run(bare, [{ ...insert("end"), loc: `${FILE}:4:4` }], "css-modules", { files }),
      );
      expect(out.code).toContain(`<div data-name="Rectangle" style={{`);
      expect(out.files[sheet]).toBe(css);
    });

    it("stays inline when the file imports two sheets", () => {
      const two = `import other from "./Other.module.css";\n${APP}`;
      const out = ok(
        run(two, [{ ...insert("end"), loc: `${FILE}:6:4` }], "css-modules", {
          files: { ...files, "src/Other.module.css": "" },
        }),
      );
      expect(out.code).toContain(`<div data-name="Rectangle" style={{`);
    });
  });

  it("goes first when asked", () => {
    const out = ok(run(APP, [insert("start")])).code;
    expect(out).toContain(`<main className="flex p-4">\n      <div data-name="Rectangle"`);
  });

  it("goes beside an element, and the elements after it move", () => {
    const edit = { ...insert("before"), loc: L(7), tag: "p" };
    const out = ok(run(APP, [edit]));
    expect(out.code).toContain(`bg-[#d9d9d9]" />\n      <p>One</p>`);
    expect(out.remap).toEqual({ [L(7)]: `${FILE}:8:6`, [L(8)]: `${FILE}:9:6` });
    const after = ok(run(APP, [{ ...edit, place: "after" }])).code;
    expect(after).toContain(`<p>One</p>\n      <div data-name="Rectangle"`);
  });

  it("opens up a self-closing element", () => {
    const code = `export const A = () => (\n  <div>\n    <section />\n  </div>\n);\n`;
    const out = ok(run(code, [{ ...insert("end"), loc: `${FILE}:3:4`, tag: "section" }]));
    expect(out.code).toContain(
      `    <section>\n      <div data-name="Rectangle" className="absolute left-10 w-50 bg-[#d9d9d9]" />\n    </section>`,
    );
    expect(out.created).toEqual({ r: `${FILE}:4:6` });
  });

  it("fills an empty element", () => {
    const code = `export const A = () => (\n  <div></div>\n);\n`;
    const out = ok(run(code, [{ ...insert("end"), loc: `${FILE}:2:2`, tag: "div" }])).code;
    expect(out).toContain(`  <div>\n    <div data-name="Rectangle"`);
    expect(out).toContain(`/>\n  </div>\n);`);
  });

  it("keeps children on the tag's line on it", () => {
    const code = `export const A = () => <p>Hello</p>;\n`;
    const node = { tag: "span", text: "x" };
    expect(
      ok(run(code, [{ ...insert("end", node), loc: `${FILE}:1:23`, tag: "p" }])).code,
    ).toContain(`<p>Hello<span>x</span></p>`);
  });

  it("prints children, text and attributes, and answers each ref", () => {
    const node: NewNode = {
      tag: "svg",
      ref: "s",
      attrs: { viewBox: "0 0 10 10" },
      children: [
        { tag: "path", ref: "p", attrs: { d: "M0 0L10 10" }, styles: { fill: "#123456" } },
      ],
    };
    const out = ok(run(APP, [insert("end", node)]));
    expect(out.code).toContain(
      `      <svg viewBox="0 0 10 10">\n        <path d="M0 0L10 10" className="fill-[#123456]" />\n      </svg>`,
    );
    expect(out.created).toEqual({ s: `${FILE}:9:6`, p: `${FILE}:10:8` });
  });

  it("applies a style edit and an insert on one element in one batch", () => {
    const relative = {
      kind: "style" as const,
      locs: [L(5, 4)],
      tag: "main",
      styles: { position: "relative" },
    };
    const out = ok(run(APP, [relative, insert("end")]));
    expect(out.code).toContain(`<main className="flex p-4 relative">`);
    expect(out.created.r).toBe(`${FILE}:9:6`);
  });

  it("refuses what can't take a child, or a sibling", () => {
    const img = `export const A = () => (\n  <div>\n    <img src="a.png" />\n  </div>\n);\n`;
    expect(refused(run(img, [{ ...insert("end"), loc: `${FILE}:3:4`, tag: "img" }]))).toMatchObject(
      { code: "invalid" },
    );
    const root = { ...insert("after"), loc: L(5, 4) };
    expect(refused(run(APP, [root]))).toMatchObject({ code: "unsupported-style" });
  });

  describe("beside an element a list renders", () => {
    const LIST = `const items = ["a"];\nexport const A = () => (\n  <main>\n    {items.map((n) => (\n      <div key={n}>{n}</div>\n    ))}\n  </main>\n);\n`;
    const item = { ...insert("before"), loc: `${FILE}:5:6`, tag: "div" };

    it("goes before the {…} slot that renders it", () => {
      const out = ok(run(LIST, [item]));
      expect(out.code).toContain(`bg-[#d9d9d9]" />\n    {items.map((n) => (`);
      expect(out.created).toEqual({ r: `${FILE}:4:4` });
    });

    it("goes after the slot, through a block body too", () => {
      const block = LIST.replace(
        "(n) => (\n      <div key={n}>{n}</div>\n    )",
        "(n) => {\n      return <div key={n}>{n}</div>;\n    }",
      );
      const out = ok(run(block, [{ ...item, place: "after", loc: `${FILE}:5:13` }])).code;
      expect(out).toContain(`})}\n    <div data-name="Rectangle"`);
    });

    it("refuses an element inside a spread attribute", () => {
      const line = "  <main>{<Widget {...{ header: <div /> }} />}</main>";
      const code = `export const A = () => (\n${line}\n);\n`;
      const inSpread = { ...item, loc: `${FILE}:2:${line.indexOf("<div")}` };
      expect(refused(run(code, [inSpread])).code).toBe("unsupported-style");
    });

    it("still refuses a component root and an element inside a prop", () => {
      const prop = `export const A = () => (\n  <main>\n    <X render={() => <div />} />\n  </main>\n);\n`;
      expect(refused(run(prop, [{ ...item, loc: `${FILE}:3:21` }])).code).toBe("unsupported-style");
    });
  });

  describe("values that would break out of the source", () => {
    const noClass = `export const A = () => (\n  <div>\n    <p>x</p>\n  </div>\n);\n`;

    const styleP = (styles: Record<string, string>) =>
      ok(run(noClass, [{ kind: "style", locs: [`${FILE}:3:4`], tag: "p", styles }])).code;
    const classOf = (code: string) => {
      const el = parseTsx(code, FILE).elements.get("3:4")!.node.openingElement;
      expect(el.attributes).toHaveLength(1);
      const attr = el.attributes[0]!;
      if (attr.type !== "JSXAttribute") throw new Error("expected an attribute");
      expect(attr.name.name).toBe("className");
      return attr.value;
    };

    it("keeps round 1's injection inside the one className attribute", () => {
      const code = styleP({ width: '10px"{...{onClick:()=>alert(1)}}data-x="' });
      expect(classOf(code)).toMatchObject({
        type: "StringLiteral",
        value: `w-[10px"{...{onClick:()=>alert(1)}}data-x="]`,
      });
    });

    it("picks the className quoting from the classes", () => {
      expect(styleP({ "font-family": "Bob's Font" })).toContain(
        `<p className="font-[family-name:Bob's_Font]">`,
      );
      expect(styleP({ "font-family": '"Inter"' })).toContain(
        `<p className='font-[family-name:"Inter"]'>`,
      );
      expect(styleP({ "font-family": `"Bob's Font"` })).toContain(
        'className={`font-[family-name:"Bob\'s_Font"]`}',
      );
    });

    it("escapes a template literal's own syntax", () => {
      const family = `"a'b\`c\\\${d}"`;
      const value = classOf(styleP({ "font-family": family }));
      if (value?.type !== "JSXExpressionContainer") throw new Error("expected {`…`}");
      expect(value.expression).toMatchObject({ type: "TemplateLiteral", expressions: [] });
      const cooked = (value.expression as t.TemplateLiteral).quasis[0]!.value.cooked;
      expect(cooked).toBe(`font-[family-name:${family}]`);
    });

    it('writes font-family: "Inter" on a new element', () => {
      const node = { tag: "div", styles: { "font-family": '"Inter"' } };
      expect(ok(run(APP, [insert("end", node)])).code).toContain(
        `className='font-[family-name:"Inter"]'`,
      );
    });

    it("prints name, attributes and text as data", () => {
      const evil = '"{...{onClick:alert}}x="';
      const node = { tag: "div", name: evil, attrs: { title: evil }, text: `{alert(1)}<b/>` };
      const out = ok(run(APP, [insert("end", node)])).code;
      expect(out).not.toMatch(/\{\.\.\.\{onClick:alert\}\}x=""/);
      expect(out).toContain(`data-name={${JSON.stringify(evil)}}`);
      expect(out).toContain(`title={${JSON.stringify(evil)}}`);
      expect(out).toContain(`>{${JSON.stringify("{alert(1)}<b/>")}}</div>`);
    });

    it("refuses a tag, a style name or a CSS value that isn't one", () => {
      for (const node of [
        { tag: "div onClick" },
        { tag: "div", styles: { "a: alert(1), b": "x" } },
        { tag: "div", styles: { color: "red; } .x { color: blue" } },
      ]) {
        for (const convention of conventions) {
          expect(refused(run(APP, [insert("end", node)], convention)).code).toBe("invalid");
        }
      }
    });

    it("refuses a CSS value that hides a rule behind a comment or isn't one value", () => {
      for (const value of [
        `red/*"*/; } .evil{color:blue} .tail{ color: green/*"*/`,
        "red /* note */",
        "red; color: blue",
        "}a{color:red",
        '"unclosed',
      ]) {
        const node = { tag: "div", styles: { color: value } };
        expect(refused(run(APP, [insert("end", node)], "inline"))).toEqual({
          reason: `A new element can't set the style color: ${value}`,
          code: "invalid",
        });
      }
    });

    it("lets punctuation through inside a string or url()", () => {
      for (const image of ['url("data:image/png;base64,AA==")', 'url("a)b;c.png")']) {
        const node = { tag: "div", styles: { "background-image": image } };
        expect(ok(run(APP, [insert("end", node)], "inline")).code).toContain(JSON.stringify(image));
      }
    });
  });

  it("refuses attributes a string can't set", () => {
    for (const name of ["onClick", "className", "style", "dangerouslySetInnerHTML"]) {
      const node = { tag: "div", attrs: { [name]: "x" } };
      expect(refused(run(APP, [insert("end", node)]))).toMatchObject({ code: "invalid" });
    }
  });

  it("refuses when the file changed or the element isn't what the edit says", () => {
    expect(refused(run(APP, [{ ...insert("end"), tag: "section" }])).code).toBe("stale");
  });

  it("refuses wrap and unwrap until they're built", () => {
    const edits = [
      { kind: "wrap" as const, locs: [L(7)], wrapper: { tag: "div" } },
      { kind: "unwrap" as const, loc: L(7), tag: "p" },
    ];
    for (const edit of edits) expect(refused(run(APP, [edit])).code).toBe("not-implemented");
  });
});
