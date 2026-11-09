import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type Actor,
  type Canvas,
  type Design,
  type OpenDesign,
  Refused,
  type SourceEdit,
  type Styling,
} from "@finite/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { rev } from "./files.ts";
import { createSourceEditor } from "./index.ts";
import { parseTsx } from "./jsx.ts";
import { rewrite, type RewriteContext } from "./rewrite.ts";

const FILE = "src/App.tsx";
const APP = `import styles from "./App.module.css";

export function App() {
  return (
    <main className="p-4">
      <h1 className="a">Hello</h1>
      <p>One</p>
      <span style={{ color: "red" }}>Two</span>
    </main>
  );
}
`;
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
  return result;
}

const flex = { tag: "div", ref: "w", name: "Auto layout", styles: { display: "flex", gap: "8px" } };
const wrapOf = (locs: string[], wrapper = flex): Edit => ({ kind: "wrap", locs, wrapper });

describe("wrap", () => {
  it("puts siblings in a new element, indented, and answers where everything went", () => {
    const out = ok(run(APP, [wrapOf([L(7), L(8)])]));
    expect(out.code).toBe(`import styles from "./App.module.css";

export function App() {
  return (
    <main className="p-4">
      <h1 className="a">Hello</h1>
      <div data-name="Auto layout" className="flex gap-2">
        <p>One</p>
        <span style={{ color: "red" }}>Two</span>
      </div>
    </main>
  );
}
`);
    expect(out.created.w).toBe(L(7));
    expect(out.remap).toEqual({ [L(7)]: L(8, 8), [L(8)]: L(9, 8) });
  });

  it("writes the wrapper in every convention", () => {
    const sheet = "src/App.module.css";
    const inline = ok(run(APP, [wrapOf([L(7)])], "inline")).code;
    expect(inline).toContain(
      `<div data-name="Auto layout" style={{ display: "flex", gap: "8px" }}>`,
    );
    const modules = ok(
      run(APP, [wrapOf([L(7)])], "css-modules", {
        files: { [sheet]: ".title { color: red; }\n" },
      }),
    );
    expect(modules.code).toContain(`<div data-name="Auto layout" className={styles.autoLayout}>`);
    expect(modules.files[sheet]).toMatch(/\.autoLayout \{[^}]*display: flex/s);
    const stylex = ok(run(APP, [wrapOf([L(7)])], "stylex")).code;
    expect(stylex).toMatch(
      /<div data-name="Auto layout" \{\.\.\.stylex\.props\(styles\d*\.div\)\}>/,
    );
    expect(stylex).toMatch(/display: "flex"/);
  });

  it("orders the children as `locs` says", () => {
    const out = ok(run(APP, [wrapOf([L(8), L(7)])]));
    expect(out.code).toContain(`<span style={{ color: "red" }}>Two</span>
        <p>One</p>
      </div>`);
  });

  it("gathers a child that isn't next to the others", () => {
    const out = ok(run(APP, [wrapOf([L(6), L(8)])]));
    expect(out.code).toContain(`<div data-name="Auto layout" className="flex gap-2">
        <h1 className="a">Hello</h1>
        <span style={{ color: "red" }}>Two</span>
      </div>
      <p>One</p>`);
    expect(parseTsx(out.code, FILE).elements.size).toBe(5);
  });

  it("follows a later edit in the same batch to the moved children", () => {
    const out = ok(
      run(APP, [
        wrapOf([L(7), L(8)]),
        { kind: "style", locs: [L(7)], tag: "p", styles: { width: "10px" } },
      ]),
    );
    expect(out.code).toContain(`<p className="w-2.5">One</p>`);
  });

  it("stays on one line when the children do", () => {
    const code = `export const A = () => <main><a href="x" /><b>y</b></main>;\n`;
    const a = `${FILE}:1:29`;
    const b = `${FILE}:1:43`;
    expect(ok(run(code, [wrapOf([a, b])], "inline")).code).toBe(
      `export const A = () => <main><div data-name="Auto layout" style={{ display: "flex", gap: "8px" }}><a href="x" /><b>y</b></div></main>;\n`,
    );
  });

  it("leaves multi-line strings alone while indenting", () => {
    const code = `export const A = () => (
  <main>
    <p title={\`one
two\`}>
      x
    </p>
  </main>
);
`;
    const out = ok(run(code, [wrapOf([`${FILE}:3:4`])], "inline")).code;
    expect(out).toContain("title={`one\ntwo`}>\n        x\n      </p>\n    </div>");
  });

  it("refuses elements that aren't siblings, or from two files", () => {
    const code = `export const A = () => (
  <main>
    <p />
    <div>
      <b />
    </div>
  </main>
);
`;
    expect(refused(run(code, [wrapOf([`${FILE}:3:4`, `${FILE}:5:6`])])).message).toMatch(
      /side by side/,
    );
    expect(refused(run(APP, [wrapOf([L(7), "src/B.tsx:1:1"])])).message).toMatch(/different files/);
  });

  it("refuses a component's root and an element inside code", () => {
    const code = `export const A = (xs: string[]) => <ul>{xs.map((x) => <li key={x}>{x}</li>)}</ul>;\n`;
    for (const tag of ["<li", "<ul"]) {
      const loc = `${FILE}:1:${code.indexOf(tag)}`;
      expect(refused(run(code, [wrapOf([loc])])).code).toBe("unsupported-style");
    }
  });

  it("refuses a stale rev and a tag the element no longer has", () => {
    const stale = rewrite(
      APP,
      FILE,
      [{ kind: "wrap", locs: [L(7)], wrapper: flex, revs: { [FILE]: "00000000" } }],
      "tailwind",
      { theme: {}, files: {} },
    );
    expect(stale).toBeInstanceOf(Refused);
    expect((stale as Refused).code).toBe("stale");
    expect(refused(run(APP, [{ kind: "unwrap", loc: L(7), tag: "div" }])).code).toBe("stale");
  });
});

