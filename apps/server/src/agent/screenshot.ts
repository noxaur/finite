import { Refused } from "@finite/protocol";
import { getChromePath } from "chrome-launcher";
import puppeteer, { type Browser } from "puppeteer-core";

export type Screenshots = {
  /** A PNG of `url` in a `width`×`height` viewport. */
  capture(url: string, width: number, height: number): Promise<Uint8Array>;
  /**
   * How big `url`'s content is: its height at `width`, or with no `width` its natural
   * (max-content) width and the height at that width. For frames that hug their content.
   */
  measure(url: string, width?: number): Promise<{ width: number; height: number }>;
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

  return {
    async capture(url, width, height) {
      const page = await (await launch()).newPage();
      try {
        await page.setViewport({ width: Math.round(width), height: Math.round(height) });
        await page.goto(url, { waitUntil: "networkidle0", timeout: 20_000 });
        return await page.screenshot({ type: "png" });
      } finally {
        await page.close().catch(() => {});
      }
    },
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
    async close() {
      const b = browser;
      browser = undefined;
      if (b) await (await b).close().catch(() => {});
    },
  };
}
