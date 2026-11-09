import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Actor, Canvas, Design, OpenDesign, SourceEdit, Styling } from "@finite/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { createFileLocks, lockKey, rev } from "./files.ts";
import { createSourceEditor } from "./index.ts";

const ana: Actor = { kind: "person", id: "ana", name: "Ana" };
const bo: Actor = { kind: "person", id: "bo", name: "Bo" };
const page = { id: "p1", kind: "page" } as Canvas;
const proto = { id: "c1", kind: "prototype" } as Canvas;

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "finite-source-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function design(styling: Styling = "tailwind"): Design {
  return {
    id: "d1",
    name: "D",
    root,
    origin: "connected",
    router: "react-router",
    styling,
    css: ["src/index.css"],
    brandDir: "src/assets/brand",
  };
}
const open = (d: Design) => ({ design: d }) as OpenDesign;

async function put(file: string, contents: string) {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), contents);
}
const get = (file: string) => readFile(path.join(root, file), "utf8");

const APP = `import { Card } from "./Card";

export function App() {
  return (
    <main className="flex p-4">
      <h1 className="text-sm">Hello</h1>
      <p>One</p>
    </main>
  );
}
`;

type Edit = SourceEdit extends infer E ? (E extends SourceEdit ? Omit<E, "revs"> : never) : never;

async function edit(file: string, e: Edit): Promise<SourceEdit> {
  return { ...e, revs: { [file]: rev(await get(file)) } } as SourceEdit;
}

describe("SourceEditor.apply", () => {
  it("writes the rewritten file and returns the remap", async () => {
    await put("src/App.tsx", APP);
    const source = createSourceEditor();
    const result = await source.apply(
      open(design()),
      [await edit("src/App.tsx", { kind: "duplicate", locs: ["src/App.tsx:6:6"] })],
      ana,
      page,
    );
    expect(result).toEqual({
      ok: true,
      remap: { "src/App.tsx:7:6": "src/App.tsx:8:6" },
      created: {},
    });
    expect(await get("src/App.tsx")).toContain(
      `<h1 className="text-sm">Hello</h1>\n      <h1 className="text-sm">Hello</h1>`,
    );
  });

  it("matches the project's theme when it writes classes", async () => {
    await put("src/App.tsx", APP);
    await put("src/index.css", `@import "tailwindcss";\n@theme { --color-brand: #95ced7; }\n`);
    const source = createSourceEditor();
    await source.apply(
      open(design()),
      [
        await edit("src/App.tsx", {
          kind: "style",
          locs: ["src/App.tsx:7:6"],
          tag: "p",
          styles: { color: "#95ced7" },
        }),
      ],
      ana,
      page,
    );
    expect(await get("src/App.tsx")).toContain(`<p className="text-brand">One</p>`);
  });

  it("matches a Tailwind v3 config's theme and refuses new tokens there", async () => {
    await put("src/App.tsx", APP);
    await put("src/index.css", `@tailwind base;\n:root { --ink: #111; }\n`);
    // A stand-in tailwindcss v3: the child loads the config with require and resolves it here.
    await put(
      "node_modules/tailwindcss/package.json",
      `{ "name": "tailwindcss", "version": "3.4.19" }`,
    );
    await put("node_modules/tailwindcss/resolveConfig.js", `module.exports = (c) => c;\n`);
    await put(
      "tailwind.config.cjs",
      `module.exports = { theme: { colors: { brand: { DEFAULT: "#95ced7" } }, borderRadius: { DEFAULT: "4px" } } };\n`,
    );
    const source = createSourceEditor();
    await source.apply(
      open(design()),
      [
        await edit("src/App.tsx", {
          kind: "style",
          locs: ["src/App.tsx:7:6"],
          tag: "p",
          styles: { color: "#95ced7", borderRadius: "4px", padding: "52px" },
        }),
      ],
      ana,
      page,
    );
    expect(await get("src/App.tsx")).toContain(
      `<p className="text-brand rounded p-[52px]">One</p>`,
    );
    await expect(
      source.setToken(design(), { name: "--color-new", mode: "light", value: "red" }),
    ).rejects.toThrow("theme.extend in tailwind.config.cjs");
    await source.setToken(design(), { name: "--ink", mode: "light", value: "#222" });
    expect(await get("src/index.css")).toContain("--ink: #222");
  });

  it("finds a Tailwind v3 config through the sheet's @config when the root has none", async () => {
    await put("src/App.tsx", APP);
    await put("src/index.css", `@config "../config/tw.cjs";\n@tailwind base;\n`);
    await put(
      "node_modules/tailwindcss/package.json",
      `{ "name": "tailwindcss", "version": "3.4.19" }`,
    );
    await put("node_modules/tailwindcss/resolveConfig.js", `module.exports = (c) => c;\n`);
    await put("config/tw.cjs", `module.exports = { theme: { padding: { card: "312px" } } };\n`);
    const source = createSourceEditor();
    const styles = (padding: string) =>
      edit("src/App.tsx", {
        kind: "style",
        locs: ["src/App.tsx:7:6"],
        tag: "p",
        styles: { padding },
      });
    await source.apply(open(design()), [await styles("312px")], ana, page);
    expect(await get("src/App.tsx")).toContain(`<p className="p-card">One</p>`);
    await source.apply(open(design()), [await styles("52px")], ana, page);
    expect(await get("src/App.tsx")).toContain(`<p className="p-[52px]">One</p>`);
  });

  it("refuses a stale rev", async () => {
    await put("src/App.tsx", APP);
    const source = createSourceEditor();
    const e = await edit("src/App.tsx", { kind: "remove", locs: ["src/App.tsx:7:6"] });
    await put("src/App.tsx", `// changed\n${APP}`);
    await expect(source.apply(open(design()), [e], ana, page)).rejects.toMatchObject({
      message: "The file changed; try again",
      code: "stale",
    });
  });

  it("serializes writes to a file: the second of two edits made against the same rev is stale", async () => {
    await put("src/App.tsx", APP);
    const source = createSourceEditor();
    const a = await edit("src/App.tsx", {
      kind: "text",
      loc: "src/App.tsx:7:6",
      tag: "p",
      text: "A",
    });
    const b = await edit("src/App.tsx", {
      kind: "text",
      loc: "src/App.tsx:7:6",
      tag: "p",
      text: "B",
    });
    const results = await Promise.allSettled([
      source.apply(open(design()), [a], ana, page),
      source.apply(open(design()), [b], bo, page),
    ]);
    // Whichever takes the lock first wins; the other is stale.
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    const winner = results[0]!.status === "fulfilled" ? "A" : "B";
    expect(await get("src/App.tsx")).toContain(`<p>${winner}</p>`);
  });

  it("waits for a writer holding the file's lock, then refuses the edit as stale", async () => {
    await put("src/App.tsx", APP);
    const locks = createFileLocks();
    const source = createSourceEditor({ locks });
    const e = await edit("src/App.tsx", {
      kind: "text",
      loc: "src/App.tsx:7:6",
      tag: "p",
      text: "Human",
    });
    // The agent's Write holds the lock from its PreToolUse hook to its PostToolUse hook.
    const release = await locks.acquire([path.join(root, "src/App.tsx")]);
    let settled = false;
    const applying = source.apply(open(design()), [e], ana, page).finally(() => (settled = true));
    applying.catch(() => {});
    await new Promise((r) => setTimeout(r, 30));
    expect(settled).toBe(false);
    const agentSave = APP.replace("<p>One</p>", "<p>Agent</p>");
    await put("src/App.tsx", agentSave);
    release();
    await expect(applying).rejects.toMatchObject({ code: "stale" });
    expect(await get("src/App.tsx")).toBe(agentSave);
  });

  it("locks a file under one key however it's spelled: through a symlink, or not made yet", async () => {
    await put(".finite/real/A.tsx", APP);
    await symlink(path.join(root, ".finite/real"), path.join(root, ".finite/alias"));
    const real = lockKey(path.join(root, ".finite/real/A.tsx"));
    expect(lockKey(path.join(root, ".finite/alias/A.tsx"))).toBe(real);
    expect(lockKey(path.join(root, ".finite/alias/new/B.tsx"))).toBe(
      lockKey(path.join(root, ".finite/real/new/B.tsx")),
    );
    expect(lockKey(`${path.join(root, ".finite/alias")}${path.sep}`)).toBe(
      `${lockKey(path.join(root, ".finite/real"))}${path.sep}`,
    );

    // An agent's Write through the link holds the lock a SourceEditor edit of the real path takes.
    const locks = createFileLocks();
    const source = createSourceEditor({ locks });
    const e = await edit(".finite/real/A.tsx", {
      kind: "text",
      loc: ".finite/real/A.tsx:7:6",
      tag: "p",
      text: "Human",
    });
    const release = await locks.acquire([path.join(root, ".finite/alias/A.tsx")]);
    let settled = false;
    const applying = source.apply(open(design()), [e], ana, proto).finally(() => (settled = true));
    applying.catch(() => {});
    await new Promise((r) => setTimeout(r, 30));
    expect(settled).toBe(false);
    release();
    await applying;
    expect(await get(".finite/real/A.tsx")).toContain("<p>Human</p>");
  });

  it("refuses production files on a prototype canvas and edits board files", async () => {
    await put("src/App.tsx", APP);
    await put(".finite/boards/c1/Board.tsx", APP);
    const source = createSourceEditor();
    await expect(
      source.apply(
        open(design()),
        [await edit("src/App.tsx", { kind: "remove", locs: ["src/App.tsx:7:6"] })],
        ana,
        proto,
      ),
    ).rejects.toMatchObject({
      code: "outside-prototype",
      message: "src/App.tsx is production code. Copy App.tsx into this prototype to edit it here.",
    });
    const f = ".finite/boards/c1/Board.tsx";
    await source.apply(
      open(design()),
      [await edit(f, { kind: "remove", locs: [`${f}:7:6`] })],
      ana,
      proto,
    );
    expect(await get(f)).not.toContain("<p>One</p>");
  });

  it("refuses a production file spelled through .finite/.. on a prototype canvas", async () => {
    await put("src/App.tsx", APP);
    const sneaky = ".finite/../src/App.tsx";
    const source = createSourceEditor();
    await expect(
      source.apply(
        open(design()),
        [
          {
            kind: "remove",
            locs: [`${sneaky}:7:6`],
            revs: { [sneaky]: rev(APP) },
          } as SourceEdit,
        ],
        ana,
        proto,
      ),
    ).rejects.toMatchObject({ code: "outside-prototype" });
    expect(await get("src/App.tsx")).toBe(APP);
  });

  it("edits the imported module stylesheet for css-modules", async () => {
    await put(
      "src/Card.tsx",
      `import s from "./Card.module.css";\nexport const Card = () => <div className={s.card}>x</div>;\n`,
    );
    await put("src/Card.module.css", `.card {\n  color: red;\n}\n`);
    const source = createSourceEditor();
    const d = design("css-modules");
    await source.apply(
      open(d),
      [
        await edit("src/Card.tsx", {
          kind: "style",
          locs: ["src/Card.tsx:2:26"],
          tag: "div",
          styles: { color: "blue" },
        }),
      ],
      ana,
      page,
    );
    expect(await get("src/Card.module.css")).toBe(`.card {\n  color: blue;\n}\n`);
    await source.undo(open(d), ana);
    expect(await get("src/Card.module.css")).toBe(`.card {\n  color: red;\n}\n`);
  });
});