describe("unwrap", () => {
  const WRAPPED = `export const A = () => (
  <main>
    <div data-name="Auto layout" className="flex">
      <p>One</p>
      <span>Two</span>
    </div>
    <b />
  </main>
);
`;
  const at = (line: number, col: number) => `${FILE}:${line}:${col}`;

  it("replaces the element with its children, one level out", () => {
    const out = ok(run(WRAPPED, [{ kind: "unwrap", loc: at(3, 4), tag: "div" }]));
    expect(out.code).toBe(`export const A = () => (
  <main>
    <p>One</p>
    <span>Two</span>
    <b />
  </main>
);
`);
    expect(out.remap).toEqual({
      [at(4, 6)]: at(3, 4),
      [at(5, 6)]: at(4, 4),
      [at(7, 4)]: at(5, 4),
    });
  });

  it("keeps spaces JSX shows, and drops indentation", () => {
    const code = `export const A = () => <p>Hello<span> <b>world</b> </span>again</p>;\n`;
    const loc = `${FILE}:1:${code.indexOf("<span")}`;
    expect(ok(run(code, [{ kind: "unwrap", loc, tag: "span" }])).code).toBe(
      `export const A = () => <p>Hello <b>world</b> again</p>;\n`,
    );
  });

  it("restyles the children in the same batch", () => {
    const out = ok(
      run(WRAPPED, [
        { kind: "unwrap", loc: at(3, 4), tag: "div" },
        { kind: "style", locs: [at(4, 6)], tag: "p", styles: { position: "absolute" } },
      ]),
    );
    expect(out.code).toContain(`<p className="absolute">One</p>`);
  });

  it("undoes a wrap", () => {
    const wrapped = ok(run(APP, [wrapOf([L(7), L(8)])])).code;
    expect(ok(run(wrapped, [{ kind: "unwrap", loc: L(7), tag: "div" }])).code).toBe(APP);
  });

  it("keeps a root that has one element to return", () => {
    const code = `export const A = () => (\n  <div>\n    <p>x</p>\n  </div>\n);\n`;
    expect(ok(run(code, [{ kind: "unwrap", loc: `${FILE}:2:2`, tag: "div" }])).code).toBe(
      `export const A = () => (\n  <p>x</p>\n);\n`,
    );
  });

  it("refuses a root with several children, and a list item's key", () => {
    const two = `export const A = () => (\n  <div>\n    <p />\n    <b />\n  </div>\n);\n`;
    expect(refused(run(two, [{ kind: "unwrap", loc: `${FILE}:2:2`, tag: "div" }])).message).toMatch(
      /more than one element/,
    );
    const keyed = `export const A = (xs: string[]) => <ul>{xs.map((x) => <li key={x}><b /></li>)}</ul>;\n`;
    const li = `${FILE}:1:${keyed.indexOf("<li")}`;
    expect(refused(run(keyed, [{ kind: "unwrap", loc: li, tag: "li" }])).message).toMatch(/key/);
  });

  it("removes an empty element and its line", () => {
    const code = `export const A = () => (\n  <main>\n    <div className="flex" />\n    <p />\n  </main>\n);\n`;
    expect(ok(run(code, [{ kind: "unwrap", loc: `${FILE}:3:4`, tag: "div" }])).code).toBe(
      `export const A = () => (\n  <main>\n    <p />\n  </main>\n);\n`,
    );
  });
});

