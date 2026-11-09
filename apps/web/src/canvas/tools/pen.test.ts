import { describe, expect, it } from "vite-plus/test";
import type { ToolHost } from "./host";
import { pen } from "./pen";
import { penDraft } from "./vectorState";

const draft = {
  closed: false,
  anchors: [{ p: { x: 0, y: 0 }, in: null, out: null, mode: "none" as const }],
};
const host = () => ({}) as ToolHost;

describe("the pen's draft", () => {
  it("survives the tool being picked again, as a held key does", () => {
    const one = host();
    pen.activate(one);
    penDraft.set(draft);
    pen.activate(one);
    expect(penDraft.get()).toBe(draft);
    penDraft.set(null);
  });

  it("doesn't follow the person to another canvas", () => {
    const one = host();
    pen.activate(one);
    penDraft.set(draft);
    pen.activate(host());
    expect(penDraft.get()).toBeNull();
  });
});
