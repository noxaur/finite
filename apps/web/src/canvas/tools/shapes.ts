import { finite } from "../../client/finite";
import type { NewNode, Rect } from "@finite/protocol";
import type { Point } from "../gestures";
import type { Down, Gesture, Ghost, PressPlan, ToolDef, ToolGroup, ToolHost } from "./host";

/** How big a click makes a shape, in canvas units. */
const CLICK_SIZE = 100;
/** Empty canvas clips to the frame, so a line gets this much room around it. */
const LOOSE_PAD = 16;
/** The longest side a clicked-in image lands at. */
const IMAGE_SIZE = 640;
const ARROW_HEAD = 14;
const SHAPE_FILL = "#d9d9d9";
const LINE_STROKE = "#1e1e1e";

/** The box a drag from `from` to `to` draws: Shift makes it square, Alt grows it from the middle. */
export function dragBox(from: Point, to: Point, square: boolean, center: boolean): Rect {
  let w = to.x - from.x;
  let h = to.y - from.y;
  if (square) {
    const side = Math.max(Math.abs(w), Math.abs(h));
    w = Math.sign(w || 1) * side;
    h = Math.sign(h || 1) * side;
  }
  const x = center ? from.x - w : from.x;
  const y = center ? from.y - h : from.y;
  const right = from.x + w;
  const bottom = from.y + h;
  return {
    x: Math.round(Math.min(x, right)),
    y: Math.round(Math.min(y, bottom)),
    width: Math.max(1, Math.round(Math.abs(right - x))),
    height: Math.max(1, Math.round(Math.abs(bottom - y))),
  };
}

/** A drawn line: its box in the canvas, and its ends inside that box. */
export type LineDrag = { box: Rect; a: Point; b: Point };

/** The line a drag draws: Shift snaps it to 45° steps, Alt grows it from the middle. */
export function dragLine(from: Point, to: Point, snap: boolean, center: boolean): LineDrag {
  let dx = to.x - from.x;
  let dy = to.y - from.y;
  if (snap) {
    const length = Math.hypot(dx, dy);
    const angle = (Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * Math.PI) / 4;
    dx = Math.round(Math.cos(angle) * length);
    dy = Math.round(Math.sin(angle) * length);
  }
  const start = center ? { x: from.x - dx, y: from.y - dy } : from;
  const end = { x: from.x + dx, y: from.y + dy };
  const left = Math.round(Math.min(start.x, end.x));
  const top = Math.round(Math.min(start.y, end.y));
  return {
    box: {
      x: left,
      y: top,
      width: Math.max(1, Math.round(Math.abs(end.x - start.x))),
      height: Math.max(1, Math.round(Math.abs(end.y - start.y))),
    },
    a: { x: Math.round(start.x) - left, y: Math.round(start.y) - top },
    b: { x: Math.round(end.x) - left, y: Math.round(end.y) - top },
  };
}

/** The same line, with `pad` of room around it in its box. */
export function padded(line: LineDrag, pad: number): LineDrag {
  const shift = (p: Point) => ({ x: p.x + pad, y: p.y + pad });
  return {
    box: {
      x: line.box.x - pad,
      y: line.box.y - pad,
      width: line.box.width + pad * 2,
      height: line.box.height + pad * 2,
    },
    a: shift(line.a),
    b: shift(line.b),
  };
}

const n = (v: number) => String(Math.round(v * 100) / 100);
const at = (p: Point) => `${n(p.x)} ${n(p.y)}`;

export function linePath({ a, b }: Pick<LineDrag, "a" | "b">): string {
  return `M${at(a)}L${at(b)}`;
}

export function arrowPath({ a, b }: Pick<LineDrag, "a" | "b">): string {
  const length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const size = Math.min(ARROW_HEAD, length / 2);
  const back = Math.atan2(a.y - b.y, a.x - b.x);
  const wing = (turn: number) => ({
    x: b.x + Math.cos(back + turn) * size,
    y: b.y + Math.sin(back + turn) * size,
  });
  return `M${at(a)}L${at(b)}M${at(wing(Math.PI / 6))}L${at(b)}L${at(wing(-Math.PI / 6))}`;
}

/** A closed outline through `radii` spokes evenly around the box, stretched to touch its edges. */
function ringPath(box: Rect, radii: number[]): string {
  const points = radii.map((r, i) => {
    const angle = -Math.PI / 2 + (i * 2 * Math.PI) / radii.length;
    return { x: Math.cos(angle) * r, y: Math.sin(angle) * r };
  });
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const [left, top] = [Math.min(...xs), Math.min(...ys)];
  const [w, h] = [Math.max(...xs) - left, Math.max(...ys) - top];
  const fit = points.map((p) => ({
    x: ((p.x - left) / w) * box.width,
    y: ((p.y - top) / h) * box.height,
  }));
  return `M${fit.map(at).join("L")}Z`;
}

