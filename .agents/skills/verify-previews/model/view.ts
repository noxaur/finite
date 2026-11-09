// The words of the "You open a design and its preview starts" chart.
export const title = "You open a design and its preview starts";

export const state = (v: any) => {
  const s = v.s;
  switch (s.status) {
    case "detecting":
    case "needs-setup":
      return "Needs setup";
    case "starting":
      return "Starting";
    case "error":
      return "Preview failed";
    case "ready":
      if (s.viewer) return "Preview ready";
      return s.idleTimer ? "Ready, stopping soon" : "Ready, nobody watching, never stops";
    default:
      if (s.install === "running")
        return s.finished ? "Shows installing after it ended" : "Installing dependencies";
      if (s.install === "error") return "Install failed";
      return "Not running";
  }
};

const labels: Record<string, string | null> = {
  Subscribe: "you open the design",
  Unsubscribe: "you leave",
  IdleTimerFires: "a minute passes with nobody watching",
  InstallSucceeds: "the install finishes",
  InstallFails: "the install fails",
  LateOutput: "the installer prints one more line",
  InstallDoneEnsures: "the dev server launches",
  InstallFailEndsWait: null,
  DetectionEnds: null,
  PrepareSucceeds: "setup and services finish",
  PrepareFails: "something crashes",
  HostReady: "the dev server comes up",
  ChildCrashes: "something crashes",
  ServiceExits: "something crashes",
  StoppedChildExits: "the old dev server exits",
  FiniteJsonChanges: "you edit finite.json",
  RestartResumes: "the old dev server has stopped",
  EnsureResumes: "the old dev server has stopped",
};
// The idle stop of a run that's still starting or has failed adds an arrow per state and says
// nothing a person needs here; the chart keeps it where the preview was actually ready.
export const step = (action: string, from: any) => {
  if (action === "IdleTimerFires" && ["starting", "error"].includes(from.s.status)) return null;
  return action in labels ? labels[action] : action;
};

export const group = (v: any) => {
  const s = v.s;
  if (s.status === "error" || s.install === "error") return "failed";
  if (s.status === "ready") return "ready";
  if (s.status === "none" && s.install !== "running") return "off";
  return "working";
};
export const colors = { failed: "orange", ready: "teal", working: "blue", off: "tan" };
