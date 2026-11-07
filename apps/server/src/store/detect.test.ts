import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { detectProject } from "./detect.ts";

const cleanup: string[] = [];
afterEach(async () => {
  for (const dir of cleanup.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function project(deps: Record<string, string>, files: Record<string, string>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "finite-detect-"));
  cleanup.push(root);
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ devDependencies: deps }));
  for (const [file, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), text);
  }
  return root;
}

const rr = { vite: "^8", "react-router": "^8" };
const stylex = { ...rr, "@stylexjs/stylex": "0.19.1" };
const styling = async (deps: Record<string, string>, files: Record<string, string>) =>
  (await detectProject(await project(deps, files))).styling;

const NAMESPACE = `import * as sx from "@stylexjs/stylex";
const s = sx.create({ a: { color: "red" } });
export const A = () => <div {...sx.props(s.a)} />;
`;
const NAMED = `import { create, props as p } from "@stylexjs/stylex";
const s = create({ a: { color: "red" } });
export const B = () => <div {...p(s.a)} />;
`;
const CLASSES = `export const C = () => <div className="flex p-4" />;\n`;

describe("detectProject styling", () => {
  it("picks StyleX when files call its props under any local name", async () => {
    expect(await styling(stylex, { "src/A.tsx": NAMESPACE })).toBe("stylex");
    expect(await styling(stylex, { "src/B.tsx": NAMED })).toBe("stylex");
  });

  it("doesn't pick StyleX with the dependency but no props calls", async () => {
    const tokensOnly = `import * as sx from "@stylexjs/stylex";\nexport const t = sx.defineVars({ a: "red" });\n`;
    expect(await styling(stylex, { "src/tokens.stylex.ts": tokensOnly })).toBe("inline");
    expect(await styling(stylex, { "src/C.tsx": CLASSES })).toBe("inline");
  });

  it("doesn't pick StyleX without the dependency", async () => {
    expect(await styling(rr, { "src/A.tsx": NAMESPACE })).toBe("inline");
  });

  it("beats Tailwind when both are present and StyleX is used at least as much", async () => {
    const both = { ...stylex, tailwindcss: "^4" };
    expect(await styling(both, { "src/A.tsx": NAMESPACE, "src/C.tsx": CLASSES })).toBe("stylex");
    expect(
      await styling(both, { "src/A.tsx": NAMESPACE, "src/C.tsx": CLASSES, "src/D.tsx": CLASSES }),
    ).toBe("tailwind");
  });
});
