import type { Replica } from "./replica";
import type { Node } from "./schema";
import { designModel } from "./wasm";

/**
 * The cascade layer for base styles, before the tokens', so an artboard's
 * styles override them (`html::BASE_LAYER`).
 */
export const BASE_LAYER = "finite-base";

/** What a page's bootstrap starts with (see `html::BOOTSTRAP`). */
export interface BootConfig {
  /** Identifies this document, so only its bootstrap gets the viewer's private port. */
  readonly nonce: string;
  /** The design's page storage, which the page's `localStorage` starts from. */
  readonly storage: Readonly<Record<string, string>>;
}

/**
 * A standalone page that shows one artboard, for a sandboxed iframe's
 * `srcdoc`. The design's tokens in the artboard's mode come before the
 * artboard, in a layer the artboard's own styles override, as in
 * screenshots. The bootstrap runs before anything else.
 */
export function artboardDocument(replica: Replica, id: string, boot: BootConfig): string {
  const { csp, baseCss, bootstrap } = designModel();
  const tokens = replica.tokenStyle(id, false);
  const shared = tokens === "" ? "" : `<style>${tokens}</style>`;
  // `<` escaped, so a stored "</script>" can't end the script.
  const config = JSON.stringify({ nonce: boot.nonce, storage: boot.storage }).replace(
    /</g,
    "\\u003c",
  );
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><script>(${bootstrap})(${config})</script><style>@layer ${BASE_LAYER} { ${baseCss} html, body { margin: 0; } }</style>${shared}</head><body>${replica.exportHtml(id, true)}</body></html>`;
}

/** An element's `width` and `height` styles, when they're plain pixels. */
export function pixelSize(node: Node): { width: number | null; height: number | null } {
  const px = (value: string | undefined) => {
    const match = value?.trim().match(/^(\d+(?:\.\d+)?)(px)?$/);
    return match ? Number(match[1]) : null;
  };
  return { width: px(node.styles.width), height: px(node.styles.height) };
}

/** What the `href` of a link to another artboard starts with, followed by the artboard's id. */
const ARTBOARD_LINK = "#finite-artboard=";

/**
 * The artboard a link's `href` names, or null when it isn't a link to one.
 * The rule is a click's, and `flow::link_target` follows it: the raw
 * attribute, the exact prefix, no trimming, the rest percent-decoded. A
 * malformed escape stays as written, so it names no artboard.
 */
export function artboardLinkTarget(href: string): string | null {
  if (!href.startsWith(ARTBOARD_LINK)) return null;
  const id = href.slice(ARTBOARD_LINK.length);
  try {
    return decodeURIComponent(id);
  } catch {
    return id;
  }
}
