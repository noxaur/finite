/** How far an element's strokes reach past its border box on each side, in CSS pixels. */
export interface Outset {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

/**
 * How far an element's strokes reach outside its border box: its `outline`,
 * and each outer `box-shadow` with no blur, which is how a stroke is written
 * as a shadow. Soft shadows don't count, since an outline drawn around their
 * blur would float far from the element. crates/design/src/bootstrap.js
 * repeats this for sandboxed artboards, which can't import it.
 */
export function strokeOutset(
  css: Pick<CSSStyleDeclaration, "outlineStyle" | "outlineWidth" | "outlineOffset" | "boxShadow">,
): Outset {
  let top = 0;
  let right = 0;
  let bottom = 0;
  let left = 0;
  if (css.outlineStyle !== "none") {
    const reach = (parseFloat(css.outlineWidth) || 0) + (parseFloat(css.outlineOffset) || 0);
    top = right = bottom = left = Math.max(0, reach);
  }
  // Split the list on commas outside of color functions like rgb(…).
  for (const shadow of css.boxShadow.split(/,(?![^(]*\))/)) {
    if (/\binset\b/.test(shadow)) continue;
    const [x = 0, y = 0, blur = 0, spread = 0] = (shadow.match(/-?[\d.]+px/g) ?? []).map(
      parseFloat,
    );
    if (blur > 0) continue;
    top = Math.max(top, spread - y);
    right = Math.max(right, spread + x);
    bottom = Math.max(bottom, spread + y);
    left = Math.max(left, spread - x);
  }
  return { top, right, bottom, left };
}