export function polygonPath(box: Rect, sides: number): string {
  return ringPath(box, Array<number>(sides).fill(1));
}

export function starPath(box: Rect, points: number, inner: number): string {
  return ringPath(
    box,
    Array.from({ length: points * 2 }, (_, i) => (i % 2 === 0 ? 1 : inner)),
  );
}

/** An inline `<svg>` holding one `<path>`. Resizing its box stretches the geometry, not the stroke. */
function vectorNode(
  name: string,
  box: Pick<Rect, "width" | "height">,
  d: string,
  paint: Record<string, string>,
): NewNode {
  return {
    tag: "svg",
    name,
    attrs: { viewBox: `0 0 ${box.width} ${box.height}`, preserveAspectRatio: "none" },
    styles: { overflow: "visible" },
    children: [{ tag: "path", attrs: { d, vectorEffect: "non-scaling-stroke" }, styles: paint }],
  };
}

const SHARED = { cursor: "crosshair", enabled: true } as const;

/** A tool that draws one element into a box. */
export function shapeTool<Id extends string>(def: {
  id: Id;
  group?: ToolGroup;
  label: string;
  keys: ToolDef["keys"];
  icon: ToolDef["icon"];
  round?: boolean;
  /** The ghost's outline, when it isn't the box. */
  outline?: (box: Rect) => string;
  clickSize?: (inFrame: boolean) => { width: number; height: number };
  node: (box: Rect) => NewNode;
}): ToolDef<Id> {
  return {
    ...SHARED,
    id: def.id,
    group: def.group ?? "shape",
    label: def.label,
    keys: def.keys,
    icon: def.icon,
    down: (host, p) =>
      boxPlan(host, p, {
        round: def.round === true,
        node: def.node,
        click: def.clickSize?.(p.frame !== null) ?? { width: CLICK_SIZE, height: CLICK_SIZE },
        ...(def.outline ? { outline: def.outline } : {}),
      }),
  };
}

function boxPlan(
  host: ToolHost,
  p: Down,
  shape: {
    round: boolean;
    outline?: (box: Rect) => string;
    click: { width: number; height: number };
    node: (box: Rect) => NewNode;
  },
): PressPlan {
  const place = (box: Rect) => host.draw({ box, node: shape.node(box), deep: p.deep, alt: p.alt });
  const ghost = (box: Rect): Ghost => ({
    box,
    ...(shape.round ? { round: true } : {}),
    ...(shape.outline ? { d: shape.outline(box) } : {}),
  });
  return {
    click: () =>
      place({ x: Math.round(p.world.x), y: Math.round(p.world.y), ...shape.click }).then(() => {}),
    begin: async () => boxGesture(host, p.world, ghost, place),
  };
}

function boxGesture(
  host: ToolHost,
  from: Point,
  ghost: (box: Rect) => Ghost,
  place: (box: Rect) => Promise<unknown>,
): Gesture {
  let box: Rect | null = null;
  return {
    move: (_screen, world, e) => {
      box = dragBox(from, world, e.shiftKey, e.altKey);
      host.setGhost(ghost(box));
    },
    end: async (commit) => {
      host.setGhost(null);
      if (commit && box) await place(box);
    },
  };
}

export const rectangle = shapeTool({
  id: "rectangle",
  label: "Rectangle",
  keys: { key: "r" },
  icon: "box",
  node: () => ({ tag: "div", name: "Rectangle", styles: { "background-color": SHAPE_FILL } }),
});

export const ellipse = shapeTool({
  id: "ellipse",
  label: "Ellipse",
  keys: { key: "o" },
  icon: "ellipse",
  round: true,
  node: () => ({
    tag: "div",
    name: "Ellipse",
    styles: { "background-color": SHAPE_FILL, "border-radius": "50%" },
  }),
});

const SIDES = 3;
const STAR_POINTS = 5;
const STAR_INNER = 0.382;

export const polygon = shapeTool({
  id: "polygon",
  label: "Polygon",
  keys: null,
  icon: "polygon",
  outline: (box) => polygonPath(box, SIDES),
  node: (box) => vectorNode("Polygon", box, polygonPath(box, SIDES), { fill: SHAPE_FILL }),
});

export const star = shapeTool({
  id: "star",
  label: "Star",
  keys: null,
  icon: "star",
  outline: (box) => starPath(box, STAR_POINTS, STAR_INNER),
  node: (box) =>
    vectorNode("Star", box, starPath(box, STAR_POINTS, STAR_INNER), { fill: SHAPE_FILL }),
});

