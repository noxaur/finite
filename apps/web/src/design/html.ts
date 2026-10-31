import type { Replica } from "./replica";
import type { Node } from "./schema";

// These mirror `crates/server/src/screenshot.rs`, so a screenshot and the
// viewer render an artboard the same way.

export const BASE_CSS = "*, *::before, *::after { box-sizing: border-box; }";

/**
 * The content policy for artboards that run scripts: inline code, remote
 * images, fonts and stylesheets, and no network access from scripts.
 */
export const CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline' https:; img-src https: http: data: blob:; font-src https: data:; media-src https: data: blob:";

const VOID_TAGS = new Set(["area", "br", "col", "hr", "img", "input", "source", "track", "wbr"]);
const RAW_TEXT_TAGS = new Set(["script", "style"]);

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

const escapeText = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttr = (s: string) => escapeText(s).replace(/"/g, "&quot;");

/** Script and style text, with any closing tag inside it broken up. */
const rawText = (code: string, tag: string) =>
  code.replace(new RegExp(`</(?=${tag})`, "gi"), "<\\/");

/**
 * The subtree at `id` as HTML, like the server's `html::export`. With `ids`,
 * each element carries its node id in `data-finite-id`.
 */
export function exportHtml(replica: Replica, id: string, ids = false): string {
  const node = replica.get(id);
  return node ? write(replica, node, ids) : "";
}

function write(replica: Replica, node: Node, ids: boolean): string {
  if (node.type === "text") return escapeText(node.text ?? "");
  const tag = node.tag ?? "div";
  let out = `<${tag}`;
  if (ids) out += ` data-finite-id="${escapeAttr(node.id)}"`;
  for (const [name, value] of Object.entries(node.attrs)) out += ` ${name}="${escapeAttr(value)}"`;
  const style = Object.entries(node.styles)
    .map(([k, v]) => `${k}: ${v}`)
    .join("; ");
  if (style) out += ` style="${escapeAttr(style)}"`;
  if (VOID_TAGS.has(tag)) return `${out} />`;
  const children = replica.children(node.id);
  const lower = tag.toLowerCase();
  const inner = RAW_TEXT_TAGS.has(lower)
    ? rawText(children.map((c) => c.text ?? "").join(""), lower)
    : children.map((c) => write(replica, c, ids)).join("");
  return `${out}>${inner}</${tag}>`;
}

/** A standalone page that shows one artboard, for a sandboxed iframe's `srcdoc`. */
export function artboardDocument(replica: Replica, id: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CSP}"><style>${BASE_CSS} html, body { margin: 0; }</style><script>${RUNTIME}</script></head><body>${exportHtml(replica, id, true)}</body></html>`;
}

/** An element's `width` and `height` styles, when they're plain pixels. */
export function pixelSize(node: Node): { width: number | null; height: number | null } {
  const px = (value: string | undefined) => {
    const match = value?.trim().match(/^(\d+(?:\.\d+)?)(px)?$/);
    return match ? Number(match[1]) : null;
  };
  return { width: px(node.styles.width), height: px(node.styles.height) };
}
