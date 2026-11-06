import type { Replica } from "./replica";
import { designModel } from "./wasm";

/** What a page's bootstrap starts with (see `html::bootstrap_script`). */
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
  const model = designModel();
  const { csp, baseCss, baseLayer } = model.rules;
  const tokens = replica.tokenStyle(id, false);
  const shared = tokens === "" ? "" : `<style>${tokens}</style>`;
  const bootstrap = model.bootstrapScript(boot.nonce, boot.storage);
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}">${bootstrap}<style>@layer ${baseLayer} { ${baseCss} html, body { margin: 0; } }</style>${shared}</head><body>${replica.exportHtml(id, true)}</body></html>`;
}

/**
 * The artboard a link's `href` names, or null when it isn't a link to one.
 * `flow::href_target` follows the rule, which is a click's: the raw
 * attribute, the exact prefix, no trimming, the rest percent-decoded. A
 * malformed escape stays as written, so it names no artboard.
 */
export function artboardLinkTarget(href: string): string | null {
  return designModel().artboardTarget(href);
}
