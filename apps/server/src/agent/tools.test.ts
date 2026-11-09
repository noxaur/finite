import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Actor, Frame, Previews, SourceEditor } from "@finite/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { openDesign, type OpenedDesign } from "../store/open.ts";
import type { Screenshots } from "./screenshot.ts";
import { canvasOps, DEFAULT_SIZE, frameSize, MIN_HUG } from "./tools.ts";

describe("frameSize", () => {
  const measured = (size: { width: number; height: number }) => {
    const asked: (number | undefined)[] = [];
    const measure = async (width: number | undefined) => {
      asked.push(width);
      return size;
    };
    return { asked, measure };
  };

  it("gives a component its natural size, but never below the minimum", async () => {
    const card = measured({ width: 384, height: 452 });
    expect(await frameSize({}, card.measure)).toEqual({ width: 384, height: 452 });
    expect(card.asked).toEqual([undefined]);
    const button = measured({ width: 120, height: 40 });
    expect(await frameSize({}, button.measure)).toEqual(MIN_HUG);
  });

  it("keeps a page's width and measures its height at that width", async () => {
    const page = measured({ width: 1440, height: 2100 });
    expect(await frameSize({ width: 1440 }, page.measure)).toEqual({ width: 1440, height: 2100 });
    expect(page.asked).toEqual([1440]);
  });

  it("uses a given size as is, and a default when measuring fails", async () => {
    const never = measured({ width: 1, height: 1 });
    expect(await frameSize({ width: 800, height: 600 }, never.measure)).toEqual({
      width: 800,
      height: 600,
    });
    expect(never.asked).toEqual([]);
    const fail = async () => {
      throw new Error("no Chrome");
    };
    expect(await frameSize({}, fail)).toEqual(DEFAULT_SIZE);
    expect(await frameSize({ width: 390 }, fail)).toEqual({
      width: 390,
      height: DEFAULT_SIZE.height,
    });
  });
});

