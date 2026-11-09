import {
  type Distance,
  distanceBetween,
  drawFigure,
  figureRootCss,
  MEASURE_PROPS,
  Measurement,
  Refused,
  type Rect,
} from "@finite/protocol";
import { getChromePath } from "chrome-launcher";
import puppeteer, { type Browser } from "puppeteer-core";

/** One element of a loaded frame. `loc` and `rev` are missing when nothing stamped it. */
export type RenderedElement = {
  tag: string;
  loc?: string;
  rev?: string;
  /** Its own text, shortened. */
  text: string;
  /** How many stamped elements contain it. */
  depth: number;
};

/** What to measure in a frame: the `index`th match of `select`, and optionally the first of `to`. */
export type MeasureQuery = { select: string; index: number; to?: string; image: boolean };

export type Measured = {
  element: Measurement;
  to?: Measurement;
  distance?: Distance;
  /** A crop around the elements with the overlay drawn on it, unless `image` was false. */
  png?: Uint8Array;
};

/** Why nothing was measured: a selector matched nothing or isn't one, or `index` is past the matches. */
export type MeasureMiss =
  | { missing: string }
  | { invalid: string; select: string }
  | { count: number };

/** What the crop leaves around the elements, in CSS pixels. */
const FIGURE_MARGIN = 40;
/** The long edge vision models keep; the crop is drawn at twice the zoom a person would see. */
const FIGURE_EDGE = 1568;

/** The crop around `boxes` (expanded, clamped to the page), the zoom the drawing is laid out for, and the capture scale. */
export function figureView(boxes: readonly Rect[], page: { width: number; height: number }) {
  const left = Math.min(...boxes.map((b) => b.x)) - FIGURE_MARGIN;
  const top = Math.min(...boxes.map((b) => b.y)) - FIGURE_MARGIN;
  const right = Math.max(...boxes.map((b) => b.x + b.width)) + FIGURE_MARGIN;
  const bottom = Math.max(...boxes.map((b) => b.y + b.height)) + FIGURE_MARGIN;
  const x = Math.max(0, Math.min(left, page.width - 1));
  const y = Math.max(0, Math.min(top, page.height - 1));
  const crop = {
    x,
    y,
    width: Math.max(1, Math.min(right, page.width) - x),
    height: Math.max(1, Math.min(bottom, page.height) - y),
  };
  const zoom = Math.min(3, Math.max(0.5, FIGURE_EDGE / (2 * Math.max(crop.width, crop.height))));
  return { crop, zoom, scale: 2 * zoom };
}

/** What went wrong while a headless load ran. */
export type LoadError = { kind: "error" | "console"; message: string; stack?: string };

export type Screenshots = {
  /** A PNG of `url` in a `width`×`height` viewport. */
  capture(url: string, width: number, height: number): Promise<Uint8Array>;
  /** `capture`, plus the uncaught errors and `console.error` calls of that load. */
  captureWithErrors(
    url: string,
    width: number,
    height: number,
  ): Promise<{ png: Uint8Array; errors: LoadError[] }>;
  /**
   * How big `url`'s content is: its height at `width`, or with no `width` its natural
   * (max-content) width and the height at that width. For frames that hug their content.
   */
  hugSize(url: string, width?: number): Promise<{ width: number; height: number }>;
  /**
   * One fresh load of `url`: measures the elements through the frame's bridge, and unless
   * `query.image` is false draws the figure on the page and captures a crop around them.
   */
  measureElement(
    url: string,
    width: number,
    height: number,
    query: MeasureQuery,
  ): Promise<Measured | MeasureMiss>;
  /**
   * One fresh load of `url`, and for each selector what it matches (with no selector, every
   * stamped element), or `invalid` when it isn't a CSS selector.
   */
  elements(
    url: string,
    width: number,
    height: number,
    selects: readonly (string | undefined)[],
  ): Promise<(RenderedElement[] | { invalid: string })[]>;
  close(): Promise<void>;
};

