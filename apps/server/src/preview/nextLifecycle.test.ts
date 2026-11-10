import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { designOf, get, previewHarness } from "./harness.ts";

const { previews, prepare } = previewHarness();

describe("Next.js preview lifecycle", () => {
  test("a Next.js preview leaves the project's files alone, and sends routes on a change", async () => {
    const fixture = await prepare("next-app");
    const copy = { ...designOf("next-app", fixture.root), id: "next-copy" };
    const read = (file: string) => fs.readFileSync(path.join(fixture.root, file), "utf8");
    const before = { tsconfig: read("tsconfig.json"), env: read("next-env.d.ts") };
    const seen: string[][] = [];
    const off = previews.on(copy.id, (e) => {
      if (e.type === "routes") seen.push(e.routes.map((r) => r.path));
    });
    await previews.ensure(copy);
    const mount = path.join(fixture.root, "app/%5F%5Ffinite/frame/page.tsx");
    expect(fs.existsSync(mount)).toBe(true);
    expect({ tsconfig: read("tsconfig.json"), env: read("next-env.d.ts") }).toEqual(before);
    expect(fs.existsSync(path.join(fixture.root, ".next"))).toBe(false);

    fs.mkdirSync(path.join(fixture.root, "app/contact"));
    fs.writeFileSync(
      path.join(fixture.root, "app/contact/page.tsx"),
      "export default () => <h1>Contact</h1>;\n",
    );
    await expect.poll(() => seen.at(-1), { timeout: 10_000 }).toContain("/contact");
    off();
    await previews.stop(copy.id);
    expect(fs.existsSync(path.join(fixture.root, "app/%5F%5Ffinite"))).toBe(false);
  }, 120_000);

  test("keeps a Next.js frame mount someone edited, and a project's own file where frames go", async () => {
    const fixture = await prepare("next-pages");
    const copy = { ...designOf("next-pages", fixture.root), id: "next-mount" };
    const mount = path.join(fixture.root, "src/pages/__finite/frame.tsx");
    await previews.ensure(copy);
    const edited = `${fs.readFileSync(mount, "utf8")}// mine\n`;
    fs.writeFileSync(mount, edited);
    await previews.stop(copy.id);
    // An edited mount survives the stop, and the next start won't overwrite it.
    expect(fs.readFileSync(mount, "utf8")).toBe(edited);
    await expect(previews.ensure(copy)).rejects.toThrow(/changed since Finite wrote it/);
    expect(fs.readFileSync(mount, "utf8")).toBe(edited);

    // A file Finite never wrote is the project's own, and stays too.
    fs.writeFileSync(mount, "export default () => null;\n");
    await expect(previews.ensure(copy)).rejects.toThrow(/project's own file/);
    expect(fs.readFileSync(mount, "utf8")).toBe("export default () => null;\n");
  }, 120_000);

  test("mounts Next.js file frames inside the route group that holds the root layout", async () => {
    const fixture = await prepare("next-app");
    const at = (file: string) => path.join(fixture.root, file);
    // Only app/(site)/layout.tsx: every page sits in a group with a root layout.
    fs.mkdirSync(at("app/(site)"));
    for (const name of ["page.tsx", "about", "(marketing)", "blog", "docs", "shop"]) {
      fs.renameSync(at(`app/${name}`), at(`app/(site)/${name}`));
    }
    fs.writeFileSync(
      at("app/(site)/layout.tsx"),
      fs.readFileSync(at("app/layout.tsx"), "utf8").replace("./globals.css", "../globals.css"),
    );
    fs.rmSync(at("app/layout.tsx"));
    const copy = { ...designOf("next-app", fixture.root), id: "next-groups" };
    const { url } = await previews.ensure(copy);
    expect(fs.existsSync(at("app/(site)/%5F%5Ffinite/frame/page.tsx"))).toBe(true);
    expect(fs.existsSync(at("app/%5F%5Ffinite"))).toBe(false);
    expect((await get(`${url}/about`)).status).toBe(200);
    const frame = await get(
      `${url}/__finite/frame?file=app%2F_components%2FCounter.tsx&export=Counter`,
    );
    expect(frame.status).toBe(200);
    expect(frame.text).toContain(`data-finite-loc="app/_components/Counter.tsx`);
    expect((await previews.routes(copy.id)).map((r) => r.path)).not.toContain("/__finite/frame");
    await previews.stop(copy.id);
    expect(fs.existsSync(at("app/(site)/%5F%5Ffinite"))).toBe(false);
    expect(fs.existsSync(at("app/(site)/layout.tsx"))).toBe(true);
  }, 120_000);
});