describe("canvas objects", () => {
  const person: Actor = { kind: "person", id: "u1", name: "Per" };
  const agent: Actor = { kind: "agent", id: "t1", name: "Claude" };
  let root: string;
  let open: OpenedDesign;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "finite-ops-"));
    open = await openDesign({
      id: "d1",
      name: "Shop",
      root,
      origin: "blank",
      router: "none",
      styling: "inline",
      css: [],
      brandDir: "src/assets/brand",
    });
  });
  afterEach(async () => {
    open.close();
    await rm(root, { recursive: true, force: true });
  });

  const capture = vi.fn(async () => new Uint8Array([1]));
  const opsFor = (actor: Actor) =>
    canvasOps({
      open,
      actor,
      previews: {
        ensure: async () => ({ url: "http://frame" }),
        frameUrl: () => "http://frame/x",
      } as unknown as Previews,
      source: {} as SourceEditor,
      screenshots: { capture } as unknown as Screenshots,
    });
  const frame = (id: string, x: number): Frame => ({
    id,
    name: id,
    x,
    y: 100,
    width: 300,
    height: 200,
    source: { kind: "route", path: "/" },
  });

  async function canvasWithFrames(kind: "page" | "prototype") {
    const c = await open.createCanvas({ kind, name: "Flows" }, person);
    await open.patchCanvas(
      c.id,
      { op: "addFrames", frames: [frame("a", 0), frame("b", 380)] },
      person,
    );
    return c.id;
  }

  it("sizes a section around frames and their labels, then changes and removes it", async () => {
    const canvasId = await canvasWithFrames("prototype");
    const ops = opsFor(agent);
    const made = await ops.writeSection({ canvasId, name: "Onboarding", frameIds: ["a", "b"] });
    // The frames' union (0..680 by 100..300), the label 120 above, and 40 around.
    expect(made).toMatchObject({ x: -40, y: -60, width: 760, height: 400 });
    const [section] = (await open.canvases()).find((c) => c.id === canvasId)!.sections;
    expect(section).toMatchObject({ id: made.sectionId, name: "Onboarding", author: agent });

    const moved = await ops.writeSection({ canvasId, sectionId: made.sectionId, x: 0, y: 0 });
    expect(moved).toMatchObject({ x: 0, y: 0, width: 760, height: 400 });
    expect(ops.describe((await open.canvases()).find((c) => c.id === canvasId)!).sections).toEqual([
      { id: made.sectionId, name: "Onboarding", x: 0, y: 0, width: 760, height: 400 },
    ]);

    await ops.writeSection({ canvasId, sectionId: made.sectionId, remove: true });
    const after = (await open.canvases()).find((c) => c.id === canvasId)!;
    expect(after.sections).toEqual([]);
    expect(after.frames).toHaveLength(2);
    // The agent's own canvas undo brings the section back.
    await open.undoCanvas(canvasId, agent);
    expect((await open.canvases()).find((c) => c.id === canvasId)!.sections).toHaveLength(1);
  });

  it("refuses what it can't place, and leaves a person's section on a page alone", async () => {
    const canvasId = await canvasWithFrames("page");
    const ops = opsFor(agent);
    await expect(ops.writeSection({ canvasId, name: "Flow" })).rejects.toThrow(/x, y, width/);
    await expect(ops.writeSection({ canvasId, frameIds: ["a"] })).rejects.toThrow(/needs a name/);
    await expect(ops.writeSection({ canvasId, name: "Flow", frameIds: ["gone"] })).rejects.toThrow(
      /no frame gone/i,
    );
    await expect(ops.writeSection({ canvasId, sectionId: "nope", remove: true })).rejects.toThrow(
      /no section nope/i,
    );
    await open.patchCanvas(
      canvasId,
      {
        op: "setSection",
        section: { id: "mine", name: "Mine", x: 0, y: 0, width: 100, height: 100, author: person },
      },
      person,
    );
    await expect(ops.writeSection({ canvasId, sectionId: "mine", remove: true })).rejects.toThrow(
      /wasn't made by this thread/,
    );
  });

  it("leaves an annotation that describe marks, and crops a screenshot to a region", async () => {
    const canvasId = await canvasWithFrames("prototype");
    const ops = opsFor(agent);
    const { commentId } = await ops.comment({ frameId: "a", text: "8pt grid", annotation: true });
    await ops.comment({ frameId: "a", text: "Is this right?" });
    const canvas = (await open.canvases()).find((c) => c.id === canvasId)!;
    expect(canvas.comments.find((c) => c.id === commentId)).toMatchObject({ kind: "annotation" });
    expect(ops.describe(canvas).comments.map((c) => c.kind)).toEqual(["annotation", undefined]);

    await ops.screenshot("a", { x: 10, y: 20, width: 100, height: 50 });
    expect(capture).toHaveBeenLastCalledWith("http://frame/x", 300, 200, {
      x: 10,
      y: 20,
      width: 100,
      height: 50,
    });
    await ops.screenshot("a", { x: 250, y: 0, width: 400, height: 50 });
    expect(capture).toHaveBeenLastCalledWith("http://frame/x", 300, 200, {
      x: 250,
      y: 0,
      width: 50,
      height: 50,
    });
    await expect(ops.screenshot("a", { x: 300, y: 0, width: 10, height: 10 })).rejects.toThrow(
      /past the right edge/,
    );
    await ops.screenshot("a");
    expect(capture).toHaveBeenLastCalledWith("http://frame/x", 300, 200, undefined);
  });

  it("refuses a screenshot region below a fixed-height frame, and lets a hugging frame grow", async () => {
    const canvasId = await canvasWithFrames("prototype");
    await open.patchCanvas(
      canvasId,
      { op: "addFrames", frames: [{ ...frame("h", 800), hug: true }] },
      person,
    );
    const ops = opsFor(agent);
    capture.mockClear();
    await expect(ops.screenshot("a", { x: 0, y: 400, width: 100, height: 50 })).rejects.toThrow(
      /past the bottom of .* \(300×200\)/,
    );
    // Starting inside, but ending below, is refused too; ending on the edge is fine.
    await expect(ops.screenshot("a", { x: 0, y: 180, width: 100, height: 50 })).rejects.toThrow(
      /past the bottom/,
    );
    await ops.screenshot("a", { x: 0, y: 150, width: 100, height: 50 });
    expect(capture).toHaveBeenCalledTimes(1);

    await ops.screenshot("h", { x: 0, y: 400, width: 100, height: 50 });
    expect(capture).toHaveBeenLastCalledWith("http://frame/x", 300, 200, {
      x: 0,
      y: 400,
      width: 100,
      height: 50,
    });
  });
});
