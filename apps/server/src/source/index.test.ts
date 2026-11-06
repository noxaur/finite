import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Actor, Canvas, Design, OpenDesign, SourceEdit, Styling } from "@finite/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { createLocks, rev } from "./files.ts";
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
    expect(result).toEqual({ ok: true, remap: { "src/App.tsx:7:6": "src/App.tsx:8:6" } });
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
    const locks = createLocks();
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
