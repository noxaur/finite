import { Refused } from "@finite/protocol";
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

/** What went wrong while a headless load ran. */
export type LoadError = { kind: "error" | "console"; message: string; stack?: string };

/** A box in a frame's own CSS pixels. */
export type Region = { x: number; y: number; width: number; height: number };

export type Screenshots = {
  /** A PNG of `url` in a `width`×`height` viewport, or of `region` of it. */
  capture(url: string, width: number, height: number, region?: Region): Promise<Uint8Array>;
  /** `capture`, plus the uncaught errors and `console.error` calls of that load. */
  captureWithErrors(
    url: string,
    width: number,
    height: number,
    region?: Region,
  ): Promise<{ png: Uint8Array; errors: LoadError[] }>;
  /**
   * How big `url`'s content is: its height at `width`, or with no `width` its natural
   * (max-content) width and the height at that width. For frames that hug their content.
   */
  measure(url: string, width?: number): Promise<{ width: number; height: number }>;
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

  async function captureWithErrors(url: string, width: number, height: number, region?: Region) {
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
      // The viewport reaches the region's bottom, so a frame that hugs its content isn't cut short.
      const bottom = region ? Math.ceil(region.y + region.height) : 0;
      await page.setViewport({
        width: Math.round(width),
        height: Math.max(Math.round(height), bottom),
      });
      await page.goto(url, { waitUntil: "networkidle0", timeout: 20_000 });
      const png = await page.screenshot({ type: "png", ...(region ? { clip: region } : {}) });
      return { png, errors };
    } finally {
      await page.close().catch(() => {});
    }
  }

  return {
    async capture(url, width, height, region) {
      return (await captureWithErrors(url, width, height, region)).png;
    },
    captureWithErrors,
    async measure(url, width) {
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
