import {
  type Inline,
  type OpenDesign,
  Refused,
  type SourceEdit,
  type Styling,
} from "@finite/protocol";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { rev } from "./files.ts";
import { readInline } from "./inline.ts";
import { parseTsx, tagName } from "./jsx.ts";
import { rewrite } from "./rewrite.ts";

const FILE = "src/App.tsx";
const LOC = `${FILE}:3:9`;

/** A module whose component returns `jsx` at line 3, column 9. */
const app = (jsx: string, head = "") => `${head}export function App() {
  const user = { name: "Ada" };
  return ${jsx};
}
`;

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

async function read(code: string) {
  const root = await mkdtemp(path.join(tmpdir(), "finite-inline-"));
  roots.push(root);
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, FILE), code);
  return readInline({ design: { root } } as unknown as OpenDesign, LOC);
}

function edit(code: string, content: Inline[], styling: Styling = "tailwind", extra = {}) {
  const tag = tagName(parseTsx(code, FILE).elements.get("3:9")!.node.openingElement.name);
  const edits: SourceEdit[] = [
    { kind: "inline", loc: LOC, tag, content, revs: { [FILE]: rev(code) } },
  ];
  const result = rewrite(code, FILE, edits, styling, { theme: {}, files: {}, ...extra });
  if (result instanceof Refused) throw new Error(`refused: ${result.message}`);
  return result;
}

const text = (t: string, marks: Extract<Inline, { t: "text" }>["marks"] = []): Inline => ({
  t: "text",
  text: t,
  marks,
});

describe("reading an element's children", () => {
  it("reads plain text as JSX renders it", async () => {
    const { content, keeps } = await read(
      app(`<p>
      Hello
      world
    </p>`),
    );
    expect(content).toEqual([text("Hello world")]);
    expect(keeps).toEqual([]);
  });

  it("counts string expressions as text, and keeps JSX spaces between pieces", async () => {
    const { content } = await read(
      app(`<p>Hi{" "}
      {"there"} <b>you</b></p>`),
    );
    expect(content).toEqual([text("Hi there "), text("you", [{ m: "b" }])]);
  });

  it("gives expressions, components and comments ids, and never their code as content", async () => {
    const { content, keeps } = await read(
      app(`<p>Hi {user.name}, <Badge kind="a" /> {/* note */}</p>`),
    );
    expect(content).toEqual([
      text("Hi "),
      { t: "atom", id: 0 },
      text(", "),
      { t: "atom", id: 1 },
      text(" "),
      { t: "atom", id: 2 },
    ]);
    expect(keeps).toEqual([
      { id: 0, kind: "expression", label: "{user.name}" },
      { id: 1, kind: "component", label: "<Badge>" },
      { id: 2, kind: "comment", label: "comment" },
    ]);
  });

  it("reads bare formatting tags and a plain link as marks, and a styled wrapper as kept", async () => {
    const { content, keeps } = await read(
      app(`<p><strong>a</strong><a href="/x">b</a><span className="c">d</span></p>`),
    );
    expect(content).toEqual([
      text("a", [{ m: "strong" }]),
      text("b", [{ m: "a", href: "/x" }]),
      text("d", [{ m: "keep", id: 0 }]),
    ]);
    expect(keeps).toEqual([{ id: 0, kind: "wrapper", label: "<span>", loc: `${FILE}:3:48` }]);
  });

  it("carries the marks around an expression inside a wrapper", async () => {
    const { content } = await read(app(`<p><strong>{user.name}</strong></p>`));
    expect(content).toEqual([{ t: "atom", id: 0, marks: [{ m: "strong" }] }]);
  });

  it("refuses a block child, and says what to do", async () => {
    await expect(read(app(`<div>Hi <p>there</p></div>`))).rejects.toMatchObject({
      code: "unsupported-style",
      message: expect.stringContaining("Select the <p> and edit the text inside it"),
    });
  });

  it("refuses what can't hold text or whose content is a prop", async () => {
    await expect(read(app(`<img src="a" />`))).rejects.toMatchObject({ code: "invalid" });
    await expect(
      read(app(`<p dangerouslySetInnerHTML={{ __html: "x" }} />`)),
    ).rejects.toMatchObject({ code: "unsupported-style" });
  });
});

