import { describe, expect, it } from "vite-plus/test";
import { routeHref } from "./routes.ts";

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