describe("SourceEditor inserting an element", () => {
  const node = { tag: "div", ref: "n", name: "Box", styles: { width: "10px" } };

  it("adds a CSS-module rule in the same edit, and undo takes back both files", async () => {
    const d = design("css-modules");
    const code = `import s from "./Card.module.css";\nexport const Card = () => <main className={s.card}>x</main>;\n`;
    const sheet = `.card {\n  color: red;\n}\n`;
    await put("src/Card.tsx", code);
    await put("src/Card.module.css", sheet);
    const source = createSourceEditor();
    const result = await source.apply(
      open(d),
      [
        await edit("src/Card.tsx", {
          kind: "insert",
          loc: "src/Card.tsx:2:26",
          tag: "main",
          place: "end",
          node,
        }),
      ],
      ana,
      page,
    );
    expect(result.created.n).toMatch(/^src\/Card\.tsx:\d+:\d+$/);
    expect(await get("src/Card.tsx")).toContain("className={s.box}");
    expect(await get("src/Card.module.css")).toContain(".box {\n  width: 10px;\n}");
    await source.undo(open(d), ana);
    expect(await get("src/Card.tsx")).toBe(code);
    expect(await get("src/Card.module.css")).toBe(sheet);
    await source.redo(open(d), ana);
    expect(await get("src/Card.module.css")).toContain(".box {");
  });

  it("undoes and redoes around another actor's edit to the same file", async () => {
    await put("src/App.tsx", APP);
    const d = design();
    const source = createSourceEditor();
    await source.apply(
      open(d),
      [
        await edit("src/App.tsx", {
          kind: "insert",
          loc: "src/App.tsx:5:4",
          tag: "main",
          place: "end",
          node,
        }),
      ],
      ana,
      page,
    );
    expect(await get("src/App.tsx")).toContain(`data-name="Box"`);
    await source.apply(
      open(d),
      [await edit("src/App.tsx", { kind: "text", loc: "src/App.tsx:6:6", tag: "h1", text: "Hi" })],
      bo,
      page,
    );
    await source.undo(open(d), ana);
    const undone = await get("src/App.tsx");
    expect(undone).not.toContain(`data-name="Box"`);
    expect(undone).toContain(">Hi</h1>");
    await source.redo(open(d), ana);
    const redone = await get("src/App.tsx");
    expect(redone).toContain(`data-name="Box"`);
    expect(redone).toContain(">Hi</h1>");
    await source.undo(open(d), bo);
    expect(await get("src/App.tsx")).toContain(">Hello</h1>");
    expect(await get("src/App.tsx")).toContain(`data-name="Box"`);
  });

  it("refuses inside a prototype when the file is production", async () => {
    await put("src/App.tsx", APP);
    const source = createSourceEditor();
    await expect(
      source.apply(
        open(design()),
        [
          await edit("src/App.tsx", {
            kind: "insert",
            loc: "src/App.tsx:5:4",
            tag: "main",
            place: "end",
            node,
          }),
        ],
        ana,
        { ...page, kind: "prototype" },
      ),
    ).rejects.toMatchObject({ code: "outside-prototype" });
  });

  it("refuses the parts that aren't built yet, saying so", async () => {
    const source = createSourceEditor();
    const o = open(design());
    for (const call of [
      source.inline(o, "src/App.tsx:5:4"),
      source.addAsset(o, "a.png"),
      source.exportSlice(o, { canvasId: "c", sliceId: "s" }),
      source.draw(
        o,
        {
          canvasId: "c",
          box: { x: 0, y: 0, width: 1, height: 1 },
          name: "Box",
          node: { tag: "div" },
        },
        ana,
      ),
    ]) {
      await expect(call).rejects.toMatchObject({ code: "not-implemented" });
    }
  });
});

