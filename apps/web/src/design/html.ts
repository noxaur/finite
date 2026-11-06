import type { Replica } from "./replica";
import type { Node } from "./schema";
import { designModel } from "./wasm";

/**
 * Runs first in every sandboxed artboard. It reports the artboard's size so
 * the iframe can fit it, and forwards wheel events so the canvas still pans
 * and zooms while the pointer is over the artboard.
 */
const RUNTIME = `(() => {
  const post = (message) => parent.postMessage({ finite: message }, "*");
  const report = () => {
    const root = document.body && document.body.firstElementChild;
    if (!root) return;
    const rect = root.getBoundingClientRect();
    post({ type: "size", width: Math.ceil(rect.width), height: Math.ceil(rect.height) });
  };
  addEventListener("DOMContentLoaded", () => {
    report();
    const root = document.body.firstElementChild;
    if (root) new ResizeObserver(report).observe(root);
  });
  // The canvas asks what's under a point, or where a node is, for comments.
  // Elements carry their node id in data-finite-id.
  const place = (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  };
  addEventListener("message", (e) => {
    const m = e.source === parent && e.data && e.data.finite;
    if (!m) return;
    if (m.type === "hit") {
      let el = document.elementFromPoint(m.x, m.y);
      while (el && !el.getAttribute("data-finite-id")) el = el.parentElement;
      post({ type: "hit", x: m.x, y: m.y, id: el ? el.getAttribute("data-finite-id") : null, rect: el ? place(el) : null });
    } else if (m.type === "rect" && typeof m.id === "string") {
      const el = document.querySelector('[data-finite-id="' + CSS.escape(m.id) + '"]');
      post({ type: "rect", id: m.id, rect: el ? place(el) : null });
    }
  });
  addEventListener("wheel", (e) => {
    e.preventDefault();
    post({ type: "wheel", deltaX: e.deltaX, deltaY: e.deltaY, deltaMode: e.deltaMode,
      ctrlKey: e.ctrlKey, metaKey: e.metaKey, shiftKey: e.shiftKey, clientX: e.clientX, clientY: e.clientY });
  }, { passive: false });
})();`;

/**
 * Runs first in an artboard shown in preview mode. An element with
 * `data-to` is a link to that artboard (see `flow.rs`): a click, or Enter
 * on it, asks the preview to go there. Other links and forms do nothing,
 * as on the canvas. The keys that leave, step, go back or restart reach the
 * page even after a click inside the artboard.
 */
const PREVIEW_RUNTIME = `(() => {
  const post = (message) => parent.postMessage({ finite: message }, "*");
  // The whole path, so a link around or inside a shadow root counts too.
  const linkOf = (e) => e.composedPath().find((el) => el instanceof Element && el.hasAttribute("data-to"));
  addEventListener("click", (e) => {
    const path = e.composedPath();
    if (path.some((el) => el instanceof Element && el.matches("a[href], area[href]"))) e.preventDefault();
    const link = linkOf(e);
    if (link) post({ type: "navigate", to: link.getAttribute("data-to").trim() });
  }, true);
  addEventListener("submit", (e) => e.preventDefault(), true);
  // A link on a plain element takes focus and Enter, like a real link.
  // Enter on a button or a link already clicks it.
  const clicks = "a[href], area[href], button, input, select, textarea, summary";
  addEventListener("DOMContentLoaded", () => {
    for (const el of document.querySelectorAll("[data-to]")) {
      if (el.matches(clicks + ", [tabindex], [contenteditable]")) continue;
      el.tabIndex = 0;
      if (!el.hasAttribute("role")) el.setAttribute("role", "link");
    }
  });
  // Escape always leaves. The other keys act only when the artboard didn't
  // use them, outside fields and editable text (inside shadow roots too).
  // The check waits until the event has reached the artboard's own listeners.
  const editing = (el) => el instanceof Element && (el.isContentEditable || el.closest("input, textarea, select"));
  const keys = ["ArrowLeft", "ArrowRight", "Backspace", "r", "R"];
  addEventListener("keydown", (e) => {
    if (e.key === "Escape") return post({ type: "key", key: e.key });
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const focused = e.composedPath()[0];
    if (e.key === "Enter" && focused instanceof Element && focused.hasAttribute("data-to") && !focused.matches(clicks)) {
      e.preventDefault();
      return post({ type: "navigate", to: focused.getAttribute("data-to").trim() });
    }
    if (!keys.includes(e.key) || (e.shiftKey && e.key.startsWith("Arrow"))) return;
    if (editing(e.composedPath()[0])) return;
    setTimeout(() => e.defaultPrevented || post({ type: "key", key: e.key.toLowerCase() === "r" ? "r" : e.key }));
  });
})();`;

/**
 * The cascade layer for base styles, before the tokens', so an artboard's
 * styles override them (`html::BASE_LAYER`).
 */
export const BASE_LAYER = "finite-base";

/**
 * A standalone page that shows one artboard, for a sandboxed iframe's
 * `srcdoc`. The design's tokens in the artboard's mode come before the
 * artboard, in a layer the artboard's own styles override, as in screenshots.
 * A `preview` page scrolls and takes clicks like a real page, for preview mode.
 */
export function artboardDocument(replica: Replica, id: string, preview = false): string {
  const { csp, baseCss } = designModel();
  const tokens = replica.tokenStyle(id, false);
  const shared = tokens === "" ? "" : `<style>${tokens}</style>`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><style>@layer ${BASE_LAYER} { ${baseCss} html, body { margin: 0; } }</style>${shared}<script>${preview ? PREVIEW_RUNTIME : RUNTIME}</script></head><body>${replica.exportHtml(id, true)}</body></html>`;
}

/** An element's `width` and `height` styles, when they're plain pixels. */
export function pixelSize(node: Node): { width: number | null; height: number | null } {
  const px = (value: string | undefined) => {
    const match = value?.trim().match(/^(\d+(?:\.\d+)?)(px)?$/);
    return match ? Number(match[1]) : null;
  };
  return { width: px(node.styles.width), height: px(node.styles.height) };
}
