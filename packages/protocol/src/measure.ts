import { z } from "zod";
import { Loc, Rect } from "./model.ts";

const Edges = z.object({
  top: z.number(),
  right: z.number(),
  bottom: z.number(),
  left: z.number(),
});
export type Edges = z.infer<typeof Edges>;

const Corners = z.object({
  topLeft: z.number(),
  topRight: z.number(),
  bottomRight: z.number(),
  bottomLeft: z.number(),
});

/** How the frame finds an element, in frame CSS pixels or frame-local names. */
export const MeasureTarget = z.union([
  /** The stamped element under a point, or its `up`th stamped ancestor. */
  z.object({
    at: z.object({ x: z.number(), y: z.number() }),
    up: z.number().int().min(0).optional(),
  }),
  /** One rendered instance of a loc, so a pin survives HMR. */
  z.object({ loc: Loc, index: z.number().int().min(0) }),
  /** Any element, stamped or not. A bad selector throws its own message. */
  z.object({ select: z.string(), index: z.number().int().min(0) }),
]);
export type MeasureTarget = z.infer<typeof MeasureTarget>;

export const MeasuredChild = z.object({
  /** `#text` for an anonymous text run, which a flex parent lays out as an item. */
  tag: z.string(),
  name: z.string(),
  loc: Loc.optional(),
  rect: Rect,
});
export type MeasuredChild = z.infer<typeof MeasuredChild>;

/** A real distance between neighbouring children, whatever produced it. */
export const MeasuredGap = z.object({
  /** "x": measured left to right (a vertical band). "y": top to bottom. */
  axis: z.enum(["x", "y"]),
  /** 0 means they touch; the data keeps it, the drawing skips it. */
  size: z.number(),
  rect: Rect,
  /** Indexes into `children`: the nearest child on each side. */
  between: z.tuple([z.number().int(), z.number().int()]),
  /** What an agent should edit: the parent's `gap`, a child's margin, or neither. */
  cause: z.enum(["gap", "margin", "free"]),
});
export type MeasuredGap = z.infer<typeof MeasuredGap>;

/** One element in frame CSS pixels: the frame's reply, the overlay's input and the agent's result. */
export const Measurement = z.object({
  tag: z.string(),
  name: z.string(),
  /** Absent on elements a library rendered. */
  loc: Loc.optional(),
  rev: z.string().optional(),
  /** Which match this is and how many there are: of the loc, or of the selector. */
  index: z.number().int().min(0),
  count: z.number().int().min(1),
  /** Border box. */
  box: Rect,
  padding: Edges,
  border: Edges,
  margin: Edges,
  radius: Corners,
  /** False under a rotate or skew, where `box` is only the bounding box and bands would lie. */
  axisAligned: z.boolean(),
  flow: z.enum(["flex", "grid", "block", "inline"]),
  /** In-flow children in document order, capped by the frame. */
  children: z.array(MeasuredChild),
  childCount: z.number().int().min(0),
  gaps: z.array(MeasuredGap),
  /** The computed value of every requested prop, camelCase. */
  style: z.record(z.string(), z.string()),
  text: z.string().optional(),
});
export type Measurement = z.infer<typeof Measurement>;

/** What overlaps a rectangle of a frame, in document order. `total` counts past the `max` returned. */
export const MeasuredArea = z.object({
  elements: z.array(Measurement),
  total: z.number().int().min(0),
});
export type MeasuredArea = z.infer<typeof MeasuredArea>;

type SpecRow = { label: string; prop: string; kind?: "color" | "font" };

/** What's reported beyond geometry: the frame reads these, the card shows them, agents get them. */
export const SPEC: readonly { title: string; rows: readonly SpecRow[] }[] = [
  {
    title: "Layout",
    rows: [
      { label: "Display", prop: "display" },
      { label: "Direction", prop: "flexDirection" },
      { label: "Wrap", prop: "flexWrap" },
      { label: "Justify", prop: "justifyContent" },
      { label: "Align", prop: "alignItems" },
      { label: "CSS gap", prop: "gap" },
      { label: "Columns", prop: "gridTemplateColumns" },
      { label: "Rows", prop: "gridTemplateRows" },
      { label: "Position", prop: "position" },
      { label: "Overflow", prop: "overflow" },
      { label: "Min width", prop: "minWidth" },
      { label: "Max width", prop: "maxWidth" },
      { label: "Box sizing", prop: "boxSizing" },
      { label: "Z-index", prop: "zIndex" },
    ],
  },
  {
    title: "Type",
    rows: [
      { label: "Font", prop: "fontFamily", kind: "font" },
      { label: "Size", prop: "fontSize" },
      { label: "Weight", prop: "fontWeight" },
      { label: "Line height", prop: "lineHeight" },
      { label: "Tracking", prop: "letterSpacing" },
      { label: "Color", prop: "color", kind: "color" },
    ],
  },
  {
    title: "Fill",
    rows: [
      { label: "Background", prop: "backgroundColor", kind: "color" },
      { label: "Image", prop: "backgroundImage" },
      { label: "Border", prop: "borderTopColor", kind: "color" },
      { label: "Shadow", prop: "boxShadow" },
      { label: "Opacity", prop: "opacity" },
    ],
  },
];

export const MEASURE_PROPS: string[] = SPEC.flatMap((section) => section.rows.map((r) => r.prop));
