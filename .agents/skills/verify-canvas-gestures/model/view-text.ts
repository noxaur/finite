// How /statechart words the "You edit text on the canvas" chart (config: chart-text.cfg).
export const title = "You edit text on the canvas";

export const state = (v: any) => {
  if (v.lostTyped) return "Your typed text is gone";
  const stuck = v.hidden.filter((e: string) => e !== v.editing);
  if (stuck.length > 0) return "Another element stays invisible";
  if (v.editing !== "none") {
    const stale = v.targetRev !== v.fileRev;
    if (v.typed) return stale ? "Typing, file changed underneath you" : "Typing";
    return stale ? "Editor open, file changed underneath you" : "Editor open";
  }
  if (v.landing.length > 0) return "Saving your text";
  if (v.opening.length > 0) return "Opening the editor";
  return "Not editing";
};

// Arrows that only appear once a second element is racing the first; the chart keeps the one that
// shows the element left invisible.
const hidden = new Set([
  "Editor open>Opening the editor",
  "Typing>Opening the editor",
  "Editor open, file changed underneath you>Opening the editor",
  "Typing, file changed underneath you>Opening the editor",
  "Saving your text>Opening the editor",
  "Saving your text>Editor open",
  "Editor open, file changed underneath you>Your typed text is gone",
  "Typing, file changed underneath you>Your typed text is gone",
  "Typing>Another element stays invisible",
  "Editor open, file changed underneath you>Another element stays invisible",
  "Typing, file changed underneath you>Another element stays invisible",
]);

export const step = (action: string, from: any, to: any) => {
  if (hidden.has(`${state(from)}>${state(to)}`)) return null;
  switch (action) {
    case "DoubleClickText":
      return "you double-click text";
    case "EditorOpens":
      return "the editor opens";
    case "YouType":
      return "you type";
    case "OutsideEdit":
      return "an agent edits the same file";
    case "KeepText":
      return "you press Enter or click away";
    case "DiscardText":
      return "you press Escape";
    case "EditLands":
      return to.lostTyped && !from.lostTyped
        ? "the server refuses the edit"
        : "the server saves it";
    case "Done":
      return null;
    default:
      return action;
  }
};