describe("SourceEditor with Sass and Less modules", () => {
  const CARD = (ext: string) =>
    `import s from "./Card.module.${ext}";\nexport const Card = () => (\n  <div className={s.card}>\n    <h2 className={s.title}>x</h2>\n  </div>\n);\n`;
  const SCSS = `$ink: #111;\n\n// The card.\n.card {\n  color: $ink;\n  &:hover {\n    color: red;\n  }\n}\n\n.title {\n  font-size: 12px; // small\n}\n`;
  const styleCard = (
    styles: Record<string, string | null>,
    loc = "src/Card.tsx:3:2",
    tag = "div",
  ) => edit("src/Card.tsx", { kind: "style", locs: [loc], tag, styles });
  const d = () => design("css-modules");

  it("edits a .module.scss rule, and undo and redo survive another actor's edit in the same sheet", async () => {
    await put("src/Card.tsx", CARD("scss"));
    await put("src/Card.module.scss", SCSS);
    const source = createSourceEditor();
    await source.apply(open(d()), [await styleCard({ color: "blue" })], ana, page);
    const anaEdit = SCSS.replace("color: $ink;", "color: blue;");
    expect(await get("src/Card.module.scss")).toBe(anaEdit);

    await source.apply(
      open(d()),
      [await styleCard({ fontSize: "20px" }, "src/Card.tsx:4:4", "h2")],
      bo,
      page,
    );
    const both = anaEdit.replace("font-size: 12px; // small", "font-size: 20px; // small");
    expect(await get("src/Card.module.scss")).toBe(both);

    await source.undo(open(d()), ana);
    expect(await get("src/Card.module.scss")).toBe(SCSS.replace("12px", "20px"));
    await source.redo(open(d()), ana);
    expect(await get("src/Card.module.scss")).toBe(both);
    await source.undo(open(d()), bo);
    expect(await get("src/Card.module.scss")).toBe(anaEdit);
  });

  it("edits a .module.less rule", async () => {
    await put("src/Card.tsx", CARD("less"));
    const less = `@ink: #111;\n.bold() {\n  font-weight: bold;\n}\n.card {\n  .bold();\n  color: @ink; // ink\n}\n`;
    await put("src/Card.module.less", less);
    const source = createSourceEditor();
    await source.apply(open(d()), [await styleCard({ color: "blue", margin: "4px" })], ana, page);
    expect(await get("src/Card.module.less")).toBe(
      less.replace("color: @ink; // ink\n", "color: blue; // ink\n  margin: 4px;\n"),
    );
    await source.undo(open(d()), ana);
    expect(await get("src/Card.module.less")).toBe(less);
  });

  it("refuses a class that only exists nested, and leaves the sheet alone", async () => {
    await put("src/Card.tsx", CARD("scss"));
    const nested = `.list {\n  .card {\n    color: red;\n  }\n}\n`;
    await put("src/Card.module.scss", nested);
    await expect(
      createSourceEditor().apply(open(d()), [await styleCard({ color: "blue" })], ana, page),
    ).rejects.toMatchObject({
      code: "unsupported-style",
      message: expect.stringContaining(".card"),
    });
    expect(await get("src/Card.module.scss")).toBe(nested);
  });

  it("refuses an indented .module.sass import and says what to do", async () => {
    await put("src/Card.tsx", CARD("sass"));
    const sass = `.card\n  color: red\n`;
    await put("src/Card.module.sass", sass);
    await expect(
      createSourceEditor().apply(open(d()), [await styleCard({ color: "blue" })], ana, page),
    ).rejects.toMatchObject({
      code: "unsupported-style",
      message: expect.stringMatching(/Card\.module\.sass is indented Sass.*Ask the agent.*\.scss/),
    });
    expect(await get("src/Card.module.sass")).toBe(sass);
  });

  it("keeps tokens in the global .scss sheet's :root, not @theme", async () => {
    const css = `@use "./vars";\n\n.page {\n  margin: 0;\n}\n`;
    await put("src/global.scss", css);
    const source = createSourceEditor();
    const scss = { ...d(), css: ["src/global.scss"] };
    expect(await source.tokens(scss)).toEqual([]);
    expect(await source.setToken(scss, { name: "ink", mode: "light", value: "#111" })).toEqual([
      { name: "--ink", light: "#111" },
    ]);
    expect(await get("src/global.scss")).toBe(
      `@use "./vars";\n\n:root {\n  --ink: #111;\n}\n\n.page {\n  margin: 0;\n}\n`,
    );
    await source.setToken(scss, { name: "ink", mode: "light", value: "#222" });
    expect(await get("src/global.scss")).toContain("--ink: #222;");
  });
});

