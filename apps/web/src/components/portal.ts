/**
 * Where a popup opened from `anchor` is portaled. A modal `<dialog>` sits in the browser's top
 * layer and makes the rest of the page inert, so no z-index lifts a popup over it and a popup
 * outside it can't be clicked. A popup opened inside an open dialog goes into that dialog;
 * anything else goes to the body. Fixed positioning still measures from the window there.
 */
export function popupHost(anchor: Element | null | undefined): HTMLElement {
  return anchor?.closest<HTMLDialogElement>("dialog[open]") ?? document.body;
}

/**
 * The event target as a DOM node, or null. A target can be the window, a MessagePort or another
 * non-node, and `Node.contains` throws on those.
 */
export function targetNode(target: EventTarget | null): Node | null {
  return typeof Node !== "undefined" && target instanceof Node ? target : null;
}
