import { z } from "zod";

/** A box in a frame's own CSS pixels. */
const Region = z.object({
  x: z.number().min(0),
  y: z.number().min(0),
  width: z.number().positive(),
  height: z.number().positive(),
});

/**
 * Input shapes of the canvas tools agents call through the `finite` MCP server. They're raw zod
 * shapes because the Agent SDK's `tool(name, description, shape, handler)` takes one.
 */
export const canvasTools = {
  read_canvas: { canvasId: z.string().optional() },
  open_canvas: { name: z.string().min(1) },
  place_frames: {
    canvasId: z.string(),
    frames: z
      .array(
        z.object({
          file: z.string(),
          name: z.string(),
          title: z.string(),
          why: z.string(),
          width: z.number().positive().optional(),
          height: z.number().positive().optional(),
        }),
      )
      .min(1),
    rightOf: z.string().optional(),
  },
  remove_frames: { canvasId: z.string(), frameIds: z.array(z.string()).min(1) },
  write_text: {
    canvasId: z.string(),
    textId: z.string().optional(),
    title: z.string(),
    body: z.string(),
    x: z.number().optional(),
    y: z.number().optional(),
    width: z.number().positive().optional(),
  },
  comment: {
    frameId: z.string(),
    /** `file:line:col` (col = 0-based column of the `<`), `file:line`, or `file` with `match`. */
    loc: z.string().optional(),
    /** Text the element shows (its words, alt or aria-label), to find it on `line` or in `file`. */
    match: z.string().optional(),
    /** Which rendered instance of `loc` (from a selection), default 0. */
    index: z.number().int().min(0).optional(),
    text: z.string().min(1),
    /** Leaves a note that stays on the canvas, for people. No agent is asked to act on it. */
    annotation: z.boolean().optional(),
  },
  write_section: {
    canvasId: z.string(),
    /** Changes or removes this section. Leave it out to make one. */
    sectionId: z.string().optional(),
    name: z.string().min(1).optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    width: z.number().positive().optional(),
    height: z.number().positive().optional(),
    /** Sizes a new section around these frames (and their labels) when x, y, width, height are left out. */
    frameIds: z.array(z.string()).min(1).optional(),
    /** Removes `sectionId`. The frames in it stay. */
    remove: z.boolean().optional(),
  },
  copy_production: {
    canvasId: z.string(),
    name: z.string().optional(),
    route: z.string().optional(),
  },
  move_to_prod: { frameIds: z.array(z.string()).min(1) },
  add_brand_asset: {
    path: z.string().optional(),
    url: z.string().optional(),
  },
  spawn_thread: { prompt: z.string().min(1), canvasId: z.string().optional() },
  name_thread: { title: z.string().min(1) },
  screenshot: { frameId: z.string(), region: Region.optional() },
  frame_errors: { frameId: z.string() },
  finish_setup: {},
} as const satisfies Record<string, z.ZodRawShape>;

const elementOp = { frameId: z.string(), select: z.string().min(1) };
const onCanvas = { canvasId: z.string().optional() };
const { canvasId: _textCanvas, ...textFields } = canvasTools.write_text;
const { canvasId: _sectionCanvas, ...sectionFields } = canvasTools.write_section;

/** One step of the `/mcp` `edit` tool. */
export const editOp = z.discriminatedUnion("op", [
  z.object({ op: z.literal("canvas"), name: z.string().min(1) }),
  z.object({
    op: z.literal("write"),
    ...onCanvas,
    file: z.string().min(1),
    content: z.string().min(1),
  }),
  z.object({
    op: z.literal("place"),
    ...onCanvas,
    frames: canvasTools.place_frames.frames,
    rightOf: z.string().optional(),
  }),
  z.object({
    op: z.literal("remove_frames"),
    ...onCanvas,
    frameIds: canvasTools.remove_frames.frameIds,
  }),
  z.object({ op: z.literal("text"), ...onCanvas, ...textFields }),
  z.object({ op: z.literal("section"), ...onCanvas, ...sectionFields }),
  z.object({
    op: z.literal("copy_production"),
    ...onCanvas,
    name: z.string().optional(),
    route: z.string().optional(),
  }),
  z.object({
    op: z.literal("brand_asset"),
    path: z.string().optional(),
    url: z.string().optional(),
  }),
  z.object({
    op: z.literal("token"),
    name: z.string().min(1),
    mode: z.enum(["light", "dark"]),
    value: z.string().nullable(),
  }),
  z.object({
    op: z.literal("style"),
    ...elementOp,
    styles: z.record(z.string(), z.string().nullable()),
  }),
  z.object({ op: z.literal("content"), ...elementOp, text: z.string() }),
  z.object({
    op: z.literal("attr"),
    ...elementOp,
    name: z.string().min(1),
    value: z.string().nullable(),
  }),
  z.object({ op: z.literal("remove"), ...elementOp }),
  z.object({ op: z.literal("duplicate"), ...elementOp }),
  z.object({ op: z.literal("reorder"), ...elementOp, before: z.string().min(1).nullable() }),
]);
export type EditOp = z.infer<typeof editOp>;

/** Input shapes of the six tools external agents call at `/mcp`. */
export const mcpTools = {
  designs: {
    action: z.enum(["list", "create", "connect", "rename", "remove"]).optional(),
    designId: z.string().optional(),
    name: z.string().min(1).optional(),
    path: z.string().min(1).optional(),
    offset: z.number().int().min(0).optional(),
  },
  read: {
    designId: z.string(),
    canvasId: z.string().optional(),
    frameId: z.string().optional(),
    select: z.string().min(1).optional(),
    file: z.string().min(1).optional(),
    what: z.enum(["tokens", "components", "routes"]).optional(),
    offset: z.number().int().min(0).optional(),
  },
  edit: {
    designId: z.string(),
    canvasId: z.string().optional(),
    production: z.boolean().optional(),
    ops: z.array(editOp).min(1),
  },
  render: {
    designId: z.string(),
    frameIds: z.array(z.string()).min(1).optional(),
    canvasId: z.string().optional(),
    /** Crops to a box in the frame's own pixels. Needs exactly one frame in frameIds. */
    region: Region.optional(),
  },
  comments: {
    designId: z.string(),
    canvasId: z.string().optional(),
    wait: z.union([z.number().positive(), z.boolean()]).optional(),
    add: z.object(canvasTools.comment).optional(),
    reply: z
      .array(
        z.object({
          commentId: z.string(),
          text: z.string().min(1),
          resolve: z.boolean().optional(),
        }),
      )
      .min(1)
      .optional(),
    resolve: z.array(z.string()).min(1).optional(),
    reopen: z.array(z.string()).min(1).optional(),
    offset: z.number().int().min(0).optional(),
  },
  undo: {
    designId: z.string(),
    canvasId: z.string().optional(),
    redo: z.boolean().optional(),
  },
} as const satisfies Record<string, z.ZodRawShape>;

export type CanvasToolName = keyof typeof canvasTools;
export type CanvasToolInput<K extends CanvasToolName> = z.infer<
  z.ZodObject<(typeof canvasTools)[K]>
>;