describe("the page's own structure", () => {
  it.each(["html", "head", "body"])("refuses to read <%s> as text", async (tag) => {
    await expect(read(app(`<${tag}>{children}</${tag}>`))).rejects.toMatchObject({
      code: "invalid",
      message: expect.stringContaining(`<${tag}>`),
    });
  });

  it.each(["html", "body"])("refuses an inline edit of <%s>", (tag) => {
    expect(() => edit(app(`<${tag}><main>x</main></${tag}>`), [text("Wiped")])).toThrow(
      new RegExp(`refused: .*<${tag}>`),
    );
  });

  it("reads {children} and <Outlet /> as layout slots, not editable text", async () => {
    expect((await read(app(`<div>{children}</div>`))).keeps[0]?.kind).toBe("slot");
    expect((await read(app(`<div>{props.children}</div>`))).keeps[0]?.kind).toBe("slot");
    expect((await read(app(`<div><Outlet /></div>`))).keeps[0]?.kind).toBe("slot");
    expect((await read(app(`<p>{name}</p>`))).keeps[0]?.kind).toBe("expression");
    expect((await read(app(`<p>{stats.children}</p>`))).keeps[0]?.kind).toBe("expression");
    expect((await read(app(`<p>{this.props.children}</p>`))).keeps[0]?.kind).toBe("expression");
  });

  it("refuses an edit that would drop a layout slot, and keeps one that stays", () => {
    const code = app(`<div>{children}</div>`);
    expect(() => edit(code, [text("Bold word here")])).toThrow(/refused: .*\{children\}/);
    const kept = edit(code, [text("Above "), { t: "atom", id: 0 }]);
    expect(kept.code).toContain("<div>Above {children}</div>");
  });
});

