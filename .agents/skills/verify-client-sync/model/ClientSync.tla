---- MODULE ClientSync ----
\* The page's one connection to the Finite server: apps/web/src/client/finite.ts, against the
\* server's apps/server/src/hub.ts and the subscribe handler in apps/server/src/handlers.ts.
\* One design, one thread and one request stand for any number; they don't interact.
\* Each action is one synchronous run in the code: split at every await and every socket callback.
EXTENDS Naturals, Sequences

CONSTANTS
  Parts,                \* subset of {"designs", "request", "thread"}: which pieces are switched on
  MaxFails,             \* how many times the connection, hello or history may fail in one run
  MaxPageMoves,         \* how many times the page may hold or release the design
  \* Variants. `current.cfg` is the code as it stands.
  ResetBackoffAtHello,  \* fixed: `attempt = 0` moves from onopen to the hello reply
  ReportUnknown,        \* fixed: a request whose outcome can't be learned settles "unknown", not "failed"
  Remember,             \* broken when FALSE: the server runs a `once` request every time it's asked
  CheckMemory,          \* broken when FALSE: the page asks again even when hello's `memory` changed
  UnsubscribeStale,     \* fixed: a snapshot for a design nobody holds sends `unsubscribe`
  ClearStreamingOnLoad, \* fixed: loadThread drops `streaming` when the history has the final text
  KeepLoadingOnFailure, \* fixed: loadThread leaves `loaded` false when the load failed
  Resume,               \* broken when FALSE: resume() doesn't resubscribe held designs
  Flush,                \* broken when FALSE: the hello reply doesn't send `waiting`
  SendBeforeHello       \* broken when TRUE: request() sends without checking `ready`

VARIABLES
  phase,       \* socket, ready, retryTimer: dialing | handshaking | open | closing | backoff
  attempt,     \* `attempt`, finite.ts connect
  failures,    \* failed connections since the last accepted hello; the model's own count
  failsLeft,   \* the budget from MaxFails
  held,        \* holds + lingering + views: none | held | lingering
  moves,       \* the budget from MaxPageMoves
  subWaiting,  \* `subscribe` requests sitting in `waiting`
  wire,        \* subscribe and unsubscribe messages on the socket, in order: "S" or "U"
  opening,     \* subscribes the server is running, between `await hub.open` and the add
  serverSub,   \* client.subscriptions on the server for this socket
  replies,     \* subscribe snapshots on their way back
  req,         \* one mutating request, like thread.send: none | waiting | sent | lost | ok | failed | unknown
  runs,        \* how many times the server has run that request
  ledger,      \* the server's memory of its id, replies.ts: none | running | done
  frames,      \* copies of the request on the socket
  answer,      \* its reply is on the socket
  joined,      \* this socket gets the reply when the running request finishes
  forgotten,   \* the server's `memory` name changed since the page's last hello
  turn,        \* the agent's turn on the server: running | finished
  deltaSent,   \* the server has streamed text for this turn
  tsub,        \* this socket receives the thread's events
  streaming,   \* ThreadView.streaming is non-empty
  final,       \* ThreadView.events holds the turn's final text
  loaded,      \* ThreadView.loaded
  history,     \* ThreadView.events holds the stored history
  hist         \* the thread.history request: none | waiting | sent

connVars == <<phase, attempt, failures, failsLeft>>
designVars == <<held, moves, subWaiting, wire, opening, serverSub, replies>>
reqVars == <<req, runs, ledger, frames, answer, joined, forgotten>>
threadVars == <<turn, deltaSent, tsub, streaming, final, loaded, history, hist>>
vars == <<connVars, designVars, reqVars, threadVars>>

D == "designs" \in Parts
Q == "request" \in Parts
T == "thread" \in Parts

\* start() has run: holdDesign and holdThread both call request(), which calls start().
Init ==
  /\ phase = "dialing" /\ attempt = 0 /\ failures = 0 /\ failsLeft = MaxFails
  /\ held = "none" /\ moves = MaxPageMoves /\ subWaiting = 0 /\ wire = <<>>
  /\ opening = 0 /\ serverSub = FALSE /\ replies = 0
  /\ req = "none" /\ runs = 0 /\ ledger = "none" /\ frames = 0
  /\ answer = FALSE /\ joined = FALSE /\ forgotten = FALSE
  /\ turn = "running" /\ deltaSent = FALSE /\ tsub = FALSE /\ streaming = FALSE
  /\ final = FALSE /\ loaded = FALSE /\ history = FALSE
  /\ hist = IF T THEN "waiting" ELSE "none"

