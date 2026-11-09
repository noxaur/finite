import type { Canvas, OpenDesign, Previews } from "@finite/protocol";
import { describe, expect, it, vi } from "vite-plus/test";
import type { Screenshots } from "../agent/screenshot.ts";
import { exportSlice } from "./sliceExport.ts";

const frame = {
  id: "f1",
  name: "Home",
  x: 500,
  y: 500,
  width: 400,
  height: 300,
  source: { kind: "route" as const, path: "/" },
};
const canvas = (over: Partial<Canvas> = {}): Canvas => ({
  id: "c1",
  kind: "page",
  name: "Flows",
  threadIds: [],
  frames: [frame],
  texts: [],
  comments: [],
  sections: [],
  slices: [{ id: "s1", frameId: "f1", name: "Hero", x: 20, y: 30, width: 200, height: 100 }],
  updatedAt: 0,
  ...over,
});
const open = (c: Canvas) =>
  ({ design: { id: "d1" }, canvases: async () => [c] }) as unknown as OpenDesign;

function renderer() {
  const capture = vi.fn(async () => new Uint8Array([137, 80, 78, 71]));
  const ensure = vi.fn(async () => ({ url: "http://preview" }));
  const frameUrl = vi.fn(() => "http://preview/f1");
  return {
    capture,
    ensure,
    render: {
      previews: { ensure, frameUrl } as unknown as Previews,
      screenshots: { capture } as unknown as Screenshots,
    },
  };
}

describe("exportSlice", () => {
  it("crops the frame to the slice, in the frame's own pixels, and returns a PNG data URL", async () => {
    const r = renderer();
    const { url } = await exportSlice(r.render, open(canvas()), { canvasId: "c1", sliceId: "s1" });
    expect(r.ensure).toHaveBeenCalled();
    expect(r.capture).toHaveBeenCalledWith("http://preview/f1", 400, 300, {
      x: 20,
      y: 30,
      width: 200,
      height: 100,
    });
    expect(url).toBe(`data:image/png;base64,${Buffer.from([137, 80, 78, 71]).toString("base64")}`);
  });

  it("shifts a slice inside a frame that was narrowed since, as the page draws it", async () => {
    const r = renderer();
    const slices = [
      { id: "s1", frameId: "f1", name: "Hero", x: 300, y: 30, width: 100, height: 100 },
    ];
    const narrow = canvas({ frames: [{ ...frame, width: 200 }], slices });
    await exportSlice(r.render, open(narrow), { canvasId: "c1", sliceId: "s1" });
    expect(r.capture).toHaveBeenCalledWith("http://preview/f1", 200, 300, {
      x: 100,
      y: 30,
      width: 100,
      height: 100,
    });
  });

  it("keeps a slice inside a frame that was shortened, and leaves a hugging frame's height open", async () => {
    const r = renderer();
    const slices = [
      { id: "s1", frameId: "f1", name: "Hero", x: 20, y: 250, width: 200, height: 100 },
    ];
    const short = canvas({ frames: [{ ...frame, height: 200 }], slices });
    await exportSlice(r.render, open(short), { canvasId: "c1", sliceId: "s1" });
    expect(r.capture).toHaveBeenLastCalledWith("http://preview/f1", 400, 200, {
      x: 20,
      y: 100,
      width: 200,
      height: 100,
    });

    const hug = canvas({ frames: [{ ...frame, height: 200, hug: true }], slices });
    await exportSlice(r.render, open(hug), { canvasId: "c1", sliceId: "s1" });
    expect(r.capture).toHaveBeenLastCalledWith("http://preview/f1", 400, 200, {
      x: 20,
      y: 250,
      width: 200,
      height: 100,
    });
  });

  it("says why it can't: no slice, no frame, no browser", async () => {
    const r = renderer();
    await expect(
      exportSlice(r.render, open(canvas()), { canvasId: "c1", sliceId: "nope" }),
    ).rejects.toMatchObject({ code: "not-found" });
    await expect(
      exportSlice(r.render, open(canvas({ frames: [] })), { canvasId: "c1", sliceId: "s1" }),
    ).rejects.toMatchObject({ code: "not-found", message: expect.stringContaining("Undo") });
    await expect(
      exportSlice(undefined, open(canvas()), { canvasId: "c1", sliceId: "s1" }),
    ).rejects.toMatchObject({ code: "not-implemented" });
  });
});
