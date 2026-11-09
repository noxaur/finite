// /statechart view for EditDrafts.tla. Pair it with chart-inspector.cfg or chart-composer.cfg.
type V = Record<string, any>;

const inspectorState = ({ insp: i }: V) => {
  if (i.lost) return "What you typed never saved";
  if (i.handle && i.open !== "field") return "Field no longer connected to the frame";
  if (i.scrub !== "none")
    return i.scrub === "moving" ? "Scrubbing, frame shows the drag" : "Pressing a scrub label";
  if (i.typed === "whole") return "Typing a value, frame shows it";
  if (i.typed === "partial") return "Typing, not a full value yet";
  return i.focus ? "Field focused" : "Not editing";
};

const composerState = ({ send: s }: V) => {
  if (Object.values(s.delivered as Record<string, number>).some((n) => n > 1))
    return "Agent got the message twice";
  if (s.lostText) return "What you typed during the send is gone";
  const chipBusy = Object.values(s.chip as Record<string, string>).some(
    (c) => c !== "idle" && c !== "done",
  );
  if (chipBusy) return "Send now under way";
  if (s.flight !== "none") return "Sending your message";
  if (Object.keys(s.queued).length > 0)
    return s.running ? "Agent working, message queued" : "Agent stopped, message still queued";
  if (s.text !== "") return "Writing a message";
  return s.running ? "Agent working" : "Idle";
};

export const state = (v: V) => (v.area === "inspector" ? inspectorState(v) : composerState(v));

const labels: Record<string, string | null> = {
  YouFocusTheField: "you click into the field",
  YouTypeAWholeValue: "you type a value",
  YouTypeAPartialValue: "you type part of a value",
  YouPressAScrubLabel: "you press a scrub label",
  YouDragTheScrub: "you drag",
  YouReleaseTheScrub: "you let go",
  YouEscapeTheScrub: "you press Escape",
  TheBrowserBlursTheField: "the browser takes focus off the field",
  YouLeaveTheField: "you leave the field",
  YouEscapeTheField: "you press Escape",
  TheEditLands: null,
  YouWriteAMessage: "you write a message",
  YouKeepTypingDuringTheSend: "you keep typing",
  YouPressSendWhileIdle: "you press Send",
  YouSteerTheRunningTurn: "you steer",
  YouQueueForTheNextTurn: "you queue",
  TheServerQueuesIt: "the server queues it",
  TheServerDeliversIt: "the agent gets it",
  TheSendIsAnswered: "the send finishes",
  TheSendFails: "the send fails",
  TheTurnEndsAndTakesTheQueue: "the turn ends, next message goes",
  TheTurnEnds: "the turn ends",
  YouPressStop: "you press Stop",
  YouPressSendNow: "you press Send now",
  TheServerAnswersTheDequeue: "the server answers",
  TheDequeueIsLost: "the connection drops",
  TheChipGoesOnToSend: "Finite sends it anyway",
  TheServerSteersItIn: "the agent gets it",
  Finished: null,
};

export const step = (action: string) => (action in labels ? labels[action] : action);