Lost == IF ReportUnknown THEN "unknown" ELSE "failed"

\* ws.onopen in finite.ts connect. The hello goes out in the same callback.
\* ResetBackoffAtHello keeps `attempt` until hello; otherwise onopen zeroes it.
SocketOpens ==
  /\ phase = "dialing"
  /\ phase' = "handshaking"
  /\ attempt' = IF ResetBackoffAtHello THEN attempt ELSE 0
  /\ UNCHANGED <<failures, failsLeft, designVars, reqVars, threadVars>>

\* askAgain in finite.ts: the server still remembers everything the page sent. Age isn't a case here: the page
\* stops asking (GIVE_UP_MS) before the server forgets by age (REPLY_KEPT_MS); see RequestGivesUp.
AskAgain == req = "lost" /\ (~forgotten \/ ~CheckMemory)

\* The hello reply's .then in finite.ts connect: zero `attempt`, ready, askAgain, flush `waiting`, then resume().
HelloAccepted ==
  /\ phase = "handshaking"
  /\ phase' = "open"
  /\ attempt' = IF ResetBackoffAtHello THEN 0 ELSE attempt
  /\ failures' = 0
  /\ subWaiting' = IF Flush THEN 0 ELSE subWaiting
  /\ wire' = (IF Flush THEN [i \in 1..subWaiting |-> "S"] ELSE <<>>)
             \o (IF Resume /\ held # "none" THEN <<"S">> ELSE <<>>)
  /\ req' = CASE req = "waiting" /\ Flush -> "sent"
             [] AskAgain -> "sent"
             [] req = "lost" -> Lost
             [] OTHER -> req
  /\ frames' = IF (req = "waiting" /\ Flush) \/ AskAgain THEN frames + 1 ELSE frames
  /\ forgotten' = FALSE
  /\ hist' = IF T THEN "sent" ELSE hist
  /\ tsub' = T
  /\ UNCHANGED <<failsLeft, held, moves, opening, serverSub, replies, runs, ledger, answer, joined,
                 turn, deltaSent, streaming, final, loaded, history>>

\* The .catch of the hello request in finite.ts connect: hello was refused or timed out, so it calls ws.close().
HelloRefused ==
  /\ phase = "handshaking" /\ failsLeft > 0
  /\ phase' = "closing"
  /\ failsLeft' = failsLeft - 1
  /\ UNCHANGED <<attempt, failures, designVars, reqVars, threadVars>>

\* ws.onclose in finite.ts connect, then retry(). `once` requests stay in `pending` for
\* askAgain, the rest are rejected; `waiting` stays.
\* The server drops this socket's subscriptions on its own close, hub.ts connect's close handler.
Closed ==
  /\ phase' = "backoff"
  /\ attempt' = attempt + 1
  /\ failures' = failures + 1
  /\ wire' = <<>> /\ opening' = 0 /\ serverSub' = FALSE /\ replies' = 0
  /\ req' = IF req = "sent" THEN "lost" ELSE req
  /\ frames' = 0 /\ answer' = FALSE /\ joined' = FALSE
  /\ tsub' = FALSE
  /\ hist' = IF hist = "sent" THEN "none" ELSE hist
  /\ loaded' = IF hist = "sent" /\ ~KeepLoadingOnFailure THEN TRUE ELSE loaded \* finite.ts loadThread's catch
  /\ UNCHANGED <<held, moves, subWaiting, runs, turn, deltaSent, streaming, final, history>>

\* Also the page closing a socket that stayed silent after a request was asked again.
ConnectionDrops ==
  /\ phase \in {"dialing", "handshaking", "open"} /\ failsLeft > 0
  /\ failsLeft' = failsLeft - 1
  /\ ledger' = ledger /\ forgotten' = forgotten
  /\ Closed

ClosingCompletes ==
  /\ phase = "closing"
  /\ failsLeft' = failsLeft
  /\ ledger' = ledger /\ forgotten' = forgotten
  /\ Closed

\* The process dies, so its memory goes with it. A request it was running may have taken effect.
ServerRestarts ==
  /\ Q /\ phase \in {"dialing", "handshaking", "open"} /\ failsLeft > 0
  /\ failsLeft' = failsLeft - 1
  /\ ledger' = "none" /\ forgotten' = TRUE
  /\ Closed

\* retryTimer, finite.ts retry(), into connect().
RetryFires ==
  /\ phase = "backoff"
  /\ phase' = "dialing"
  /\ UNCHANGED <<attempt, failures, failsLeft, designVars, reqVars, threadVars>>

\* holdDesign in finite.ts. A lingering design is still subscribed, so holding it sends nothing.
PageHolds ==
  /\ D /\ moves > 0 /\ held # "held"
  /\ moves' = moves - 1
  /\ held' = "held"
  /\ IF held = "none"
       THEN IF phase = "open"
              THEN wire' = Append(wire, "S") /\ subWaiting' = subWaiting
              ELSE subWaiting' = subWaiting + 1 /\ wire' = wire
       ELSE UNCHANGED <<wire, subWaiting>>
  /\ UNCHANGED <<connVars, opening, serverSub, replies, reqVars, threadVars>>

\* The release holdDesign returns, finite.ts.
PageReleases ==
  /\ D /\ moves > 0 /\ held = "held"
  /\ moves' = moves - 1
  /\ held' = "lingering"
  /\ UNCHANGED <<connVars, subWaiting, wire, opening, serverSub, replies, reqVars, threadVars>>

\* The linger timer in holdDesign's release, finite.ts. `unsubscribe` goes only `if (ready)`.
LingerExpires ==
  /\ held = "lingering"
  /\ held' = "none"
  /\ wire' = IF phase = "open" THEN Append(wire, "U") ELSE wire
  /\ UNCHANGED <<connVars, moves, subWaiting, opening, serverSub, replies, reqVars, threadVars>>

\* hub.ts connect's message handler runs each message as it arrives, with no queue. subscribe stops at `await hub.open`.
ServerReceivesSubscribe ==
  /\ phase = "open" /\ wire # <<>> /\ Head(wire) = "S"
  /\ wire' = Tail(wire)
  /\ opening' = opening + 1
  /\ UNCHANGED <<connVars, held, moves, subWaiting, serverSub, replies, reqVars, threadVars>>

\* The unsubscribe handler has no await: handlers.ts unsubscribe.
ServerReceivesUnsubscribe ==
  /\ phase = "open" /\ wire # <<>> /\ Head(wire) = "U"
  /\ wire' = Tail(wire)
  /\ serverSub' = FALSE
  /\ UNCHANGED <<connVars, held, moves, subWaiting, opening, replies, reqVars, threadVars>>

\* After `await hub.open`, handlers.ts subscribe: `client.subscriptions.add(designId)`.
ServerAddsSubscription ==
  /\ phase = "open" /\ opening > 0
  /\ opening' = opening - 1
  /\ serverSub' = TRUE
  /\ replies' = replies + 1
  /\ UNCHANGED <<connVars, held, moves, subWaiting, wire, reqVars, threadVars>>

\* subscribeDesign after its await, finite.ts. Nobody holds it, so it
\* sends `unsubscribe` when UnsubscribeStale, and otherwise says nothing.
SnapshotArrives ==
  /\ phase = "open" /\ replies > 0
  /\ replies' = replies - 1
  /\ wire' = IF UnsubscribeStale /\ held = "none" THEN Append(wire, "U") ELSE wire
  /\ UNCHANGED <<connVars, held, moves, subWaiting, opening, serverSub, reqVars, threadVars>>

\* request() in finite.ts. Its frame carries `once`, and track keeps the frame.
YouSendRequest ==
  /\ Q /\ req = "none"
  /\ IF phase = "open" \/ (SendBeforeHello /\ phase = "handshaking")
       THEN req' = "sent" /\ frames' = frames + 1
       ELSE req' = "waiting" /\ frames' = frames
  /\ UNCHANGED <<connVars, designVars, runs, ledger, answer, joined, forgotten, threadVars>>

\* hub.ts receive, through replies.ask. Each frame is one synchronous run: new, running or done.
ServerReceivesRequest ==
  /\ phase = "open" /\ frames > 0
  /\ frames' = frames - 1
  /\ joined' = TRUE
  /\ IF Remember
       THEN CASE ledger = "none" -> runs' = runs + 1 /\ ledger' = "running" /\ answer' = answer
              [] ledger = "running" -> UNCHANGED <<runs, ledger, answer>>
              [] ledger = "done" -> answer' = TRUE /\ UNCHANGED <<runs, ledger>>
       ELSE runs' = runs + 1 /\ answer' = TRUE /\ ledger' = ledger
  /\ UNCHANGED <<connVars, designVars, req, forgotten, threadVars>>

\* replies.finish: stores the reply and sends it to the sockets that asked. A closed one drops it.
ServerFinishes ==
  /\ ledger = "running"
  /\ ledger' = "done"
  /\ answer' = (answer \/ joined)
  /\ UNCHANGED <<connVars, designVars, req, runs, frames, joined, forgotten, threadVars>>

\* replies.finish forgets an early reply when too many are stored, and renames the memory.
\* Needs 1000 later replies to finish inside one trip, so never while a copy or a reply travels.
ServerForgets ==
  /\ ledger = "done" /\ frames = 0 /\ ~answer /\ failsLeft > 0
  /\ failsLeft' = failsLeft - 1
  /\ ledger' = "none" /\ forgotten' = TRUE
  /\ UNCHANGED <<phase, attempt, failures, designVars, req, runs, frames, answer, joined, threadVars>>

\* receive() in finite.ts. A late copy's reply hits `if (!p) return`.
ReplyArrives ==
  /\ phase = "open" /\ req = "sent" /\ answer
  /\ req' = "ok" /\ answer' = FALSE
  /\ UNCHANGED <<connVars, designVars, runs, ledger, frames, joined, forgotten, threadVars>>

\* overdue() in finite.ts: asks again on the same socket.
RequestTimesOut ==
  /\ phase = "open" /\ req = "sent" /\ failsLeft > 0
  /\ failsLeft' = failsLeft - 1
  /\ frames' = frames + 1
  /\ UNCHANGED <<phase, attempt, failures, designVars, req, runs, ledger, answer, joined, forgotten, threadVars>>

\* GIVE_UP_MS in overdue() and askAgain: too old to ask about, so the outcome stays unknown.
\* It stands in for the server forgetting by age, which only happens after this.
RequestGivesUp ==
  /\ req \in {"sent", "lost"} /\ failsLeft > 0
  /\ failsLeft' = failsLeft - 1
  /\ req' = Lost
  /\ UNCHANGED <<phase, attempt, failures, designVars, runs, ledger, frames, answer, joined, forgotten, threadVars>>

\* A text.delta thread event, finite.ts appendThreadEvent. Missed when the socket is down.
ServerStreamsText ==
  /\ T /\ turn = "running" /\ ~deltaSent
  /\ deltaSent' = TRUE
  /\ streaming' = (tsub \/ streaming)
  /\ UNCHANGED <<connVars, designVars, reqVars, turn, tsub, final, loaded, history, hist>>

\* The `text`/`result` thread event, finite.ts appendThreadEvent. Missed when the socket is down.
TurnFinishes ==
  /\ T /\ turn = "running"
  /\ turn' = "finished"
  /\ streaming' = (streaming /\ ~tsub)
  /\ final' = (final \/ tsub)
  /\ UNCHANGED <<connVars, designVars, reqVars, deltaSent, tsub, loaded, history, hist>>

\* loadThread after its await, finite.ts. streamingAfter (finite.ts)
\* drops `streaming` when ClearStreamingOnLoad and the history has the final text.
\* The server's read and the reply are one step here; see "left out" in SKILL.md.
HistoryArrives ==
  /\ phase = "open" /\ hist = "sent"
  /\ hist' = "none"
  /\ loaded' = TRUE /\ history' = TRUE
  /\ final' = (final \/ turn = "finished")
  /\ streaming' = (streaming /\ ~(ClearStreamingOnLoad /\ turn = "finished"))
  /\ UNCHANGED <<connVars, designVars, reqVars, turn, deltaSent, tsub>>

\* loadThread's catch, finite.ts. KeepLoadingOnFailure leaves `loaded` false.
HistoryRefused ==
  /\ phase = "open" /\ hist = "sent" /\ failsLeft > 0
  /\ failsLeft' = failsLeft - 1
  /\ hist' = "none"
  /\ loaded' = IF KeepLoadingOnFailure THEN loaded ELSE TRUE
  /\ UNCHANGED <<phase, attempt, failures, designVars, reqVars, turn, deltaSent, tsub, streaming, final, history>>

Steps ==
  \/ SocketOpens \/ HelloAccepted \/ HelloRefused \/ ConnectionDrops \/ ClosingCompletes
  \/ RetryFires
  \/ PageHolds \/ PageReleases \/ LingerExpires
  \/ ServerReceivesSubscribe \/ ServerReceivesUnsubscribe \/ ServerAddsSubscription \/ SnapshotArrives
  \/ YouSendRequest \/ ServerReceivesRequest \/ ServerFinishes \/ ReplyArrives \/ RequestTimesOut
  \/ RequestGivesUp \/ ServerForgets \/ ServerRestarts
  \/ ServerStreamsText \/ TurnFinishes \/ HistoryArrives \/ HistoryRefused

\* The connected page with nothing left to do. Any other stuck state is a deadlock TLC reports.
Done == phase = "open" /\ ~ENABLED Steps /\ UNCHANGED vars

Next ==
  \/ SocketOpens \/ HelloAccepted \/ HelloRefused \/ ConnectionDrops \/ ClosingCompletes
  \/ RetryFires
  \/ PageHolds \/ PageReleases \/ LingerExpires
  \/ ServerReceivesSubscribe \/ ServerReceivesUnsubscribe \/ ServerAddsSubscription \/ SnapshotArrives
  \/ YouSendRequest \/ ServerReceivesRequest \/ ServerFinishes \/ ReplyArrives \/ RequestTimesOut
  \/ RequestGivesUp \/ ServerForgets \/ ServerRestarts
  \/ ServerStreamsText \/ TurnFinishes \/ HistoryArrives \/ HistoryRefused
  \/ Done

\* Timers fire, and the server keeps answering once the failure budget has run out.
Fairness ==
  /\ WF_vars(SocketOpens) /\ WF_vars(HelloAccepted) /\ WF_vars(ClosingCompletes) /\ WF_vars(RetryFires)
  /\ WF_vars(ServerReceivesRequest) /\ WF_vars(ServerFinishes) /\ WF_vars(ReplyArrives)

Spec == Init /\ [][Next]_vars /\ Fairness

\* Rules. Each is true of a connected page that has finished talking to the server, or of every state.
Quiet == phase = "open" /\ wire = <<>> /\ opening = 0 /\ replies = 0 /\ subWaiting = 0

\* The retry delay grows for as long as connections keep failing.
BackoffGrows == phase = "backoff" => attempt >= failures

\* A design on screen is subscribed once the page has settled.
HeldDesignSubscribed == (Quiet /\ held = "held") => serverSub

\* A design nobody shows isn't subscribed once the page has settled.
ReleasedDesignUnsubscribed == (Quiet /\ held = "none") => ~serverSub

\* The server never gets a request before hello.
NoRequestBeforeHello == phase = "handshaking" => req # "sent"

\* A request the page calls failed did not run.
FailedMeansNotApplied == req = "failed" => runs = 0

\* However often the page asks, the server runs a request at most once.
AtMostOnce == runs <= 1

\* A finished turn's partial text doesn't sit beside its final text.
NoStaleStreaming == ~(streaming /\ final)

\* A thread with messages never shows as loaded and empty.
LoadedMeansHistory == loaded => history

\* A request settles, given the server comes back. The file's header promises it waits until then.
RequestSettles == req \in {"waiting", "sent", "lost"} ~> req \in {"ok", "failed", "unknown"}
====
