import { useEffect, useRef } from "react";

interface Layer {
  readonly contains: (target: globalThis.Node | null) => boolean;
}

/** Open popups, oldest first. A popup opened from another sits above it. */
const layers: Layer[] = [];

/**
 * Closes a popup on Escape and on a press outside it. Popups stack: Escape
 * closes only the newest, and a press inside a newer popup, like a menu
 * opened from a panel, is not outside the panel. `contains` says what
 * counts as inside, such as the popup and the button that opened it.
 * `onEscape` runs first, to return focus; `closeOnScroll` also closes on a
 * scroll or resize elsewhere.
 */
export function useDismiss({
  contains,
  onClose,
  onEscape,
  closeOnScroll = false,
  enabled = true,
}: {
  contains: (target: globalThis.Node | null) => boolean;
  onClose: () => void;
  onEscape?: () => void;
  closeOnScroll?: boolean;
  /** Listens only while true, for a popup that stays mounted while closed. */
  enabled?: boolean;
}) {
  const latest = useRef({ contains, onClose, onEscape });
  latest.current = { contains, onClose, onEscape };
  useEffect(() => {
    if (!enabled) return;
    const layer: Layer = { contains: (t) => latest.current.contains(t) };
    layers.push(layer);
    const above = (target: globalThis.Node | null) =>
      layers.slice(layers.indexOf(layer) + 1).some((l) => l.contains(target));
    const outside = (target: globalThis.Node | null) => !layer.contains(target) && !above(target);
    const press = (e: PointerEvent) => {
      if (outside(e.target as globalThis.Node | null)) latest.current.onClose();
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || layers.at(-1) !== layer) return;
      e.stopPropagation();
      latest.current.onEscape?.();
      latest.current.onClose();
    };
    const leave = (e: Event) => {
      if (outside(e.target as globalThis.Node | null)) latest.current.onClose();
    };
    window.addEventListener("pointerdown", press, true);
    window.addEventListener("keydown", escape, true);
    if (closeOnScroll) {
      window.addEventListener("scroll", leave, true);
      window.addEventListener("resize", leave);
    }
    return () => {
      layers.splice(layers.indexOf(layer), 1);
      window.removeEventListener("pointerdown", press, true);
      window.removeEventListener("keydown", escape, true);
      window.removeEventListener("scroll", leave, true);
      window.removeEventListener("resize", leave);
    };
  }, [closeOnScroll, enabled]);
}
