import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { NEXT_PAGE_EXTENSIONS as DEFAULT } from "./adapter.ts";
import { nextRoutes } from "./routes.ts";

const FIXTURES = fileURLToPath(new URL("../../../../apps/server/fixtures/", import.meta.url));

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function project(files: string[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "finite-next-"));
  dirs.push(root);
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), "export default function Page() {}\n");
  }
  return root;
}

describe("nextRoutes", () => {
  test("reads the App Router fixture's pages", async () => {
    expect(await nextRoutes(path.join(FIXTURES, "next-app"), DEFAULT)).toEqual([
      { path: "/", file: "app/page.tsx", params: [] },
      { path: "/pricing", file: "app/(marketing)/pricing/page.tsx", params: [] },
      { path: "/about", file: "app/about/page.tsx", params: [] },
      { path: "/blog/[slug]", file: "app/blog/[slug]/page.tsx", params: ["slug"] },
      { path: "/docs/[...slug]", file: "app/docs/[...slug]/page.tsx", params: ["slug"] },
      { path: "/shop/[[...slug]]", file: "app/shop/[[...slug]]/page.tsx", params: ["slug"] },
    ]);
  });

  test("reads the Pages Router fixture's pages under src/", async () => {
    expect(await nextRoutes(path.join(FIXTURES, "next-pages"), DEFAULT)).toEqual([
      { path: "/about", file: "src/pages/about.tsx", params: [] },
      { path: "/", file: "src/pages/index.tsx", params: [] },
      { path: "/posts/[id]", file: "src/pages/posts/[id].tsx", params: ["id"] },
    ]);
  });

  test("skips slots, intercepts, private folders and Finite's mount", async () => {
    const root = project([
      "app/page.tsx",
      "app/@modal/page.tsx",
      "app/@modal/(.)photo/[id]/page.tsx",
      "app/@modal/login/page.tsx",
      "app/photo/[id]/page.tsx",
      "app/_lib/page.tsx",
      "app/%5Fprivate/page.mdx",
      "app/%5F%5Ffinite/page.tsx",
      "app/settings/route.ts",
      "app/settings/opengraph-image.tsx",
      "app/team/page.module.css",
      "app/team/page.tsx",
    ]);
    expect((await nextRoutes(root, [...DEFAULT, "mdx"])).map((route) => route.path)).toEqual([
      "/",
      "/_private",
      "/photo/[id]",
      "/team",
      "/login",
    ]);
  });

  test("lists both routers, and root folders win over src/", async () => {
    const root = project([
      "app/page.tsx",
      "pages/index.tsx",
      "pages/legacy/index.jsx",
      "pages/api/hello.ts",
      "src/app/ignored/page.tsx",
    ]);
    expect(await nextRoutes(root, DEFAULT)).toEqual([
      { path: "/", file: "app/page.tsx", params: [] },
      { path: "/legacy", file: "pages/legacy/index.jsx", params: [] },
    ]);
  });

  test("takes only files with one of the config's pageExtensions as pages", async () => {
    const root = project([
      "pages/index.page.tsx",
      "pages/_app.page.tsx",
      "pages/about.page.tsx",
      "pages/about.test.tsx",
      "pages/posts/[id].page.tsx",
      "pages/posts/Card.tsx",
      "pages/notes.mdx",
      "app/page.tsx",
      "app/shop/page.page.tsx",
      "app/team/page",
    ]);
    expect(await nextRoutes(root, ["page.tsx", "mdx"])).toEqual([
      { path: "/shop", file: "app/shop/page.page.tsx", params: [] },
      { path: "/about", file: "pages/about.page.tsx", params: [] },
      { path: "/", file: "pages/index.page.tsx", params: [] },
      { path: "/notes", file: "pages/notes.mdx", params: [] },
      { path: "/posts/[id]", file: "pages/posts/[id].page.tsx", params: ["id"] },
    ]);
  });
});
