import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { findAppIcon } from "./appIcon.ts";

let tmp: string;
let root: string;
beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "finite-icon-")));
  root = path.join(tmp, "app");
  await fs.mkdir(root);
});
afterEach(() => fs.rm(tmp, { recursive: true, force: true }));

async function put(file: string, data: string | Buffer = "x", base = root) {
  const full = path.join(base, file);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, data);
  return full;
}

const html = (...links: string[]) => put("index.html", `<head>${links.join("\n")}</head>`);

describe("findAppIcon", () => {
  it("follows the icon index.html links, root-relative from public/ first", async () => {
    await html('<link rel="icon" href="/logo.png">');
    await put("logo.png");
    const inPublic = await put("public/logo.png");
    expect(await findAppIcon(root)).toBe(inPublic);
  });

  it("falls back to the root for a root-relative href, and resolves a relative one there", async () => {
    await html('<link rel="icon" href="/a.png">', '<link rel="icon" href="img/b.webp">');
    const a = await put("a.png");
    expect(await findAppIcon(root)).toBe(a);
    await fs.rm(a);
    const want1 = await put("img/b.webp");
    expect(await findAppIcon(root)).toBe(want1);
  });

  it("reads attributes in any order with either quote, and strips the query, hash and base", async () => {
    await html("<link href='%BASE_URL%mark.png?v=3#x' type=\"image/png\" rel='shortcut icon'>");
    const want2 = await put("public/mark.png");
    expect(await findAppIcon(root)).toBe(want2);
  });

  it("prefers an svg, then an apple-touch-icon, then the first", async () => {
    await html(
      '<link rel="icon" href="/first.png">',
      '<link rel="apple-touch-icon" href="/touch.png">',
    );
    await put("public/first.png");
    const touch = await put("public/touch.png");
    expect(await findAppIcon(root)).toBe(touch);
    await html(
      '<link rel="icon" href="/first.png">',
      '<link rel="apple-touch-icon" href="/touch.png">',
      '<link rel="icon" href="/mark.svg">',
    );
    const want3 = await put("public/mark.svg");
    expect(await findAppIcon(root)).toBe(want3);
  });

  it("uses Next's app/ icon, then src/app/, and icon before favicon.ico", async () => {
    await put("src/app/icon.png");
    const favicon = await put("app/favicon.ico");
    expect(await findAppIcon(root)).toBe(favicon);
    const icon = await put("app/icon.svg");
    expect(await findAppIcon(root)).toBe(icon);
    await fs.rm(path.join(root, "app"), { recursive: true });
    expect(await findAppIcon(root)).toBe(path.join(root, "src/app/icon.png"));
  });

  it("looks for the common names in public/ in order", async () => {
    await put("public/favicon.ico");
    expect(await findAppIcon(root)).toBe(path.join(root, "public/favicon.ico"));
    await put("public/logo.png");
    expect(await findAppIcon(root)).toBe(path.join(root, "public/logo.png"));
    await put("public/favicon.svg");
    expect(await findAppIcon(root)).toBe(path.join(root, "public/favicon.svg"));
  });

  it("ignores external and data hrefs", async () => {
    await html(
      '<link rel="icon" href="https://x.test/a.png">',
      '<link rel="icon" href="http://x.test/a.png">',
      '<link rel="icon" href="//x.test/a.png">',
      '<link rel="icon" href="data:image/png;base64,AAAA">',
    );
    expect(await findAppIcon(root)).toBeUndefined();
  });

  it("won't serve a file outside the root, by .. or a symlink", async () => {
    await html('<link rel="icon" href="../outside.png">');
    await put("outside.png", "x", tmp);
    expect(await findAppIcon(root)).toBeUndefined();

    await fs.mkdir(path.join(root, "public"));
    await fs.symlink(path.join(tmp, "outside.png"), path.join(root, "public/favicon.png"));
    expect(await findAppIcon(root)).toBeUndefined();
  });

  it("skips a file that is too big, the wrong type or a folder, and moves on", async () => {
    await html(
      '<link rel="icon" href="/big.png">',
      '<link rel="icon" href="/notes.txt">',
      '<link rel="icon" href="/dir.png">',
    );
    await put("public/big.png", Buffer.alloc(1024 * 1024 + 1));
    await put("public/notes.txt");
    await fs.mkdir(path.join(root, "public/dir.png"));
    expect(await findAppIcon(root)).toBeUndefined();
    const fallback = await put("public/icon.svg");
    expect(await findAppIcon(root)).toBe(fallback);
  });

  it("treats vite.svg as the template's placeholder and falls through", async () => {
    await html('<link rel="icon" type="image/svg+xml" href="/vite.svg">');
    await put("public/vite.svg");
    expect(await findAppIcon(root)).toBeUndefined();
    const logo = await put("public/logo.svg");
    expect(await findAppIcon(root)).toBe(logo);
  });

  it("finds nothing in an empty folder or a missing root", async () => {
    expect(await findAppIcon(root)).toBeUndefined();
    expect(await findAppIcon(path.join(tmp, "nope"))).toBeUndefined();
  });
});