describe("SourceEditor with Sass and Less variable tokens", () => {
  const CARD = (ext: string) =>
    `import s from "./Card.module.${ext}";\nexport const Card = () => <div className={s.card}>x</div>;\n`;
  const MODULE = `@use "../styles/tokens" as t;\n\n.card {\n  gap: t.$gap;\n}\n`;
  const GLOBAL = `@use "tokens";\n@use "theme" as *;\n\n$shade: #2a7f8e;\n\n:root {\n  --ink: #111;\n}\n`;
  const d = () => ({
    ...design("css-modules"),
    css: ["src/styles/global.scss", "src/styles/theme.less"],
  });
  const styleCard = async (styles: Record<string, string | null>) =>
    edit("src/c/Card.tsx", { kind: "style", locs: ["src/c/Card.tsx:2:26"], tag: "div", styles });

  beforeEach(async () => {
    await put("src/styles/global.scss", GLOBAL);
    await put("src/styles/_tokens.scss", `$gap: 4px;\n`);
    await put("src/styles/_theme.scss", `// Brand colours.\n$brand: #95ced7;\n`);
    await put("src/styles/theme.less", `@line: #2a7f8e;\n`);
  });

  it("lists $vars and @vars, edits their light value and refuses a dark one", async () => {
    const source = createSourceEditor();
    expect(await source.tokens(d())).toEqual([
      { name: "$shade", light: "#2a7f8e" },
      { name: "--ink", light: "#111" },
      { name: "@line", light: "#2a7f8e" },
      { name: "$gap", light: "4px" },
      { name: "$brand", light: "#95ced7" },
    ]);
    await source.setToken(d(), { name: "$brand", mode: "light", value: "#fff" });
    await source.setToken(d(), { name: "$shade", mode: "light", value: "#000" });
    await source.setToken(d(), { name: "$new", mode: "light", value: "2px" });
    await source.setToken(d(), { name: "@pad", mode: "light", value: "6px" });
    expect(await get("src/styles/_theme.scss")).toBe(`// Brand colours.\n$brand: #fff;\n`);
    expect(await get("src/styles/global.scss")).toBe(GLOBAL.replace("#2a7f8e", "#000"));
    // A new $var goes in the first sheet that outputs no CSS, so a module can @use it.
    expect(await get("src/styles/_tokens.scss")).toBe(`$gap: 4px;\n$new: 2px;\n`);
    expect(await get("src/styles/theme.less")).toBe(`@line: #2a7f8e;\n@pad: 6px;\n`);
    await expect(
      source.setToken(d(), { name: "$brand", mode: "dark", value: "#000" }),
    ).rejects.toMatchObject({ code: "invalid", message: expect.stringContaining("no dark mode") });
    await expect(
      source.setToken(
        { ...d(), css: ["src/styles/theme.less"] },
        {
          name: "$new",
          mode: "light",
          value: "1px",
        },
      ),
    ).rejects.toMatchObject({ code: "invalid", message: expect.stringContaining(".scss") });
  });

  it("writes a picked $var into the module rule with its @use, and undo takes both out", async () => {
    await put("src/c/Card.tsx", CARD("scss"));
    await put("src/c/Card.module.scss", MODULE);
    const source = createSourceEditor();
    await source.apply(open(d()), [await styleCard({ color: "$brand" })], ana, page);
    const picked = `@use "../styles/tokens" as t;\n@use "../styles/theme" as *;\n\n.card {\n  gap: t.$gap;\n  color: $brand;\n}\n`;
    expect(await get("src/c/Card.module.scss")).toBe(picked);
    // A second pick finds the @use already there.
    await source.apply(open(d()), [await styleCard({ background: "$brand" })], ana, page);
    expect(await get("src/c/Card.module.scss")).toBe(
      picked.replace("color: $brand;\n", "color: $brand;\n  background: $brand;\n"),
    );
    await source.undo(open(d()), ana);
    await source.undo(open(d()), ana);
    expect(await get("src/c/Card.module.scss")).toBe(MODULE);
    await source.redo(open(d()), ana);
    expect(await get("src/c/Card.module.scss")).toBe(picked);
  });

  it("writes a picked @var into a .module.less rule with @import (reference)", async () => {
    await put("src/c/Card.tsx", CARD("less"));
    await put("src/c/Card.module.less", `.card {\n  margin: 0;\n}\n`);
    await createSourceEditor().apply(
      open(d()),
      [await styleCard({ borderColor: "@line" })],
      ana,
      page,
    );
    expect(await get("src/c/Card.module.less")).toBe(
      `@import (reference) "../styles/theme.less";\n\n.card {\n  margin: 0;\n  border-color: @line;\n}\n`,
    );
  });

  it("writes a $var into a prototype's module, importing production's sheet", async () => {
    const dir = ".finite/boards/c1";
    await put(`${dir}/Card.tsx`, CARD("scss"));
    await put(`${dir}/Card.module.scss`, `.card {\n  margin: 0;\n}\n`);
    await createSourceEditor().apply(
      open(d()),
      [
        await edit(`${dir}/Card.tsx`, {
          kind: "style",
          locs: [`${dir}/Card.tsx:2:26`],
          tag: "div",
          styles: { color: "$brand" },
        }),
      ],
      ana,
      proto,
    );
    expect(await get(`${dir}/Card.module.scss`)).toBe(
      `@use "../../../src/styles/theme" as *;\n\n.card {\n  margin: 0;\n  color: $brand;\n}\n`,
    );
  });

  it("follows the module's namespace for a partial's $var, and refuses one from a sheet with CSS", async () => {
    await put("src/c/Card.tsx", CARD("scss"));
    await put("src/c/Card.module.scss", MODULE);
    const source = createSourceEditor();
    await source.apply(open(d()), [await styleCard({ margin: "$gap" })], ana, page);
    expect(await get("src/c/Card.module.scss")).toBe(
      MODULE.replace("gap: t.$gap;\n", "gap: t.$gap;\n  margin: t.$gap;\n"),
    );
    await source.undo(open(d()), ana);
    await expect(
      source.apply(open(d()), [await styleCard({ color: "$shade" })], ana, page),
    ).rejects.toMatchObject({
      code: "unsupported-style",
      message: expect.stringContaining("Move the $vars into a partial (src/styles/_tokens.scss)"),
    });
    expect(await get("src/c/Card.module.scss")).toBe(MODULE);
  });

  it("refuses a $var on an inline-styled element and leaves the file alone", async () => {
    const plain = `export const Card = () => <div>x</div>;\n`;
    await put("src/c/Card.tsx", plain);
    await expect(
      createSourceEditor().apply(
        open(d()),
        [
          await edit("src/c/Card.tsx", {
            kind: "style",
            locs: ["src/c/Card.tsx:1:26"],
            tag: "div",
            styles: { color: "$brand" },
          }),
        ],
        ana,
        page,
      ),
    ).rejects.toMatchObject({ code: "unsupported-style" });
    expect(await get("src/c/Card.tsx")).toBe(plain);
  });
});