describe("wrap through the SourceEditor", () => {
  let root: string;
  const ana: Actor = { kind: "person", id: "ana", name: "Ana" };
  const bo: Actor = { kind: "person", id: "bo", name: "Bo" };
  const page = { id: "p1", kind: "page" } as Canvas;
  const design = (): OpenDesign =>
    ({
      design: {
        id: "d1",
        name: "D",
        root,
        origin: "connected",
        router: "react-router",
        styling: "inline",
        css: [],
        brandDir: "src/assets/brand",
      } as Design,
    }) as OpenDesign;
  const get = () => readFile(path.join(root, FILE), "utf8");
  const code = `export const A = () => (
  <main>
    <p>One</p>
    <b>Two</b>
    <hr />
    <i>Three</i>
  </main>
);
`;

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "finite-wrap-"));
    await mkdir(path.join(root, "src"));
  });
  afterAll(() => rm(root, { recursive: true, force: true }));

  it("undoes and redoes a wrap around another actor's edit to the same file", async () => {
    await writeFile(path.join(root, FILE), code);
    const source = createSourceEditor();
    const open = design();
    const result = await source.apply(
      open,
      [
        {
          kind: "wrap",
          locs: [`${FILE}:3:4`, `${FILE}:4:4`],
          wrapper: { tag: "div", ref: "w", name: "Auto layout", styles: { display: "flex" } },
          revs: { [FILE]: rev(code) },
        },
      ],
      ana,
      page,
    );
    expect(result.created.w).toBe(`${FILE}:3:4`);
    const wrapped = await get();
    expect(wrapped).toContain(`<p>One</p>\n      <b>Two</b>\n    </div>`);

    await source.apply(
      open,
      [
        {
          kind: "inline",
          loc: `${FILE}:8:4`,
          tag: "i",
          content: [{ t: "text", text: "Changed", marks: [] }],
          revs: { [FILE]: rev(wrapped) },
        },
      ],
      bo,
      page,
    );
    await source.undo(open, ana);
    const undone = await get();
    expect(undone).not.toContain("Auto layout");
    expect(undone).toContain("<p>One</p>\n    <b>Two</b>\n    <hr />\n    <i>Changed</i>");
    await source.redo(open, ana);
    expect(await get()).toContain(`data-name="Auto layout"`);
    expect(await get()).toContain("<i>Changed</i>");
  });
});

describe("wrap on a prototype", () => {
  it("refuses a production file, and takes one under .finite/", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "finite-wrap-proto-"));
    try {
      const board = ".finite/boards/c1/A.tsx";
      const code = `export const A = () => (\n  <main>\n    <p />\n  </main>\n);\n`;
      await mkdir(path.join(root, "src"), { recursive: true });
      await mkdir(path.join(root, ".finite/boards/c1"), { recursive: true });
      await writeFile(path.join(root, "src/B.tsx"), code);
      await writeFile(path.join(root, board), code);
      const design = {
        id: "d1",
        name: "D",
        root,
        origin: "connected",
        router: "react-router",
        styling: "inline",
        css: [],
        brandDir: "src/assets/brand",
      } as Design;
      const open = { design } as OpenDesign;
      const by: Actor = { kind: "person", id: "ana", name: "Ana" };
      const proto = { id: "c1", kind: "prototype" } as Canvas;
      const source = createSourceEditor();
      const edit = (file: string): SourceEdit => ({
        kind: "wrap",
        locs: [`${file}:3:4`],
        wrapper: { tag: "div", styles: { display: "flex" } },
        revs: { [file]: rev(code) },
      });
      await expect(source.apply(open, [edit("src/B.tsx")], by, proto)).rejects.toMatchObject({
        code: "outside-prototype",
      });
      await source.apply(open, [edit(board)], by, proto);
      expect(await readFile(path.join(root, board), "utf8")).toContain(`display: "flex"`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
