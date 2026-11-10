// The wording of the chart: what the person sees in the text and on the canvas. check.sh doesn't read it.
const size = (s: unknown) => Object.keys((s ?? {}) as object).length;
const waiting = (v: any) =>
  size(v.preLock) > 0 || size(v.queue.a) > 0 || size(v.queue.b) > 0 || size(v.replies) > 0;

const text = (v: any) => {
  if (waiting(v)) return "Saving to the file";
  const by = v.file.a[1];
  if (by === "you") return "Your text is showing";
  if (by === "other")
    return size(v.srcUndo.you) > 0 ? "Someone wrote over your text" : "Someone else's text";
  return size(v.srcRedo.you) > 0 ? "Your edit undone" : "Original text";
};

const frame = (v: any) => {
  if (!v.frame.exists) return "Frame removed by someone";
  const by = v.frame.x[1];
  if (by === "you") return "Frame where you put it";
  if (by === "other")
    return size(v.canUndo.you) > 0 ? "Someone moved it after you" : "Frame where someone put it";
  return size(v.canRedo.you) > 0 ? "Your move undone" : "Frame at its first position";
};

// UNDO_CHART picks the chart: "text" and "frame" fit the chart budget; together they don't.
declare const process: { env: Record<string, string | undefined> };
const only = process.env.UNDO_CHART;
export const state = (v: any) =>
  only === "text" ? text(v) : only === "frame" ? frame(v) : { Text: text(v), Frame: frame(v) };

const labels: Record<string, string | null> = {
  YouStartEdit: "you edit the text",
  EditReachesLock: "the server starts writing",
  EditLands: "your edit saves",
  StepLands: "your undo or redo applies",
  StepRefused: "Finite refuses: that text changed",
  YouPressUndo: "you press undo",
  YouPressRedo: "you press redo",
  ReplyArrives: "the page hears back",
  YouMoveFrame: "you move the frame",
  OtherEdits: "someone else edits the text",
  OtherUndoes: "someone else undoes",
  OtherMovesFrame: "someone else moves the frame",
  OtherRemovesFrame: "someone else removes the frame",
  Settled: null,
};
export const step = (action: string) => labels[action] ?? null;
export const title =
  only === "frame"
    ? "You undo a frame move while someone else moves it"
    : "You undo and redo text while someone else edits it";