describe("SourceEditor with StyleX defineVars tokens", () => {
  const VARS = `import * as stylex from "@stylexjs/stylex";

export const colors = stylex.defineVars({
  brand: "#95ced7",
});
`;
  const HOME = `import { create, props } from "@stylexjs/stylex";
import { Card } from "../components/Card.tsx";

const styles = create({
  main: {
    gap: "8px",
  },
  heading: {
    fontSize: "24px",
  },
});

export default function Home() {
  return (
    <main {...props(styles.main)}>
      <h1 {...props(styles.heading)}>Welcome home</h1>
      <p>Body</p>
    </main>
  );
}
`;
  const sx = () => design("stylex");
  const pickH1 = async (styles: Record<string, string | null>) =>
    edit("src/pages/Home.tsx", {
      kind: "style",
      locs: ["src/pages/Home.tsx:16:6"],
      tag: "h1",
      styles,
    });

  beforeEach(async () => {
    await put("src/index.css", `:root {\n  --ink: #111;\n}\n`);
    await put("src/tokens.stylex.ts", VARS);
    await put("src/pages/Home.tsx", HOME);
  });

  it("lists defineVars next to the custom properties and edits them on the Tokens page", async () => {
    const source = createSourceEditor();
    expect(await source.tokens(sx())).toEqual([
      { name: "--ink", light: "#111" },
      { name: "colors.brand", light: "#95ced7" },
    ]);
    // Only a StyleX design reads them.
    expect(await source.tokens(design("inline"))).toEqual([{ name: "--ink", light: "#111" }]);
    await source.setToken(sx(), { name: "colors.brand", mode: "dark", value: "#1a6f7b" });
    expect(
      await source.setToken(sx(), { name: "colors.accent", mode: "light", value: "#f0c" }),
    ).toEqual([
      { name: "--ink", light: "#111" },
      { name: "colors.brand", light: "#95ced7", dark: "#1a6f7b" },
      { name: "colors.accent", light: "#f0c" },
    ]);
    expect(await get("src/tokens.stylex.ts")).toBe(
      VARS.replace(
        `brand: "#95ced7",`,
        `brand: {\n    default: "#95ced7",\n    "@media (prefers-color-scheme: dark)": "#1a6f7b",\n  },\n  accent: "#f0c",`,
      ),
    );
    // Custom properties still go in the stylesheet.
    await source.setToken(sx(), { name: "--line", mode: "light", value: "#ccc" });
    expect(await get("src/index.css")).toBe(`:root {\n  --ink: #111;\n  --line: #ccc;\n}\n`);
  });

  it("refuses a token for a group no defineVars has, or when there's none", async () => {
    const source = createSourceEditor();
    await expect(
      source.setToken(sx(), { name: "space.lg", mode: "light", value: "24px" }),
    ).rejects.toMatchObject({
      code: "invalid",
      message: expect.stringContaining("Add it to colors.lg"),
    });
    await rm(path.join(root, "src/tokens.stylex.ts"));
    await expect(
      source.setToken(sx(), { name: "colors.brand", mode: "light", value: "#000" }),
    ).rejects.toMatchObject({
      code: "invalid",
      message: expect.stringContaining("no stylex.defineVars yet"),
    });
  });

  it("writes a picked token and its import, and undo and redo work around another actor's edit", async () => {
    const source = createSourceEditor();
    const picked = HOME.replace(
      `import { Card } from "../components/Card.tsx";\n`,
      `import { Card } from "../components/Card.tsx";\nimport { colors } from "../tokens.stylex";\n`,
    ).replace(`fontSize: "24px",\n`, `fontSize: "24px",\n    color: colors.brand,\n`);
    const result = await source.apply(
      open(sx()),
      [await pickH1({ color: "colors.brand" })],
      ana,
      page,
    );
    expect(await get("src/pages/Home.tsx")).toBe(picked);
    const p = result.remap["src/pages/Home.tsx:17:6"]!;
    expect(p).toBe("src/pages/Home.tsx:19:6");
    await source.apply(
      open(sx()),
      [await edit("src/pages/Home.tsx", { kind: "text", loc: p, tag: "p", text: "Other" })],
      bo,
      page,
    );
    await source.undo(open(sx()), ana);
    expect(await get("src/pages/Home.tsx")).toBe(HOME.replace("Body", "Other"));
    await source.redo(open(sx()), ana);
    expect(await get("src/pages/Home.tsx")).toBe(picked.replace("Body", "Other"));
    await source.undo(open(sx()), bo);
    expect(await get("src/pages/Home.tsx")).toBe(picked);
  });

  it("imports a token into a prototype from production, and still writes a custom property", async () => {
    const file = ".finite/boards/c1/Home.tsx";
    await put(file, HOME);
    const source = createSourceEditor();
    await source.apply(
      open(sx()),
      [
        await edit(file, {
          kind: "style",
          locs: [`${file}:16:6`],
          tag: "h1",
          styles: { color: "colors.brand", borderColor: "var(--ink)" },
        }),
      ],
      ana,
      proto,
    );
    const code = await get(file);
    expect(code).toContain(`import { colors } from "../../../src/tokens.stylex";\n`);
    expect(code).toContain(`color: colors.brand,\n    borderColor: "var(--ink)",\n`);
  });

  it("gives an element without a stylex.props spread a new entry with the token, and undo restores the file", async () => {
    const source = createSourceEditor();
    const result = await source.apply(
      open(sx()),
      [
        await edit("src/pages/Home.tsx", {
          kind: "style",
          locs: ["src/pages/Home.tsx:17:6"],
          tag: "p",
          styles: { color: "colors.brand" },
        }),
      ],
      ana,
      page,
    );
    expect(await get("src/pages/Home.tsx")).toBe(
      HOME.replace(
        `import { Card } from "../components/Card.tsx";\n`,
        `import { Card } from "../components/Card.tsx";\nimport { colors } from "../tokens.stylex";\n`,
      )
        .replace(
          `fontSize: "24px",\n  },\n`,
          `fontSize: "24px",\n  },\n  text: {\n    color: colors.brand,\n  },\n`,
        )
        .replace("<p>", "<p {...props(styles.text)}>"),
    );
    expect(result.remap["src/pages/Home.tsx:17:6"]).toBe("src/pages/Home.tsx:21:6");
    await source.undo(open(sx()), ana);
    expect(await get("src/pages/Home.tsx")).toBe(HOME);
  });
});

