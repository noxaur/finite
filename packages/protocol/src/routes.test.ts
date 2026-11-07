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

  it("adds the leading slash", () => {
    expect(routeHref("about", {})).toBe("/about");
    expect(routeHref("/", {})).toBe("/");
  });
});
