import fs from "node:fs";
import path from "node:path";
import { describe, type ExpectStatic, test } from "vite-plus/test";
import { designOf, get, previewHarness } from "./harness.ts";

const { previews, prepare } = previewHarness();

async function generatesClasses(bundler: "turbopack" | "webpack", expect: ExpectStatic) {
  const fixture = await prepare("next-tailwind3");
  const at = (file: string) => path.join(fixture.root, file);
  if (bundler === "webpack") {
    const pkg = fs.readFileSync(at("package.json"), "utf8");
    fs.writeFileSync(at("package.json"), pkg.replace(`"next dev"`, `"next dev --webpack"`));
  }
  const project = ["app/globals.css", "tailwind.config.ts", "postcss.config.mjs"];
  const before = project.map((file) => fs.readFileSync(at(file), "utf8"));
  const board = (file: string, className: string) => {
    fs.mkdirSync(path.dirname(at(file)), { recursive: true });
    fs.writeFileSync(at(file), `export default () => <section className="${className}" />;\n`);
  };
  board(".finite/boards/demo/Hero.tsx", "bg-[#0a7f3e] p-[13px] text-brand");
  board(".finite/runtime/Stray.tsx", "bg-[#999001]");
  const copy = {
    ...designOf("next-app", fixture.root),
    id: `next-tailwind3-${bundler}`,
    css: ["app/globals.css"],
  };
  const { url } = await previews.ensure(copy);
  const css = async () => {
    const page = await get(
      previews.frameUrl(copy.id, { kind: "file", file: ".finite/boards/demo/Hero.tsx" }),
    );
    expect(page.status).toBe(200);
    const sheets = [...page.text.matchAll(/<link rel="stylesheet" href="([^"]+\.css[^"]*)"/g)];
    const css = await Promise.all(sheets.map(([, href]) => get(url + href, "text/css")));
    return css.map((sheet) => sheet.text).join("\n");
  };
  const first = await css();
  expect(first).toContain("bg-\\[\\#0a7f3e\\]");
  expect(first).toContain(".text-brand");
  // The project's own content globs still apply.
  expect(first).toContain(".bg-slate-50");
  expect(first).not.toContain("999001");

  // A board written while the preview runs gets its classes too.
  board(".finite/boards/later/Late.tsx", "bg-[#0b8f4e]");
  await expect.poll(css, { timeout: 15_000 }).toContain("bg-\\[\\#0b8f4e\\]");
  expect(project.map((file) => fs.readFileSync(at(file), "utf8"))).toEqual(before);
  await previews.stop(copy.id);
}

// The two bundlers are independent dev servers on their own copies, so they start together. A
// concurrent test uses its own `expect`, so `expect.poll` knows which test it belongs to.
describe("Tailwind v3 in a Next.js preview", () => {
  const title = (bundler: string) =>
    `generates Tailwind v3 classes used only in .finite/, without touching the project (${bundler})`;
  test.concurrent(
    title("turbopack"),
    ({ expect }) => generatesClasses("turbopack", expect),
    180_000,
  );
  test.concurrent(title("webpack"), ({ expect }) => generatesClasses("webpack", expect), 180_000);
});