describe("writing an element's children", () => {
  it("keeps every expression and component verbatim around changed text", async () => {
    const code = app(
      `<p>Hi {user.name}, <Badge kind={"a"} n={1 + 1} /> and {list.map((x) => <b key={x}>{x}</b>)}</p>`,
    );
    const { content } = await read(code);
    const next = content.map((item) =>
      item.t === "text" && item.text === "Hi " ? text("Hello ") : item,
    );
    expect(edit(code, next).code).toContain(
      `<p>Hello {user.name}, <Badge kind={"a"} n={1 + 1} /> and {list.map((x) => <b key={x}>{x}</b>)}</p>`,
    );
  });

  it("keeps an expression inside a mark, and text wrapped in a kept wrapper", async () => {
    const code = app(`<p>x <a className="l" href={u}>go {user.name}</a> y</p>`);
    const { content } = await read(code);
    const next = content.map((item) =>
      item.t === "text" && item.text === "go " ? { ...item, text: "visit " } : item,
    );
    expect(edit(code, next).code).toContain(
      `<p>x <a className="l" href={u}>visit {user.name}</a> y</p>`,
    );
  });

  it("drops a chip the person deleted, and refuses an id the source doesn't hold", async () => {
    const code = app(`<p>Hi {user.name}</p>`);
    expect(edit(code, [text("Hi")]).code).toContain(`<p>Hi</p>`);
    expect(() => edit(code, [{ t: "atom", id: 7 }])).toThrow(/no kept piece 7/);
    expect(() => edit(code, [text("a", [{ m: "keep", id: 0 }])])).toThrow(/no wrapper 0/);
  });

  it("escapes text so it can't become code, and an attribute so it can't escape", () => {
    const code = app(`<p>One</p>`);
    expect(edit(code, [text(`{alert(1)}<script/>`)]).code).toContain(
      `<p>{"{alert(1)}<script/>"}</p>`,
    );
    expect(edit(code, [text("x", [{ m: "a", href: `"><img onerror=a>` }])]).code).toContain(
      `<a href={"\\"><img onerror=a>"}>x</a>`,
    );
  });

  it("groups neighbouring runs that share a mark into one tag", () => {
    const strong = { m: "strong" } as const;
    const out = edit(app(`<p>One</p>`), [
      text("a"),
      text("b", [strong]),
      text("c", [strong, { m: "em" }]),
      text("d"),
    ]);
    expect(out.code).toContain(`<p>a<strong>b<em>c</em></strong>d</p>`);
  });

  it("writes line breaks and keeps a multi-line element's shape", () => {
    const code = app(`<p>
      One
    </p>`);
    const out = edit(code, [text("a"), { t: "br" }, text("b ")]);
    expect(out.code).toContain(`<p>
      a<br />{"b "}
    </p>`);
  });

  it("fills an empty and a self-closing element, and empties one", () => {
    expect(edit(app(`<p></p>`), [text("a")]).code).toContain(`<p>a</p>`);
    expect(edit(app(`<p />`), [text("a")]).code).toContain(`<p>a</p>`);
    expect(edit(app(`<p>a</p>`), []).code).toContain(`<p></p>`);
  });

  it("keeps a selected wrapper's loc through the remap", () => {
    const code = app(`<p>a <span className="c">b</span></p>`);
    const next = edit(code, [text("longer "), text("b", [{ m: "keep", id: 0 }])]);
    expect(next.code).toContain(`<p>longer <span className="c">b</span></p>`);
    expect(next.remap).toEqual({ [`${FILE}:3:14`]: `${FILE}:3:19` });
  });

  it("refuses a style that wouldn't stay one declaration", () => {
    expect(() =>
      edit(app(`<p>a</p>`), [text("b", [{ m: "span", styles: { color: "red; top: 0" } }])]),
    ).toThrow(/can't set the style/);
  });
});

describe("printing what the source already holds", () => {
  const keep = { m: "keep", id: 0 } as const;
  const strong = { m: "strong" } as const;

  it("prints a kept wrapper once, with other marks inside it, when formatting splits it", async () => {
    const code = app(`<p><strong><span id="anchor" title={track()}>abcd</span></strong></p>`);
    expect((await read(code)).content).toEqual([text("abcd", [strong, keep])]);
    expect(
      edit(code, [text("a", [strong, keep]), text("bc", [keep]), text("d", [strong, keep])]).code,
    ).toContain(
      `<p><span id="anchor" title={track()}><strong>a</strong>bc<strong>d</strong></span></p>`,
    );
  });

  it("refuses rather than repeat a kept wrapper's attributes when new content splits it", () => {
    const code = app(`<p><span id="anchor">abcd</span></p>`);
    expect(() => edit(code, [text("ab", [keep]), text("x"), text("cd", [keep])])).toThrow(
      /would repeat <span>/,
    );
  });

  it("keeps boundary spaces once when the text changes", () => {
    expect(edit(app(`<p> Hello </p>`), [text(" Hallo ")]).code).toContain(`<p> Hallo </p>`);
  });

  it.each([
    ["boundary spaces", `<p> Hello </p>`],
    ["a non-breaking space at the edge", `<p>\u00a0Hello</p>`],
    [
      "text across line breaks",
      `<p>
      Hello
      world
    </p>`,
    ],
    [
      "pieces across line breaks",
      `<p>Hi{" "}
      {"there"} <b>you</b> {user.name}</p>`,
    ],
  ])("writes nothing for an unchanged read: %s", async (_name, jsx) => {
    const code = app(jsx);
    const result = edit(code, (await read(code)).content);
    expect(result.code).toBe(code);
    expect(result.remap).toEqual({});
  });

  it.each([
    [`<p><span id="anchor">{""}</span> hello</p>`, `<span id="anchor">{""}</span>`],
    [`<p><span id="anchor"></span> hello</p>`, `<span id="anchor"></span>`],
    [
      `<p><a id="anchor" href="/x">{/* none */}</a> hello</p>`,
      `<a id="anchor" href="/x">{/* none */}</a>`,
    ],
  ])("reprints a wrapper with no visible text: %s", async (jsx, kept) => {
    const code = app(jsx);
    const next = (await read(code)).content.map((item) =>
      item.t === "text" ? { ...item, text: item.text.replace("hello", "hallo") } : item,
    );
    expect(edit(code, next).code).toContain(`<p>${kept} hallo</p>`);
  });

  it.each([
    ["a tab", `{"a\\tb"} hello`, "a\tb hallo", `{"a\\tb hallo"}`],
    ["a carriage return", `{"a\\rb"} hello`, "a\rb hallo", `{"a\\rb hallo"}`],
  ])("keeps %s in a string expression", async (_name, children, value, printed) => {
    const code = app(`<pre>${children}</pre>`);
    expect((await read(code)).content).toEqual([text(value.replace("hallo", "hello"))]);
    expect(edit(code, [text(value)]).code).toContain(`<pre>${printed}</pre>`);
  });
});

describe("a colored run in each styling convention", () => {
  const styles = { color: "#ff0000", "font-size": "20px" };
  const colored = [text("Hi "), text("there", [{ m: "span", styles, ref: "s" }])];

  it("is a Tailwind class", () => {
    const out = edit(app(`<p>One</p>`), colored);
    expect(out.code).toContain(`<p>Hi <span className="text-[#ff0000] text-xl">there</span></p>`);
    expect(out.created.s).toBe(`${FILE}:3:15`);
  });

  it("is inline in an inline-styled design", () => {
    expect(edit(app(`<p>One</p>`), colored, "inline").code).toContain(
      `<p>Hi <span style={{ color: "#ff0000", fontSize: "20px" }}>there</span></p>`,
    );
  });

  it("is a new rule in a file's one CSS module", () => {
    const head = `import css from "./App.module.css";\n`;
    const code = `${head}export function App() {\n  return <p>One</p>;\n}\n`;
    const key = "src/App.module.css";
    const edits: SourceEdit[] = [
      {
        kind: "inline",
        loc: `${FILE}:3:9`,
        tag: "p",
        content: colored,
        revs: { [FILE]: rev(code) },
      },
    ];
    const out = rewrite(code, FILE, edits, "css-modules", {
      theme: {},
      files: { [key]: ".card { color: red; }\n" },
    });
    if (out instanceof Refused) throw out;
    expect(out.code).toContain(`<p>Hi <span className={css.span}>there</span></p>`);
    expect(out.files[key]).toMatch(/\.span\s*\{[^}]*color: #ff0000;[^}]*font-size: 20px/);
  });

  it("is inline when a CSS-modules file has no sheet", () => {
    expect(edit(app(`<p>One</p>`), colored, "css-modules").code).toContain(
      `<span style={{ color: "#ff0000", fontSize: "20px" }}>there</span>`,
    );
  });

  it("is a stylex.create entry", () => {
    const head = `import * as stylex from "@stylexjs/stylex";\n`;
    const code = `${head}export function App() {\n  return <p>One</p>;\n}\n`;
    const edits: SourceEdit[] = [
      {
        kind: "inline",
        loc: `${FILE}:3:9`,
        tag: "p",
        content: colored,
        revs: { [FILE]: rev(code) },
      },
    ];
    const out = rewrite(code, FILE, edits, "stylex", { theme: {}, files: {} });
    if (out instanceof Refused) throw out;
    expect(out.code).toContain(`<span {...stylex.props(styles.span)}>there</span>`);
    expect(out.code).toMatch(/span: \{[^}]*color: "#ff0000"[^}]*fontSize: "20px"/);
  });
});
