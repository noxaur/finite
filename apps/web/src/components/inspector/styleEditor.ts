import type { Loc } from "@finite/protocol";
import { bridgeOf } from "@/canvas/bridge";

/**
 * What the inspector edits: one selected element. `id` is its selection key; `styles` holds the
 * styles it sets itself, which the bridge can't tell apart from the cascade, so the fields read
 * the browser's values (`computed`) and every edit writes through the design's convention.
 */
export interface Target {
  readonly id: string;
  readonly parent: string | null;
  readonly styles: Readonly<Record<string, string>>;
}

/** CSS properties to set (or remove, `null`) on some targets. */
export interface StyleEdit {
  readonly kind: "setStyles";
  readonly ids: ReadonlyArray<string>;
  readonly styles: Readonly<Record<string, string | null>>;
}

/**
 * One edit from a field that shows as it's made: typing, scrubbing, picking a color. It
 * previews in the frame through the bridge and commits as one `source.edit`. After `commit`
 * or `cancel` it does nothing, so a late blur can't send it twice.
 */
export interface Draft {
  preview(edits: ReadonlyArray<StyleEdit> | null): string | null;
  commit(final?: ReadonlyArray<StyleEdit>): void;
  cancel(): void;
}

export interface Pointer {
  readonly x: number;
  readonly y: number;
  readonly shift: boolean;
  readonly free: boolean;
}

/** A pointer gesture a field starts, like scrubbing a label. */
export interface PanelRun {
  move(pointer: Pointer): ReadonlyArray<StyleEdit> | null;
  readonly live?: boolean;
  end?(committed: boolean): void;
  keep?(): boolean;
}

export interface StyleEditor {
  begin(options?: { onLost?: (reason: string) => void }): Draft;
  drive(e: PointerEvent, element: HTMLElement, run: PanelRun): () => void;
  commit(edits: ReadonlyArray<StyleEdit>): Promise<void>;
}

export type Located = { frameId: string; loc: Loc };

/**
 * The inspector's editor: previews through each target's frame bridge, and sends what's kept
 * with `send` (the canvas editor's style edit, which carries the revs and handles refusals).
 */
export function createStyleEditor(
  locate: (id: string) => Located | undefined,
  send: (groups: Array<{ locs: Loc[]; styles: Record<string, string | null> }>) => Promise<unknown>,
): StyleEditor {
  let open: { edits: ReadonlyArray<StyleEdit> | null } | null = null;
  let shown = new Map<string, Located>();

  const show = (edits: ReadonlyArray<StyleEdit> | null) => {
    const next = new Map<string, { at: Located; styles: Record<string, string | null> }>();
    for (const e of edits ?? []) {
      for (const id of e.ids) {
        const at = locate(id);
        if (!at) continue;
        const key = `${at.frameId}|${at.loc}`;
        const entry = next.get(key) ?? { at, styles: {} };
        Object.assign(entry.styles, e.styles);
        next.set(key, entry);
      }
    }
    for (const [key, at] of shown) if (!next.has(key)) bridgeOf(at.frameId)?.preview(at.loc, null);
    for (const { at, styles } of next.values()) bridgeOf(at.frameId)?.preview(at.loc, styles);
    shown = new Map([...next].map(([k, v]) => [k, v.at]));
  };

  const commit = async (edits: ReadonlyArray<StyleEdit>) => {
    const groups = edits
      .map((e) => ({
        locs: [...new Set(e.ids.map((id) => locate(id)?.loc).filter((l): l is Loc => !!l))],
        styles: { ...e.styles },
      }))
      .filter((g) => g.locs.length > 0 && Object.keys(g.styles).length > 0);
    if (groups.length === 0) return show(null);
    // The preview stays until the frame's HMR update replaces it with the real thing.
    shown = new Map();
    await send(groups);
  };

  const finishOpen = () => {
    const o = open;
    open = null;
    if (o?.edits) void commit(o.edits);
    else show(null);
  };

  const editor: StyleEditor = {
    begin() {
      finishOpen();
      const mine = { edits: null as ReadonlyArray<StyleEdit> | null };
      open = mine;
      const live = () => open === mine;
      return {
        preview(edits) {
          if (!live()) return null;
          mine.edits = edits;
          show(edits);
          return null;
        },
        commit(final) {
          if (!live()) return;
          open = null;
          const edits = final ?? mine.edits;
          if (edits && edits.length > 0) void commit(edits);
          else show(null);
        },
        cancel() {
          if (!live()) return;
          open = null;
          show(null);
        },
      };
    },
    drive(e, element, run) {
      if (e.button !== 0) return () => {};
      finishOpen();
      const from = { x: e.clientX, y: e.clientY };
      let started = false;
      let edits: ReadonlyArray<StyleEdit> | null = null;
      const listen = new AbortController();
      const { signal } = listen;
      let done = false;
      const stop = (keep: boolean) => {
        if (done) return;
        done = true;
        listen.abort();
        if (keep && edits) void commit(edits);
        else show(null);
        run.end?.(keep && edits !== null);
      };
      const onMove = (m: PointerEvent) => {
        if (!started && Math.hypot(m.clientX - from.x, m.clientY - from.y) < 3) return;
        if (!started) {
          started = true;
          element.setPointerCapture(e.pointerId);
        }
        edits = run.move({
          x: m.clientX,
          y: m.clientY,
          shift: m.shiftKey,
          free: m.metaKey || m.ctrlKey,
        });
        if (run.live !== false) show(edits);
      };
      element.addEventListener("pointermove", onMove, { signal });
      window.addEventListener("pointermove", (m) => document.pointerLockElement && onMove(m), {
        signal,
      });
      element.addEventListener("pointerup", () => stop(true), { signal });
      window.addEventListener("pointerup", () => stop(true), { signal });
      element.addEventListener("pointercancel", () => stop(false), { signal });
      element.addEventListener("lostpointercapture", () => run.keep?.() || stop(true), { signal });
      window.addEventListener(
        "keydown",
        (k) => {
          if (k.key === "Escape") stop(false);
        },
        { signal },
      );
      return () => stop(false);
    },
    commit,
  };
  return editor;
}
