// The wording of the "You draw or drag on the canvas" chart (config: chart-draw.cfg). check.sh doesn't read it.
const presses = [1, 2];

export const title = "You draw or drag on the canvas";

export const state = (v: any) => {
  if (v.killed) return "Your second drag was cancelled";
  const c = v.current;
  if (v.dragging && !(c !== 0 && v.gesture[c] === "live")) return "Canvas stuck showing a drag";
  const landing = presses.some((p) => ["ending", "clicking", "awaitingBegin"].includes(v.phase[p]));
  if (c !== 0 && landing) return "Pressing again while the last shape lands";
  if (landing) return "Let go, shape on its way";
  if (c === 0 && presses.some((p) => v.phase[p] === "cancelled"))
    return "Cancelled, frame still answering";
  if (c === 0) return "Nothing pressed";
  if (v.gesture[c] === "live") return "Dragging";
  if (v.gesture[c] === "pending") return "Drag starting, waiting on the frame";
  return "Pressed, not moved yet";
};

// Arrows that only repeat what the others show: a new press overlapping a cancel still in flight,
// and every way out of the stuck state but one.
const hidden = new Set([
  "Pressed, not moved yet>Cancelled, frame still answering",
  "Pressed, not moved yet>Canvas stuck showing a drag",
  "Let go, shape on its way>Cancelled, frame still answering",
  "Let go, shape on its way>Canvas stuck showing a drag",
  "Drag starting, waiting on the frame>Canvas stuck showing a drag",
  "Cancelled, frame still answering>Pressed, not moved yet",
  "Dragging>Cancelled, frame still answering",
  "Canvas stuck showing a drag>Let go, shape on its way",
  "Canvas stuck showing a drag>Cancelled, frame still answering",
  "Canvas stuck showing a drag>Dragging",
]);

export const step = (action: string, from: any, to: any) => {
  if (hidden.has(`${state(from)}>${state(to)}`)) return null;
  switch (action) {
    case "PressDown":
      return "you press";
    case "DragPastSlop":
      return "you move past 3 pixels";
    case "BeginResolves":
      return "the frame answers";
    case "PressUp":
      return "you let go";
    case "CancelPress":
    case "PickTool":
      return "you press Escape or pick a tool";
    case "Finished":
      return "the shape lands";
    default:
      return action;
  }
};