describe("SourceEditor undo and redo", () => {
  const d = () => design();
  const styleH1 = () =>
    edit("src/App.tsx", {
      kind: "style",
      locs: ["src/App.tsx:6:6"],
      tag: "h1",
      styles: { fontSize: "24px" },
    });

  it("undoes and redoes an actor's edit", async () => {
    await put("src/App.tsx", APP);
    const source = createSourceEditor();
    await source.apply(open(d()), [await styleH1()], ana, page);
    const edited = await get("src/App.tsx");
    expect(edited).toContain(`<h1 className="text-2xl">`);
    await source.undo(open(d()), ana);
    expect(await get("src/App.tsx")).toBe(APP);
    await source.redo(open(d()), ana);
    expect(await get("src/App.tsx")).toBe(edited);
  });

  it("keeps a stack per actor", async () => {
    await put("src/App.tsx", APP);
    const source = createSourceEditor();
    await source.apply(open(d()), [await styleH1()], ana, page);
    await expect(source.undo(open(d()), bo)).rejects.toMatchObject({ message: "Nothing to undo" });
    await source.undo(open(d()), ana);
    expect(await get("src/App.tsx")).toBe(APP);
  });

  it("undoes after an unrelated edit elsewhere in the same file", async () => {
    await put("src/App.tsx", APP);
    const source = createSourceEditor();
    await source.apply(open(d()), [await styleH1()], ana, page);
    const agentEdit = (await get("src/App.tsx")).replace(
      `import { Card } from "./Card";\n`,
      `import { Card } from "./Card";\nimport { Extra } from "./Extra";\n\nconst x = 1;\n`,
    );
    await put("src/App.tsx", agentEdit);
    await source.undo(open(d()), ana);
    expect(await get("src/App.tsx")).toBe(
      APP.replace(
        `import { Card } from "./Card";\n`,
        `import { Card } from "./Card";\nimport { Extra } from "./Extra";\n\nconst x = 1;\n`,
      ),
    );
    await source.redo(open(d()), ana);
    expect(await get("src/App.tsx")).toContain(`<h1 className="text-2xl">`);
  });

  it("refuses to undo over a conflicting edit and drops that step", async () => {
    await put("src/App.tsx", APP);
    const source = createSourceEditor();
    await source.apply(open(d()), [await styleH1()], ana, page);
    await put("src/App.tsx", (await get("src/App.tsx")).replace("text-2xl", "text-4xl"));
    await expect(source.undo(open(d()), ana)).rejects.toMatchObject({ code: "stale" });
    expect(await get("src/App.tsx")).toContain("text-4xl");
    await expect(source.undo(open(d()), ana)).rejects.toMatchObject({ message: "Nothing to undo" });
  });

  it("undoes and redoes a StyleX create edit around another actor's edit in the same file", async () => {
    const card = `import * as stylex from "@stylexjs/stylex";

const styles = stylex.create({
  card: {
    color: "red",
  },
});

export function Card() {
  return (
    <div {...stylex.props(styles.card)}>
      <p>One</p>
    </div>
  );
}
`;
    const padded = (text: string) =>
      card.replace(`color: "red",`, `color: "red",\n    padding: "8px",`).replace("One", text);
    await put("src/Card.tsx", card);
    const source = createSourceEditor();
    const sx = open(design("stylex"));
    const styled = await source.apply(
      sx,
      [
        await edit("src/Card.tsx", {
          kind: "style",
          locs: ["src/Card.tsx:11:4"],
          tag: "div",
          styles: { padding: "8px" },
        }),
      ],
      ana,
      page,
    );
    expect(await get("src/Card.tsx")).toBe(padded("One"));
    const p = styled.remap["src/Card.tsx:12:6"]!;
    expect(p).toBe("src/Card.tsx:13:6");
    await source.apply(
      sx,
      [await edit("src/Card.tsx", { kind: "text", loc: p, tag: "p", text: "Two" })],
      bo,
      page,
    );
    await source.undo(sx, ana);
    expect(await get("src/Card.tsx")).toBe(card.replace("One", "Two"));
    await source.redo(sx, ana);
    expect(await get("src/Card.tsx")).toBe(padded("Two"));
    await source.undo(sx, bo);
    expect(await get("src/Card.tsx")).toBe(padded("One"));
  });

  it("refuses to undo a new StyleX entry after another actor's edit between the entry and the element", async () => {
    const card = `import * as stylex from "@stylexjs/stylex";

const styles = stylex.create({
  card: {
    color: "red",
  },
});

export function Card() {
  return (
    <div {...stylex.props(styles.card)}>
      <h2>Title</h2>
      <span>By Ana</span>
      <p>One</p>
    </div>
  );
}
`;
    const styledP = (text: string) =>
      card
        .replace(`  },\n});`, `  },\n  text: {\n    padding: "8px",\n  },\n});`)
        .replace("<p>", "<p {...stylex.props(styles.text)}>")
        .replace("Title", text);
    await put("src/Card.tsx", card);
    const source = createSourceEditor();
    const sx = open(design("stylex"));
    const styled = await source.apply(
      sx,
      [
        await edit("src/Card.tsx", {
          kind: "style",
          locs: ["src/Card.tsx:14:6"],
          tag: "p",
          styles: { padding: "8px" },
        }),
      ],
      ana,
      page,
    );
    expect(await get("src/Card.tsx")).toBe(styledP("Title"));
    const h2 = styled.remap["src/Card.tsx:12:6"]!;
    expect(h2).toBe("src/Card.tsx:15:6");
    await source.apply(
      sx,
      [await edit("src/Card.tsx", { kind: "text", loc: h2, tag: "h2", text: "Heading" })],
      bo,
      page,
    );
    const afterBo = await get("src/Card.tsx");
    expect(afterBo).toBe(styledP("Heading"));
    await expect(source.undo(sx, ana)).rejects.toMatchObject({ code: "stale" });
    expect(await get("src/Card.tsx")).toBe(afterBo);
  });

  it("a new edit clears the redo stack", async () => {
    await put("src/App.tsx", APP);
    const source = createSourceEditor();
    await source.apply(open(d()), [await styleH1()], ana, page);
    await source.undo(open(d()), ana);
    await source.apply(
      open(d()),
      [await edit("src/App.tsx", { kind: "text", loc: "src/App.tsx:7:6", tag: "p", text: "Two" })],
      ana,
      page,
    );
    await expect(source.redo(open(d()), ana)).rejects.toMatchObject({ message: "Nothing to redo" });
  });
});

