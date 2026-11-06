import { describe, expect, expectTypeOf, it } from "vite-plus/test";
import {
  type Canvas,
  type CanvasPatch,
  type Params,
  ParentMessage,
  parseClientMessage,
  type Result,
} from "./index.ts";

describe("parseClientMessage", () => {
  it("accepts a valid request", () => {
    const parsed = parseClientMessage(
      JSON.stringify({ type: "hello", rid: "1", user: { id: "u", name: "Per" } }),
    );
    expect(parsed).toEqual({
      ok: true,
      message: { type: "hello", rid: "1", user: { id: "u", name: "Per" } },
    });
  });

  it("names the field that's wrong", () => {
    const parsed = parseClientMessage({
      type: "canvas.patch",
      rid: "2",
      designId: "d",
      canvasId: "c",
      patch: { op: "moveFrames", frames: [{ id: "f", x: "left", y: 0 }] },
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.rid).toBe("2");
    expect(parsed.reason).toMatch(/^canvas\.patch: patch\.frames\.0\.x: .*number/);
  });

  it("refuses unknown types and non-JSON", () => {
    expect(parseClientMessage({ type: "nope", rid: "3" })).toEqual({
      ok: false,
      rid: "3",
      reason: 'unknown message type "nope"',
    });
    expect(parseClientMessage("{")).toEqual({ ok: false, reason: "message isn't JSON" });
  });

  it("needs exactly one thread target on thread.send", () => {
    const base = {
      type: "thread.send",
      rid: "4",
      designId: "d",
      text: "hi",
      attachments: [],
      model: "opus",
      fast: false,
      mode: "steer",
    };
    expect(parseClientMessage(base)).toMatchObject({
      ok: false,
      reason: "thread.send: thread.send needs exactly one of threadId and new",
    });
    expect(parseClientMessage({ ...base, new: {} }).ok).toBe(true);
    expect(parseClientMessage({ ...base, new: {}, threadId: "t" }).ok).toBe(false);
  });

  it("checks locs and revs", () => {
    const edit = (loc: string, rev: string) =>
      parseClientMessage({
        type: "source.edit",
        rid: "5",
        designId: "d",
        canvasId: "c",
        edits: [{ kind: "text", loc, tag: "h1", text: "Hi", revs: { "src/App.tsx": rev } }],
      });
    expect(edit("src/App.tsx:12:4", "0a1b2c3d").ok).toBe(true);
    expect(edit("src/App.tsx", "0a1b2c3d")).toMatchObject({
      ok: false,
      reason: expect.stringContaining("edits.0.loc"),
    });
    expect(edit("src/App.tsx:1:1", "xyz").ok).toBe(false);
  });
});

describe("thread.send", () => {
  it("starts a prototype and carries a whole selected frame", () => {
    const parsed = parseClientMessage({
      type: "thread.send",
      rid: "6",
      designId: "d",
      new: { prototype: true },
      text: "Make a pricing card",
      attachments: [],
      selection: [{ frameId: "f1" }, { frameId: "f2", loc: "src/A.tsx:3:2", index: 1 }],
      model: "opus",
      fast: false,
      mode: "steer",
    });
    expect(parsed).toMatchObject({ ok: true, message: { new: { prototype: true } } });
  });
});

describe("bridge messages", () => {
  it("parses requests from the parent", () => {
    expect(ParentMessage.safeParse({ type: "hit", id: 1, x: 3, y: 4 }).success).toBe(true);
    expect(ParentMessage.safeParse({ type: "hit", id: 1, x: 3 }).success).toBe(false);
  });
});

describe("request map", () => {
  it("types params and results per request", () => {
    expectTypeOf<Params<"canvas.patch">>().toEqualTypeOf<{
      designId: string;
      canvasId: string;
      patch: CanvasPatch;
    }>();
    expectTypeOf<Result<"canvas.patch">>().toEqualTypeOf<Canvas>();
    expectTypeOf<Result<"source.edit">>().toEqualTypeOf<{ remap: Record<string, string> }>();
  });
});
