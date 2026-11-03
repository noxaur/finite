import { inlineRemote } from "./inline";

/**
 * Level of detail: below a zoom, artboards are drawn as cached bitmaps
 * instead of live DOM, since nobody can read them there.
 */

/** Artboards switch to bitmaps when the zoom falls below this... */
export const BITMAP_BELOW = 0.25;
/** ...and back to live DOM above this. The gap keeps a zoom hovering at the line from flipping every frame. */
export const LIVE_ABOVE = 0.3;

/** After an edit, wait for a pause this long before rebuilding the bitmap, like thumbnails do... */
export const PAUSE_MS = 300;
/** ...and rebuild one artboard at most this often while it keeps changing. */
export const MIN_INTERVAL_MS = 2000;

/** The most pixels all bitmaps together hold: 32 million, 128 MB of RGBA. Beyond it, the ones farthest from the view are dropped. */
export const BITMAP_BUDGET = 32_000_000;

/** The most pixels one bitmap holds. A tall artboard gets a lower resolution instead. */
const MAX_PIXELS = 16_000_000;
const MAX_SIDE = 8192;

/** Whether artboards should be bitmaps at `zoom`, given whether they are now. */
export function wantsBitmaps(zoom: number, current: boolean): boolean {
  return current ? zoom < LIVE_ABOVE : zoom < BITMAP_BELOW;
}

/**
 * The scale to draw a `width` × `height` artboard at when the canvas is at
 * `zoom`: one bitmap pixel per screen pixel at that zoom, rounded up to a
 * step of 1.41x so a small zoom change doesn't ask for a new bitmap. A zoom
 * past the highest one a bitmap is shown at counts as that one. Zoomed far
 * out, this keeps bitmaps tiny, which is what holds the memory in check: the
 * bitmaps in view add up to a few viewports' worth of pixels at any zoom.
 * It's lower for a huge artboard, to cap its pixels.
 */
export function bitmapScale(
  width: number,
  height: number,
  pixelRatio: number,
  zoom: number,
): number {
  const need = Math.min(zoom, LIVE_ABOVE) * Math.max(1, pixelRatio);
  const wanted = Math.min(1, 2 ** (Math.ceil(Math.log2(need) * 2) / 2));
  const area = Math.sqrt(MAX_PIXELS / Math.max(1, width * height));
  const side = MAX_SIDE / Math.max(1, width, height);
  return Math.min(wanted, area, side);
}

/** A bitmap that could be dropped, and how far its artboard is from the middle of the view. */
export interface Evictable {
  readonly id: string;
  readonly pixels: number;
  readonly distance: number;
}

/**
 * Which bitmaps to drop so `total` pixels fit in `budget`, farthest from the
 * view first. `candidates` holds only the ones that may go; those in view stay.
 */
export function evictionPlan(
  candidates: ReadonlyArray<Evictable>,
  total: number,
  budget: number,
): string[] {
  const out: string[] = [];
  for (const c of [...candidates].sort((a, b) => b.distance - a.distance)) {
    if (total <= budget) break;
    out.push(c.id);
    total -= c.pixels;
  }
  return out;
}

/** How long to wait before rebuilding a bitmap that was last built at `last` (ms since the epoch). */
export function rebuildDelay(now: number, last: number): number {
  return Math.max(PAUSE_MS, last + MIN_INTERVAL_MS - now);
}

const XHTML_NS = "http://www.w3.org/1999/xhtml";
const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * An SVG image that draws `xhtml` (well-formed markup) in a `width` × `height`
 * box, styled by `css`. Browsers rasterize `<foreignObject>` content with
 * the same layout engine as the page, so it matches the live artboard,
 * except that an image has no network: remote pictures and web fonts have
 * to be inlined first.
 */
export function bitmapSvg(xhtml: string, css: string, width: number, height: number): string {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  return (
    `<svg xmlns="${SVG_NS}" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `<foreignObject width="${w}" height="${h}">` +
    `<div xmlns="${XHTML_NS}" style="width:${w}px;height:${h}px;overflow:hidden">` +
    // CDATA, so a `<` or `&` in the CSS isn't read as markup.
    `<style><![CDATA[${css.replaceAll("]]>", "]]]]><![CDATA[>")}]]></style>${xhtml}</div>` +
    `</foreignObject></svg>`
  );
}

/** Elements dropped from a bitmap: scripts don't run in an image, and the rest load nothing. */
const SKIPPED = "script, link, meta, base, iframe, frame, frameset, object, embed, template";

/** `html` as well-formed XHTML without the elements an image can't use. */
export function toXhtml(html: string): string {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  for (const el of doc.body.querySelectorAll(SKIPPED)) el.remove();
  const serializer = new XMLSerializer();
  let out = "";
  for (const child of doc.body.childNodes) out += serializer.serializeToString(child);
  return out;
}

/**
 * Draws an artboard's `html` into a canvas `scale` times its size. Remote
 * pictures and fonts are fetched and put in the image first (`./inline`).
 * Rejects if the browser can't draw the markup or a resource can't be
 * fetched, and the artboard then stays live.
 *
 * The canvas is tainted, because it holds a `<foreignObject>`, so its pixels
 * can't be exported: it's shown as it is.
 */
export async function rasterize(
  html: string,
  css: string,
  width: number,
  height: number,
  scale: number,
): Promise<HTMLCanvasElement> {
  const inlined = await inlineRemote(html, css);
  const svg = bitmapSvg(toXhtml(inlined.html), inlined.css, width, height);
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }));
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("no 2d canvas");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export type Rasterizer = typeof rasterize;
