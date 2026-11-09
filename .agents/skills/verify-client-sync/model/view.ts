// The chart of "Your connection drops while you work", in the words of the person at the page.
type Vars = { phase: string; req: string; runs: number };

const connection: Record<string, string> = {
  dialing: "Connecting",
  handshaking: "Saying hello",
  open: "Connected",
  closing: "Hello refused",
  backoff: "Waiting to reconnect",
};

function request(v: Vars): string {
  if (v.req === "none") return "Nothing sent";
  if (v.req === "waiting") return "Waiting for the connection";
  if (v.req === "sent") return v.runs > 0 ? "Server ran it, reply on its way" : "On its way";
  if (v.req === "lost") return "Asking again after the reconnect";
  if (v.req === "ok") return "Sent";
  if (v.req === "unknown") return "Outcome unknown";
  return v.runs > 0 ? "Shown as failed, but it ran" : "Shown as failed";
}

export const title = "Your connection drops while you work";

export const state = (v: Vars) => ({ Connection: connection[v.phase], "Your message": request(v) });

const labels: Record<string, string> = {
  SocketOpens: "the socket opens",
  HelloAccepted: "the server accepts hello",
  HelloRefused: "the server refuses hello",
  ConnectionDrops: "the connection drops",
  ClosingCompletes: "the socket closes",
  RetryFires: "the retry timer fires",
  YouSendRequest: "you send a message",
  ServerReceivesRequest: "the server gets it",
  ServerFinishes: "the server finishes it",
  ServerForgets: "the server forgets the reply",
  ServerRestarts: "the server restarts",
  RequestGivesUp: "the page stops asking",
  ReplyArrives: "the reply arrives",
  RequestTimesOut: "no reply in time, so the page asks again",
};

export const step = (action: string) => labels[action] ?? null;
