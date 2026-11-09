// The /statechart view for AgentSession.tla: one thread, in the words of the person using it.
type S = Record<string, any>;
const s = (v: any): S => v.s;

export const title = "You send a message to an agent";

export const state = (v: any): string => {
  const t = s(v);
  if (t.removed) return "Setup thread closed";
  if (t.metaRunning && !t.live) return "Shown running, but no session exists";
  if (t.live && t.cli === "none") return "Claude Code has crashed";
  if (!t.metaRunning && t.cli === "working") return "Agent working, but shown as stopped";
  if (t.steerWait) return "Turn ended, waiting for your steer to start";
  if (t.cli === "winding") return "Cancelling the turn";
  if (t.metaRunning && t.cli === "working")
    return t.queued > 0 ? "Agent working, a message queued" : "Agent working";
  if (t.metaRunning) return "Message sent, turn starting";
  return t.queued > 0 ? "Stopped, queued message waiting" : "Nothing running";
};

const labels: Record<string, string | null> = {
  YouSendSteer: "you send a message",
  YouSendQueued: "you queue a message",
  YouPressStop: "you press Stop",
  CliStartsTurn: "the agent starts the turn",
  CliFinishesTurn: "the agent finishes the turn",
  CliCutsTurnForSteer: "your steer cuts the turn short",
  CliDropsSteer: "the steer's turn never starts",
  CliTakesInterrupt: "Claude Code takes the Stop",
  CliWindsDown: "the turn is cancelled",
  CliCrashes: "Claude Code crashes",
  RunSend: "Finite takes the message",
  DeliverPrepares: "the thread shows as running",
  DeliverPushes: "Finite sends the message on",
  RunInterrupt: "Finite asks Claude Code to stop",
  InterruptAnswered: "the thread shows as stopped",
  RunResult: "Finite handles the turn's result",
  RunGrace: "the 3 second wait runs out",
  RunDeadGrace: "the 3 second wait runs out on the dead session",
  RunEnded: "Finite reports the crash",
  RunIdle: "the idle session closes",
  ConsumeInit: "Finite sees the turn start",
  ConsumeResult: "the turn's result arrives",
  ConsumeEnd: "Finite sees the crash",
  IdleTimerFires: "the idle timer runs out",
  SteerGraceExpires: "the 3 second wait runs out",
  DeadGraceExpires: "the 3 second wait runs out on the dead session",
  InterruptFails: "the Stop fails",
  DeliverRejects: "the send fails",
};

// Crashes are drawn only from "Agent working", and a closing idle session isn't drawn: the rest
// repeat arrows that are already there.
export const step = (action: string, from: any): string | null => {
  if (action === "CliCrashes")
    return s(from).cli === "working" && s(from).queued === 0 && s(from).metaRunning
      ? labels[action]!
      : null;
  if (action === "RunIdle" || action === "IdleTimerFires") return null;
  return action in labels ? labels[action]! : null;
};

export const group = (v: any): string => {
  const t = s(v);
  if ((t.metaRunning && !t.live) || (!t.metaRunning && t.cli === "working")) return "wrong";
  if (t.cli === "working" || t.metaRunning) return "busy";
  return "rest";
};

export const colors = { wrong: "pink", busy: "blue", rest: "teal" };
