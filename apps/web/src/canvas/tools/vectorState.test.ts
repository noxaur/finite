import type { FrameBridge, SourceEdit } from "@finite/protocol";
import { describe, expect, it } from "vite-plus/test";
import { parsePath } from "../../design/vector/path";
import type { ToolHost } from "./host";
import { commit, editPending, type VectorEditing, vectorEditing } from "./vectorState";

const A = "src/a.tsx:3:4";
const B = "src/b.tsx:3:4";

const session = (loc: string, rev: string): VectorEditing => ({
  frameId: "frame",
  loc,
  index: 0,
  rev,
  ctm: [1, 0, 0, 1, 0, 0],
  paths: parsePath("M0 0L5 0"),
  picked: [],
  printed: "M0 0L5 0",
});

const until = async (done: () => boolean) => {
  for (let i = 0; i < 200 && !done(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(done()).toBe(true);
};

function fakeHost(revs: Record<string, string>) {
  const edits: SourceEdit[] = [];
  const answers: Array<(value: { created: Record<string, string> }) => void> = [];
  const bridge = {
    inspect: async (loc: string) => ({ rev: revs[loc], tag: "path" }),
    vector: async () => ({ d: vectorEditing.get()?.printed ?? "", ctm: [1, 0, 0, 1, 0, 0] }),
    preview: () => {},
  } as unknown as FrameBridge;
  const host = {
    bridge: () => bridge,
    edit: (next: SourceEdit[]) => {
      edits.push(...next);
      return new Promise((resolve) => answers.push(resolve));
    },
  } as unknown as ToolHost;
  return { host, edits, answers };
}

describe("queued path edits", () => {
  it("still go to the path they were made on after vector edit moves to another", async () => {
    const revs: Record<string, string> = { [A]: "a1", [B]: "b1" };
    const { host, edits, answers } = fakeHost(revs);
    vectorEditing.set(session(A, "a1"));
    commit(host, parsePath("M0 0L10 0"), []);
    commit(host, parsePath("M0 0L20 0"), []);
    await until(() => edits.length === 1);

    vectorEditing.set(session(B, "b1"));
    revs[A] = "a2";
    answers[0]!({ created: {} });
    await until(() => edits.length === 2);

    expect(edits[1]).toEqual({
      kind: "attr",
      loc: A,
      name: "d",
      value: "M0 0L20 0",
      revs: { "src/a.tsx": "a2" },
    });
    revs[A] = "a3";
    answers[1]!({ created: {} });
    await until(() => !editPending());
    expect(vectorEditing.get()?.loc).toBe(B);
    expect(vectorEditing.get()?.rev).toBe("b1");
    vectorEditing.set(null);
  });
});