describe("copying between production and prototypes", () => {
  const CARD = `import { cn } from "../lib/cn";
import "./card.css";
import logo from "../assets/logo.svg";
import { useThing } from "@/hooks";

export function Card() {
  return <div className={cn("p-2")}>card</div>;
}
`;

  it("detaches a production file into the board and points the importer at the copy", async () => {
    await put("src/components/Card.tsx", CARD);
    const importer = ".finite/boards/c1/Home.tsx";
    await put(
      importer,
      `import { Card } from "../../../src/components/Card";\nexport default () => <Card />;\n`,
    );
    const source = createSourceEditor();
    const { file } = await source.detach(
      open(design()),
      { canvasId: "c1", file: "src/components/Card.tsx", importer },
      ana,
    );
    expect(file).toBe(".finite/boards/c1/Card.tsx");
    expect(await get(file)).toBe(`import { cn } from "../../../src/lib/cn";
import "../../../src/components/card.css";
import logo from "../../../src/assets/logo.svg";
import { useThing } from "@/hooks";

export function Card() {
  return <div className={cn("p-2")}>card</div>;
}
`);
    expect(await get(importer)).toBe(
      `import { Card } from "./Card";\nexport default () => <Card />;\n`,
    );
  });

  it("refuses to detach a file the importer doesn't import", async () => {
    await put("src/components/Card.tsx", CARD);
    await put(".finite/boards/c1/Home.tsx", `export default () => null;\n`);
    const source = createSourceEditor();
    await expect(
      source.detach(
        open(design()),
        { canvasId: "c1", file: "src/components/Card.tsx", importer: ".finite/boards/c1/Home.tsx" },
        ana,
      ),
    ).rejects.toMatchObject({ code: "invalid" });
  });

  it("copies a component by name, with a free name when the target exists", async () => {
    await put("src/components/Card.tsx", CARD);
    await put(".finite/boards/c1/Card.tsx", "taken");
    const source = createSourceEditor();
    const { file } = await source.copyComponent(
      design(),
      { name: "Card" },
      ".finite/boards/c1/Card.tsx",
    );
    expect(file).toBe(".finite/boards/c1/Card-2.tsx");
    expect(await get(file)).toContain(`import { cn } from "../../../src/lib/cn";`);
    await expect(
      source.copyComponent(design(), { name: "Card" }, "src/Copy.tsx"),
    ).rejects.toMatchObject({ code: "outside-prototype" });
    await expect(
      source.copyComponent(design(), { name: "Card" }, ".finite/../src/Copy.tsx"),
    ).rejects.toMatchObject({ code: "outside-prototype" });
    await expect(
      source.copyComponent(design(), { name: "Nope" }, ".finite/boards/c1/X.tsx"),
    ).rejects.toMatchObject({ code: "not-found" });
  });

  it("gives concurrent copies to the same name different files", async () => {
    await put("src/components/Card.tsx", CARD);
    const source = createSourceEditor();
    const copies = await Promise.all(
      [1, 2, 3].map(() =>
        source.copyComponent(design(), { name: "Card" }, ".finite/boards/c1/Card.tsx"),
      ),
    );
    expect(copies.map((c) => c.file).sort()).toEqual([
      ".finite/boards/c1/Card-2.tsx",
      ".finite/boards/c1/Card-3.tsx",
      ".finite/boards/c1/Card.tsx",
    ]);
  });

  it("copies a route's file when told how to find routes", async () => {
    await put(
      "src/routes/about.tsx",
      `import x from "./x";\nexport default function About() { return <p>{x}</p>; }\n`,
    );
    const source = createSourceEditor({
      routes: async () => [{ path: "/about", file: "src/routes/about.tsx", params: [] }],
    });
    const { file } = await source.copyComponent(
      design(),
      { route: "/about" },
      ".finite/boards/c1/About.tsx",
    );
    expect(await get(file)).toContain(`import x from "../../../src/routes/x";`);
  });

  it("exports what the frames need to run elsewhere: every local file they import", async () => {
    await put(
      ".finite/boards/c1/Home.tsx",
      `import { Card } from "./Card";\nimport { App } from "../../../src/App";\nimport mark from "../../../src/assets/brand/mark.svg?url";\nimport "./home.css";\nimport { x } from "react";\nexport default () => <Card />;\n`,
    );
    await put(
      ".finite/boards/c1/Card.tsx",
      `import { cn } from "./cn";\nexport const Card = () => <div />;\n`,
    );
    await put(".finite/boards/c1/cn.ts", `export const cn = () => "";\n`);
    await put(
      ".finite/boards/c1/home.css",
      `@import "./base.css";\n.a { background: url("../../../src/bg.png"); }\n.b { background: url(data:image/png;base64,AA); }\n`,
    );
    await put(".finite/boards/c1/base.css", `.base {}\n`);
    await put("src/App.tsx", APP);
    await put("src/Card.tsx", `export const Card = () => <i />;\n`);
    await put("src/assets/brand/mark.svg", `<svg/>`);
    await put("src/bg.png", "png");
    await put("src/index.css", `@import "tailwindcss";\n`);
    await put("package.json", `{"name":"d"}`);
    await put("src/unused.tsx", `export {};\n`);
    await put(
      ".finite/boards/c1/Escape.tsx",
      `import "../../../../outside";\nexport default () => null;\n`,
    );
    const source = createSourceEditor();
    const frame = (file: string) => ({
      id: file,
      name: "Home",
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      source: { kind: "file" as const, file },
    });
    const files = await source.exportFrames(open(design()), "c1", [
      frame(".finite/boards/c1/Home.tsx"),
      frame(".finite/boards/c1/Escape.tsx"),
    ]);
    expect(files.map((f) => f.path).sort()).toEqual([
      ".finite/boards/c1/Card.tsx",
      ".finite/boards/c1/Escape.tsx",
      ".finite/boards/c1/Home.tsx",
      ".finite/boards/c1/base.css",
      ".finite/boards/c1/cn.ts",
      ".finite/boards/c1/home.css",
      "package.json",
      "src/App.tsx",
      "src/Card.tsx",
      "src/assets/brand/mark.svg",
      "src/bg.png",
      "src/index.css",
    ]);
    expect(new TextDecoder().decode(files.find((f) => f.path.endsWith("mark.svg"))!.data)).toBe(
      "<svg/>",
    );
  });
});

