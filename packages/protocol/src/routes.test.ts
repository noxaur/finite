import { describe, expect, it } from "vite-plus/test";
import { frameHref, routeHref } from "./routes.ts";

describe("routeHref", () => {
  it("fills React Router and TanStack params", () => {
    expect(routeHref("/users/:id", { id: "7" })).toBe("/users/7");
    expect(routeHref("/users/$id", { id: "a b" })).toBe("/users/a%20b");
    expect(routeHref("/posts/{$id}", { id: "42" })).toBe("/posts/42");
    expect(routeHref("/posts/{-$id}", { id: "42" })).toBe("/posts/42");
    expect(routeHref("/posts/:id?", { id: "42" })).toBe("/posts/42");
  });

  it("keeps a splat's slashes", () => {
    expect(routeHref("/posts/$postId/$", { postId: "7", _splat: "a/b" })).toBe("/posts/7/a/b");
    expect(routeHref("/files/*", { "*": "x/y z" })).toBe("/files/x/y%20z");
  });

  it("drops unfilled optional segments and keeps unfilled required ones", () => {
    expect(routeHref("/posts/{-$id}", {})).toBe("/posts");
    expect(routeHref("/posts/:id?/edit", {})).toBe("/posts/edit");
    expect(routeHref("/files/$", {})).toBe("/files");
    expect(routeHref("/users/:id", {})).toBe("/users/:id");
  });

  it("fills Next.js dynamic and catch-all segments", () => {
    expect(routeHref("/blog/[slug]", { slug: "hello world" })).toBe("/blog/hello%20world");
    expect(routeHref("/docs/[...slug]", { slug: "a/b c" })).toBe("/docs/a/b%20c");
    expect(routeHref("/shop/[[...slug]]", { slug: "shoes/red" })).toBe("/shop/shoes/red");
    expect(routeHref("/shop/[[...slug]]", {})).toBe("/shop");
    expect(routeHref("/[[...slug]]", {})).toBe("/");
    expect(routeHref("/docs/[...slug]", {})).toBe("/docs/[...slug]");
    expect(routeHref("/blog/[slug]", {})).toBe("/blog/[slug]");
  });

  it("adds the leading slash", () => {
    expect(routeHref("about", {})).toBe("/about");
    expect(routeHref("/", {})).toBe("/");
  });
});

describe("frameHref", () => {
  it("loads a route with its params filled in", () => {
    expect(
      frameHref("http://127.0.0.1:5173/", {
        kind: "route",
        path: "/users/:id/$tab",
        params: { id: "4 2", tab: "posts" },
      }),
    ).toBe("http://127.0.0.1:5173/users/4%202/posts");
    expect(frameHref("http://127.0.0.1:5173", { kind: "route", path: "/" })).toBe(
      "http://127.0.0.1:5173/",
    );
  });

  it("loads one file's export through the plugin's frame page", () => {
    expect(
      frameHref("http://127.0.0.1:5173", {
        kind: "file",
        file: ".finite/boards/c1/Card.tsx",
        exportName: "Card",
      }),
    ).toBe(
      "http://127.0.0.1:5173/__finite/frame?file=.finite%2Fboards%2Fc1%2FCard.tsx&export=Card",
    );
  });

  it("puts routes and file frames under a Next.js basePath", () => {
    const base = "http://127.0.0.1:5000/docs";
    expect(frameHref(base, { kind: "route", path: "/posts/[id]", params: { id: "7" } })).toBe(
      "http://127.0.0.1:5000/docs/posts/7",
    );
    expect(frameHref(base, { kind: "route", path: "/" })).toBe(base);
    expect(frameHref(`${base}/`, { kind: "file", file: "src/Card.tsx" })).toBe(
      "http://127.0.0.1:5000/docs/__finite/frame?file=src%2FCard.tsx",
    );
  });
});