/** Screenshots in the system Chrome, one headless browser shared by every thread. */
export function createScreenshots(): Screenshots {
  let browser: Promise<Browser> | undefined;

  function launch(): Promise<Browser> {
    if (!browser) {
      let executablePath: string;
      try {
        executablePath = getChromePath();
      } catch {
        throw new Refused("Screenshots need Google Chrome. Install it, then try again.");
      }
      browser = puppeteer.launch({ executablePath, headless: true });
      browser.then(
        (b) => b.once("disconnected", () => (browser = undefined)),
        () => (browser = undefined),
      );
    }
    return browser;
  }

  async function captureWithErrors(url: string, width: number, height: number) {
    const page = await (await launch()).newPage();
    const errors: LoadError[] = [];
    page.on("pageerror", (error) => {
      const { message, stack } = error instanceof Error ? error : { message: String(error) };
      errors.push({ kind: "error", message, ...(stack === undefined ? {} : { stack }) });
    });
    page.on("console", (message) => {
      if (message.type() === "error") errors.push({ kind: "console", message: message.text() });
    });
    try {
      await page.setViewport({ width: Math.round(width), height: Math.round(height) });
      await page.goto(url, { waitUntil: "networkidle0", timeout: 20_000 });
      return { png: await page.screenshot({ type: "png" }), errors };
    } finally {
      await page.close().catch(() => {});
    }
  }

  return {
    async capture(url, width, height) {
      return (await captureWithErrors(url, width, height)).png;
    },
    captureWithErrors,
    async hugSize(url, width) {
      const page = await (await launch()).newPage();
      try {
        // A short viewport, so `min-h-screen` wrappers don't pass for content.
        await page.setViewport({ width: Math.round(width ?? 1440), height: 200 });
        await page.goto(url, { waitUntil: "networkidle0", timeout: 20_000 });
        return await page.evaluate((natural) => {
          const html = document.documentElement;
          if (natural) html.style.width = "max-content";
          const w = natural ? html.getBoundingClientRect().width : html.scrollWidth;
          const h = Math.max(html.getBoundingClientRect().height, document.body?.scrollHeight ?? 0);
          return { width: Math.ceil(w), height: Math.ceil(h) };
        }, width === undefined);
      } finally {
        await page.close().catch(() => {});
      }
    },
    async measureElement(url, width, height, query) {
      const page = await (await launch()).newPage();
      try {
        await page.setViewport({ width: Math.round(width), height: Math.round(height) });
        await page.goto(url, { waitUntil: "networkidle0", timeout: 20_000 });
        const raw = await page.evaluate(
          (select, index, to, props) => {
            const measure = (
              window as unknown as {
                __finiteMeasure?: (
                  t: { select: string; index: number }[],
                  p: string[],
                ) => unknown[];
              }
            ).__finiteMeasure;
            if (!measure) return { bridge: false as const };
            const run = (css: string, at: number) => {
              try {
                return { found: measure([{ select: css, index: at }], props)[0] ?? null };
              } catch (error) {
                return { invalid: error instanceof Error ? error.message : String(error) };
              }
            };
            const first = run(select, 0);
            if ("invalid" in first)
              return { bridge: true as const, invalid: first.invalid, select };
            if (!first.found) return { bridge: true as const, missing: select };
            const count = (first.found as { count: number }).count;
            if (index >= count) return { bridge: true as const, count };
            const element = index === 0 ? first : run(select, index);
            const other = to === null ? undefined : run(to, 0);
            if (other && "invalid" in other) {
              return { bridge: true as const, invalid: other.invalid, select: to! };
            }
            if (other && !other.found) return { bridge: true as const, missing: to! };
            const doc = document.documentElement;
            return {
              bridge: true as const,
              element: (element as { found: unknown }).found,
              to: other?.found,
              page: {
                width: Math.max(doc.scrollWidth, doc.clientWidth),
                height: Math.max(doc.scrollHeight, doc.clientHeight),
              },
            };
          },
          query.select,
          query.index,
          query.to ?? null,
          MEASURE_PROPS,
        );
        if (!raw.bridge) {
          throw new Refused("This frame's page has no Finite bridge. Restart its preview.");
        }
        if ("invalid" in raw) return { invalid: raw.invalid, select: String(raw.select) };
        if ("missing" in raw) return { missing: raw.missing };
        if ("count" in raw) return { count: raw.count };
        const element = Measurement.parse(raw.element);
        const to = raw.to === undefined ? undefined : Measurement.parse(raw.to);
        const distance = to ? distanceBetween(element.box, to.box) : undefined;
        const result: Measured = {
          element,
          ...(to ? { to } : {}),
          ...(distance ? { distance } : {}),
        };
        if (!query.image) return result;

        const { crop, zoom, scale } = figureView(
          to ? [element.box, to.box] : [element.box],
          raw.page,
        );
        const html = drawFigure(
          to ? { target: element, other: to } : { target: element },
          zoom,
        ).html;
        // The page is thrown away after this, so the root can't reach anything a person sees.
        await page.evaluate(
          (css, markup) => {
            const root = document.createElement("div");
            root.style.cssText = `position:absolute;left:0;top:0;width:0;height:0;overflow:visible;pointer-events:none;z-index:2147483647;${css}`;
            root.innerHTML = markup;
            document.documentElement.append(root);
          },
          figureRootCss(zoom),
          html,
        );
        const png = await page.screenshot({
          type: "png",
          clip: { ...crop, scale },
          captureBeyondViewport: true,
        });
        return { ...result, png };
      } finally {
        await page.close().catch(() => {});
      }
    },
    async elements(url, width, height, selects) {
      const page = await (await launch()).newPage();
      try {
        await page.setViewport({ width: Math.round(width), height: Math.round(height) });
        await page.goto(url, { waitUntil: "networkidle0", timeout: 20_000 });
        return await page.evaluate(
          (all: readonly (string | null)[]) => {
            const LOC = "data-finite-loc";
            const REV = "data-finite-rev";
            const stamp = `[${LOC}]`;
            const describe = (element: Element) => {
              let depth = 0;
              for (let up = element.parentElement?.closest(stamp); up;) {
                depth += 1;
                up = up.parentElement?.closest(stamp);
              }
              const own = Array.from(element.childNodes)
                .filter((node) => node.nodeType === Node.TEXT_NODE)
                .map((node) => node.textContent ?? "")
                .join(" ")
                .replace(/\s+/g, " ")
                .trim();
              return {
                tag: element.tagName.toLowerCase(),
                ...(element.hasAttribute(LOC) ? { loc: element.getAttribute(LOC)! } : {}),
                ...(element.hasAttribute(REV) ? { rev: element.getAttribute(REV)! } : {}),
                text: own.length > 60 ? `${own.slice(0, 60)}…` : own,
                depth,
              };
            };
            return all.map((select) => {
              try {
                return Array.from(document.querySelectorAll(select ?? stamp)).map(describe);
              } catch (error) {
                return { invalid: error instanceof Error ? error.message : String(error) };
              }
            });
          },
          selects.map((s) => s ?? null),
        );
      } finally {
        await page.close().catch(() => {});
      }
    },
    async close() {
      const b = browser;
      browser = undefined;
      if (b) await (await b).close().catch(() => {});
    },
  };
}