describe("exportFrames with Sass and Less", () => {
  const frame = (file: string) => ({
    id: file,
    name: "Home",
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    source: { kind: "file" as const, file },
  });

  it("follows @use, @forward and @import through partials, indexes and comments", async () => {
    await put(
      ".finite/boards/c1/Home.tsx",
      `import s from "./home.module.scss";\nimport "./theme.less";\nexport default () => <div className={s.a} />;\n`,
    );
    await put(
      ".finite/boards/c1/home.module.scss",
      `@use "sass:math";\n@use "tokens" as t;\n@use "lib";\n@use "../../../src/styles/shared.scss";\n@import "plain", "./second.scss";\n// @use "commented";\n/* @import "block"; */\n.a { background: url("../../../src/bg.png"); content: "// not a comment"; }\n.b { background: url(//cdn.example.com/x.png); }\n@import "~pkg/x"; @import "https://x/y.css";\n`,
    );
    await put(".finite/boards/c1/_tokens.scss", `@forward "colors";\n$ink: #111;\n`);
    await put(".finite/boards/c1/_colors.scss", `$red: red;\n`);
    await put(".finite/boards/c1/lib/_index.scss", `@use "inner";\n`);
    await put(".finite/boards/c1/lib/_inner.scss", `.inner {}\n`);
    await put(".finite/boards/c1/plain.css", `.plain {}\n`);
    await put(".finite/boards/c1/second.scss", `.second {}\n`);
    await put(".finite/boards/c1/commented.scss", `.nope {}\n`);
    await put(".finite/boards/c1/block.scss", `.nope {}\n`);
    await put("src/styles/shared.scss", `.shared {}\n`);
    await put("src/bg.png", "png");
    await put(
      ".finite/boards/c1/theme.less",
      `// @import "commented";\n@import (reference) "mixins";\n@import (css, optional) url("legacy.css");\n@import "./vars.less", "more";\n@import "@{themes}/dark";\n.t { background: url('./img/a.svg'); }\n`,
    );
    await put(".finite/boards/c1/mixins.less", `.m() {}\n`);
    await put(".finite/boards/c1/legacy.css", `.legacy {}\n`);
    await put(".finite/boards/c1/vars.less", `@v: 1;\n`);
    await put(".finite/boards/c1/more.less", `.more {}\n`);
    await put(".finite/boards/c1/img/a.svg", `<svg/>`);
    await put(".finite/boards/c1/unused.scss", `.unused {}\n`);
    await put("package.json", `{"name":"d"}`);
    const files = await createSourceEditor().exportFrames(open(design()), "c1", [
      frame(".finite/boards/c1/Home.tsx"),
    ]);
    expect(files.map((f) => f.path).sort()).toEqual(
      [
        ".finite/boards/c1/Home.tsx",
        ".finite/boards/c1/_colors.scss",
        ".finite/boards/c1/_tokens.scss",
        ".finite/boards/c1/home.module.scss",
        ".finite/boards/c1/img/a.svg",
        ".finite/boards/c1/legacy.css",
        ".finite/boards/c1/lib/_index.scss",
        ".finite/boards/c1/lib/_inner.scss",
        ".finite/boards/c1/mixins.less",
        ".finite/boards/c1/more.less",
        ".finite/boards/c1/plain.css",
        ".finite/boards/c1/second.scss",
        ".finite/boards/c1/theme.less",
        ".finite/boards/c1/vars.less",
        "package.json",
        "src/bg.png",
        "src/styles/shared.scss",
      ].sort(),
    );
  });
});

describe("exportFrames with Sass import-only files", () => {
  it("resolves @import to the .import.scss file first, and @use to the plain one", async () => {
    await put(
      ".finite/boards/c1/Home.tsx",
      `import "./home.scss";\nexport default () => <div />;\n`,
    );
    await put(".finite/boards/c1/home.scss", `@import "theme", "plain";\n@use "colors";\n`);
    await put(".finite/boards/c1/_theme.import.scss", `@forward "theme";\n`);
    await put(".finite/boards/c1/_theme.scss", `$a: 1;\n`);
    await put(".finite/boards/c1/plain.import.scss", `.p {}\n`);
    await put(".finite/boards/c1/plain.scss", `.unused {}\n`);
    await put(".finite/boards/c1/colors.import.scss", `.unused {}\n`);
    await put(".finite/boards/c1/_colors.scss", `$red: red;\n`);
    await put("package.json", `{"name":"d"}`);
    const files = await createSourceEditor().exportFrames(open(design()), "c1", [
      {
        id: "f",
        name: "Home",
        x: 0,
        y: 0,
        width: 100,
        height: 100,
        source: { kind: "file", file: ".finite/boards/c1/Home.tsx" },
      },
    ]);
    expect(files.map((f) => f.path).sort()).toEqual(
      [
        ".finite/boards/c1/Home.tsx",
        ".finite/boards/c1/_colors.scss",
        ".finite/boards/c1/_theme.import.scss",
        ".finite/boards/c1/_theme.scss",
        ".finite/boards/c1/home.scss",
        ".finite/boards/c1/plain.import.scss",
        "package.json",
      ].sort(),
    );
  });
});

describe("tokens and components", () => {
  it("reads and writes tokens in the design's stylesheet", async () => {
    const css = `@import "tailwindcss";\n\n@theme {\n  --color-primary: #95ced7;\n}\n`;
    await put("src/index.css", css);
    const source = createSourceEditor();
    expect(await source.tokens(design())).toEqual([{ name: "--color-primary", light: "#95ced7" }]);
    expect(
      await source.setToken(design(), { name: "color-primary", mode: "dark", value: "#4a8f99" }),
    ).toEqual([{ name: "--color-primary", light: "#95ced7", dark: "#4a8f99" }]);
    await source.setToken(design(), { name: "--color-primary", mode: "dark", value: null });
    expect(await get("src/index.css")).toBe(`${css}\n.dark {\n}\n`);
  });

  it("lists exported PascalCase function components", async () => {
    await put(
      "src/components/Button.tsx",
      `export function Button() { return <button />; }\nexport const Icon = () => <i />;\nexport const helper = () => 1;\nconst Inner = memo(() => <b />);\nexport { Inner as Bold };\nexport const MAX = 3;\n`,
    );
    await put("src/pages/Home.tsx", `export default function () { return <main />; }\n`);
    await put("src/pages/Home.test.tsx", `export function Spec() { return null; }\n`);
    await put("src/broken.tsx", `export function Broken( {`);
    const source = createSourceEditor();
    expect(await source.components(design())).toEqual([
      { name: "Button", file: "src/components/Button.tsx", exportName: "Button" },
      { name: "Icon", file: "src/components/Button.tsx", exportName: "Icon" },
      { name: "Bold", file: "src/components/Button.tsx", exportName: "Bold" },
      { name: "Home", file: "src/pages/Home.tsx", exportName: "default" },
    ]);
  });
});
