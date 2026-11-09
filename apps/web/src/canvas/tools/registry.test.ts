import { describe, expect, it } from "vite-plus/test";
import type { KeyInput } from "./host";
import { GROUPS, keyHint, resolveKey, shortcutList, TOOLS, toolsIn } from "./registry";
import { dragBox } from "./shapes";

const press = (key: string, mods: Partial<KeyInput> = {}): KeyInput => ({
  key,
  code: "",
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...mods,
});
const page = { source: "page", interact: false, editing: false, vector: false } as const;
const inFrame = { ...page, source: "frame", interact: true } as const;

describe("resolveKey", () => {
  it("finds tools and commands in one table", () => {
    expect(resolveKey(press("v"), page)).toEqual({ kind: "tool", id: "select" });
    expect(resolveKey(press("h"), page)).toEqual({ kind: "tool", id: "hand" });
    expect(resolveKey(press("r"), page)).toEqual({ kind: "tool", id: "rectangle" });
    expect(resolveKey(press("m"), page)).toEqual({ kind: "tool", id: "measure" });
    expect(resolveKey(press("z", { metaKey: true }), page)).toEqual({
      kind: "command",
      id: "undo",
    });
    expect(resolveKey(press("Z", { ctrlKey: true, shiftKey: true }), page)).toEqual({
      kind: "command",
      id: "redo",
    });
    expect(resolveKey({ ...press("!"), code: "Digit1", shiftKey: true }, page)).toEqual({
      kind: "command",
      id: "fitAll",
    });
  });

  it("gives the app in a frame its keys during Interact", () => {
    for (const key of ["v", "c", "i", "Backspace"]) {
      expect(resolveKey(press(key), inFrame)).toBeNull();
    }
    expect(resolveKey({ ...press(" "), code: "Space" }, inFrame)).toBeNull();
  });

  it("still leaves Interact and undoes from a frame", () => {
    expect(resolveKey(press("Escape"), inFrame)).toEqual({ kind: "command", id: "escape" });
    expect(resolveKey(press("z", { metaKey: true }), inFrame)).toEqual({
      kind: "command",
      id: "undo",
    });
  });

  it("takes tool keys from the page even during Interact", () => {
    expect(resolveKey(press("v"), { ...page, interact: true })).toEqual({
      kind: "tool",
      id: "select",
    });
  });

  it("keeps tool keys out of a text editor, and hidden tools off the keyboard", () => {
    expect(resolveKey(press("v"), { ...page, editing: true })).toBeNull();
    expect(resolveKey(press("p"), page)).toBeNull();
    expect(resolveKey(press("a", { shiftKey: true }), page)).toBeNull();
  });
});

describe("the registry", () => {
  it("has no shortcut twice", () => {
    const seen = new Map<string, string>();
    for (const { owner, combo } of shortcutList()) {
      const id = JSON.stringify([combo.key ?? combo.code, !!combo.shift, !!combo.alt, !!combo.mod]);
      expect(seen.get(id), `${owner} and ${seen.get(id)} share ${id}`).toBeUndefined();
      seen.set(id, owner);
    }
  });

  it("lists every tool the toolbar's groups need, each in a group", () => {
    expect(TOOLS.map((t) => t.id)).toEqual([
      "select",
      "hand",
      "scale",
      "interact",
      "frame",
      "section",
      "slice",
      "rectangle",
      "line",
      "arrow",
      "ellipse",
      "polygon",
      "star",
      "image",
      "pen",
      "pencil",
      "text",
      "textOnPath",
      "comment",
      "annotation",
      "measure",
    ]);
    for (const tool of TOOLS) expect(GROUPS).toContain(tool.group);
  });

  it("shows only the tools that work", () => {
    expect(toolsIn("move").map((t) => t.id)).toEqual(["select", "hand", "interact"]);
    expect(toolsIn("shape").map((t) => t.id)).toEqual(["rectangle"]);
    expect(toolsIn("comment").map((t) => t.id)).toEqual(["comment", "measure"]);
    expect(toolsIn("frame")).toEqual([]);
  });

  it("writes a shortcut the way the menu shows it", () => {
    expect(keyHint({ key: "v" })).toBe("V");
    expect(keyHint({ key: "l", shift: true })).toBe("⇧L");
  });
});

describe("dragging out a box", () => {
  const from = { x: 10, y: 10 };

  it("covers the drag in any direction", () => {
    expect(dragBox(from, { x: 30, y: 50 }, false, false)).toEqual({
      x: 10,
      y: 10,
      width: 20,
      height: 40,
    });
    expect(dragBox(from, { x: 0, y: 0 }, false, false)).toEqual({
      x: 0,
      y: 0,
      width: 10,
      height: 10,
    });
  });

  it("squares it with Shift and grows it from the middle with Alt", () => {
    expect(dragBox(from, { x: 30, y: 50 }, true, false)).toMatchObject({ width: 40, height: 40 });
    expect(dragBox(from, { x: 20, y: 20 }, false, true)).toEqual({
      x: 0,
      y: 0,
      width: 20,
      height: 20,
    });
  });
});
