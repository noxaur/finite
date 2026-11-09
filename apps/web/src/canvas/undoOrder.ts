/**
 * Which of this person's undo stacks ⌘Z takes from. The server keeps two per person: source edits
 * per design (`source.undo`) and canvas patches per canvas (`canvas.undo`). This remembers the
 * order the person made them in, so the last action is the one undone, whichever kind it was.
 */
export type UndoStep =
  | { readonly kind: "source" }
  | { readonly kind: "canvas"; readonly canvasId: string };

const DEPTH = 200;

export interface UndoOrder {
  /** A new action: it goes on top, and what was undone can't be redone any more. */
  did(step: UndoStep): void;
  /** The step ⌘Z takes back, moved to the redo side. `undefined` when nothing's recorded. */
  undo(): UndoStep | undefined;
  /** The step ⇧⌘Z redoes, moved back to the undo side. */
  redo(): UndoStep | undefined;
  /** The server refused the step `undo` or `redo` just moved and dropped it, so it goes here too. */
  forget(which: "undo" | "redo"): void;
  /** Runs `request` after every earlier one has its reply, so ⌘Z always sees the newest edit. */
  inTurn<T>(request: () => Promise<T>): Promise<T>;
}

export function createUndoOrder(): UndoOrder {
  const done: UndoStep[] = [];
  const undone: UndoStep[] = [];
  let last: Promise<unknown> = Promise.resolve();
  return {
    did(step) {
      done.push(step);
      if (done.length > DEPTH) done.shift();
      undone.length = 0;
    },
    undo() {
      const step = done.pop();
      if (step) undone.push(step);
      return step;
    },
    redo() {
      const step = undone.pop();
      if (step) done.push(step);
      return step;
    },
    forget(which) {
      (which === "undo" ? undone : done).pop();
    },
    inTurn(request) {
      const result = last.then(request);
      last = result.catch(() => {});
      return result;
    },
  };
}

const orders = new Map<string, UndoOrder>();

/** This page's order for one design, kept while the page lives. */
export function undoOrderFor(designId: string): UndoOrder {
  let order = orders.get(designId);
  if (!order) orders.set(designId, (order = createUndoOrder()));
  return order;
}
