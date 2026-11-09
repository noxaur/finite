// How the frame-bridge model reads as a chart: what the person watching the canvas would notice.
const req = (v: any) => v.reqState.r1 ?? v.reqState[1];
const flag = (m: any) => m.r1 ?? m[1];

function frame(v: any): string {
  if (v.bridge === "before") return "Iframe mounting";
  if (v.bridge === "closed") return "Bridge closed";
  if (v.hostChan !== 0 && v.hostChanDoc !== v.doc) return "Reloading on the old connection";
  if (v.page === "blank") return "Page loading";
  if (v.page === "noBridge") return v.loadPending ? "Page loading" : "Page never answers";
  if (v.hostChan === 0)
    return v.helloMsg || v.loadPending ? "Page loading" : "Unreachable, no hello coming";
  return "Connected";
}

function request(v: any): string {
  if (flag(v.refusedNoReload)) return "Refused, though nothing reloaded";
  if (req(v) === "stranded") return "Stuck forever";
  if (req(v) === "waiting") return "Waiting for a connection";
  if (req(v) === "inflight") return flag(v.askedStale) ? "Sent to a page that's gone" : "Sent";
  return req(v) === "settled" ? "Finished" : "Not asked";
}

export const state = (v: any) => ({ Frame: frame(v), Request: request(v) });

export const title = "A frame loads and answers the canvas";

const labels: Record<string, string | null> = {
  EffectConnects: "the canvas mounts the frame",
  BridgeSaysHello: "the page says hello",
  PageNeverRunsBridge: "the page fails before its bridge runs",
  HelloHeard: "the canvas hears hello",
  LoadFires: "the iframe finishes loading",
  FrameTakesConnect: "the page takes the connection",
  CanvasAsks: "the canvas asks the frame something",
  FrameAnswers: "the frame answers",
  RequestTimesOut: "5 seconds pass with no answer",
  FrameReloads: "the page reloads",
  BridgeCloses: "the frame scrolls away, or its hug setting flips",
  EffectReruns: "the hug setting flipped, so a new bridge starts on the same page",
  HelloUnheard: "nobody hears the hello",
  LoadAfterClose: "the iframe finishes loading",
  ConnectHasNoListener: null,
  CanvasAsksClosed: null,
  FrameReportsError: null,
  Finished: null,
};

// Closing from these two states ends the same way as from the others; the chart keeps the main ones.
const quietCloses = new Set(["Reloading on the old connection", "Page never answers"]);

export const step = (action: string, from: any) => {
  if (action === "BridgeCloses" && quietCloses.has(frame(from))) return null;
  return action in labels ? labels[action] : action;
};
