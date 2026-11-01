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

/** A standalone page that shows one artboard, for a sandboxed iframe's `srcdoc`. */
export function artboardDocument(replica: Replica, id: string): string {
  const { csp, baseCss } = designModel();
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><style>${baseCss} html, body { margin: 0; }</style><script>${RUNTIME}</script></head><body>${replica.exportHtml(id, true)}</body></html>`;
}

/** An element's `width` and `height` styles, when they're plain pixels. */
export function pixelSize(node: Node): { width: number | null; height: number | null } {
  const px = (value: string | undefined) => {
    const match = value?.trim().match(/^(\d+(?:\.\d+)?)(px)?$/);
    return match ? Number(match[1]) : null;
  };
  return { width: px(node.styles.width), height: px(node.styles.height) };
}
