import { expect, it } from "vite-plus/test";
import { fileName } from "./file-name.ts";

it("names a saved selection .figma.json", () => {
  expect(fileName("Landing page")).toBe("Landing page.figma.json");
});

it("replaces characters a file name can't have", () => {
  expect(fileName("a/b: c?")).toBe("a-b- c-.figma.json");
  expect(fileName("  ")).toBe("selection.figma.json");
});
