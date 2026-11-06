import { z } from "zod";
import { Loc } from "./model.ts";

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
    loc: Loc.optional(),
    /** Which rendered instance of `loc` (from a selection), default 0. */
    index: z.number().int().min(0).optional(),
    text: z.string().min(1),
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
    kind: z.enum(["logo", "image", "font", "other"]),
  },
  spawn_thread: { prompt: z.string().min(1), canvasId: z.string().optional() },
  name_thread: { title: z.string().min(1) },
  screenshot: { frameId: z.string() },
  frame_errors: { frameId: z.string() },
} as const satisfies Record<string, z.ZodRawShape>;

export type CanvasToolName = keyof typeof canvasTools;
export type CanvasToolInput<K extends CanvasToolName> = z.infer<
  z.ZodObject<(typeof canvasTools)[K]>
>;