/** A tool that draws one line between where a drag starts and ends. */
function lineTool<Id extends string>(def: {
  id: Id;
  label: string;
  keys: ToolDef["keys"];
  icon: ToolDef["icon"];
  path: (line: LineDrag) => string;
}): ToolDef<Id> {
  const nodeOf = (line: LineDrag) =>
    vectorNode(def.label, line.box, def.path(line), {
      fill: "none",
      stroke: LINE_STROKE,
      "stroke-width": "2px",
    });
  return {
    ...SHARED,
    id: def.id,
    group: "shape",
    label: def.label,
    keys: def.keys,
    icon: def.icon,
    down(host, p) {
      const place = (line: LineDrag) => {
        const middle = {
          x: line.box.x + line.box.width / 2,
          y: line.box.y + line.box.height / 2,
        };
        const fitted = host.frameAt(middle) ? line : padded(line, LOOSE_PAD);
        return host.draw({ box: fitted.box, node: nodeOf(fitted), deep: p.deep, alt: p.alt });
      };
      return {
        click: () =>
          place(dragLine(p.world, { x: p.world.x + CLICK_SIZE, y: p.world.y }, false, false)).then(
            () => {},
          ),
        begin: async () => {
          let line: LineDrag | null = null;
          return {
            move: (_screen, world, e) => {
              line = dragLine(p.world, world, e.shiftKey, e.altKey);
              host.setGhost({ box: line.box, d: def.path(line) });
            },
            end: async (commit) => {
              host.setGhost(null);
              if (commit && line) await place(line);
            },
          };
        },
      };
    },
  };
}

export const line = lineTool({
  id: "line",
  label: "Line",
  keys: { key: "l" },
  icon: "line",
  path: linePath,
});

export const arrow = lineTool({
  id: "arrow",
  label: "Arrow",
  keys: { key: "l", shift: true },
  icon: "arrow",
  path: arrowPath,
});

/** The picked file, once it's in the brand folder and ready to place. */
type Picked = {
  asset: string;
  name: string;
  video: boolean;
  width: number;
  height: number;
};

/** The longest side at `IMAGE_SIZE`, or smaller when the file is smaller. */
export function clickedSize(natural: { width: number; height: number }): {
  width: number;
  height: number;
} {
  const longest = Math.max(natural.width, natural.height);
  if (longest === 0) return { width: CLICK_SIZE, height: CLICK_SIZE };
  const scale = Math.min(1, IMAGE_SIZE / longest);
  return {
    width: Math.max(1, Math.round(natural.width * scale)),
    height: Math.max(1, Math.round(natural.height * scale)),
  };
}

function naturalSize(file: File, video: boolean): Promise<{ width: number; height: number }> {
  const url = URL.createObjectURL(file);
  return new Promise<{ width: number; height: number }>((resolve) => {
    const none = () => resolve({ width: 0, height: 0 });
    if (video) {
      const el = document.createElement("video");
      el.onloadedmetadata = () => resolve({ width: el.videoWidth, height: el.videoHeight });
      el.onerror = none;
      el.src = url;
    } else {
      const el = new Image();
      el.onload = () => resolve({ width: el.naturalWidth, height: el.naturalHeight });
      el.onerror = none;
      el.src = url;
    }
  }).finally(() => URL.revokeObjectURL(url));
}

async function bringIn(designId: string, file: File): Promise<Picked> {
  const body = new FormData();
  body.append("file", file, file.name);
  const res = await fetch(`/api/designs/${encodeURIComponent(designId)}/attachments`, {
    method: "POST",
    body,
  });
  const json = (await res.json()) as { path?: string; reason?: string };
  if (!res.ok || !json.path) throw new Error(json.reason ?? `Upload failed (${res.status})`);
  const { asset } = await finite.request("asset.add", { designId, attachment: json.path });
  const video = file.type.startsWith("video/");
  return {
    asset,
    name: file.name.replace(/\.[^.]*$/, "") || "Image",
    video,
    ...(await naturalSize(file, video)),
  };
}

let picked: Picked | null = null;

function imageNode({ asset, name, video }: Picked): NewNode {
  return {
    tag: video ? "video" : "img",
    name,
    src: { asset },
    ...(video ? {} : { attrs: { alt: "" } }),
    styles: { "object-fit": "cover" },
  };
}

/** Opens the file picker; the next click or drag on the canvas places what's picked. */
export const image: ToolDef<"image"> = {
  ...SHARED,
  id: "image",
  group: "shape",
  label: "Image or video",
  keys: { key: "k", shift: true, mod: true },
  icon: "image",
  activate(host) {
    picked = null;
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*,video/mp4,video/webm,video/quicktime";
    input.addEventListener("cancel", () => host.setTool("select"));
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (!file) return host.setTool("select");
      bringIn(host.designId, file).then(
        (done) => {
          picked = done;
          host.say(`Click or drag to place ${file.name}.`);
        },
        (e: unknown) => {
          host.setTool("select");
          host.say(`Couldn't add ${file.name}: ${e instanceof Error ? e.message : String(e)}`);
        },
      );
    });
    input.click();
  },
  down(host, p) {
    const file = picked;
    if (!file) return "pass";
    return boxPlan(host, p, {
      round: false,
      click: clickedSize(file),
      node: () => imageNode(file),
    });
  },
};
