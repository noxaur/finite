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
  ReportUnknown,        \* fixed: a request lost on the wire settles "unknown", not "failed"
  UnsubscribeStale,     \* fixed: a snapshot for a design nobody holds sends `unsubscribe`
  ClearStreamingOnLoad, \* fixed: loadThread drops `streaming` when the history has the final text
  KeepLoadingOnFailure, \* fixed: loadThread leaves `loaded` false when the load failed
  Resume,               \* broken when FALSE: resume() doesn't resubscribe held designs
  Flush,                \* broken when FALSE: the hello reply doesn't send `waiting`
  SendBeforeHello       \* broken when TRUE: request() sends without checking `ready`

VARIABLES
  phase,       \* socket, ready, retryTimer: dialing | handshaking | open | closing | backoff
  attempt,     \* `attempt`, finite.ts:147
  failures,    \* failed connections since the last accepted hello; the model's own count
  failsLeft,   \* the budget from MaxFails
  held,        \* holds + lingering + views: none | held | lingering
  moves,       \* the budget from MaxPageMoves
  subWaiting,  \* `subscribe` requests sitting in `waiting`
  wire,        \* subscribe and unsubscribe messages on the socket, in order: "S" or "U"
  opening,     \* subscribes the server is running, between `await hub.open` and the add
  serverSub,   \* client.subscriptions on the server for this socket
  replies,     \* subscribe snapshots on their way back
  req,         \* one mutating request, like thread.send: none | waiting | sent | ok | failed | unknown
  applied,     \* the server ran that request
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
reqVars == <<req, applied>>
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
  /\ req = "none" /\ applied = FALSE
  /\ turn = "running" /\ deltaSent = FALSE /\ tsub = FALSE /\ streaming = FALSE
  /\ final = FALSE /\ loaded = FALSE /\ history = FALSE
  /\ hist = IF T THEN "waiting" ELSE "none"

Lost == IF ReportUnknown THEN "unknown" ELSE "failed"

\* ws.onopen, finite.ts:204. The hello goes out in the same callback.
\* ResetBackoffAtHello keeps `attempt` until hello; otherwise onopen zeroes it.
SocketOpens ==
  /\ phase = "dialing"
  /\ phase' = "handshaking"
  /\ attempt' = IF ResetBackoffAtHello THEN attempt ELSE 0
  /\ UNCHANGED <<failures, failsLeft, designVars, reqVars, threadVars>>

\* The hello reply's .then, finite.ts:207-215: zero `attempt`, ready, flush `waiting`, then resume().
HelloAccepted ==
  /\ phase = "handshaking"
  /\ phase' = "open"
  /\ attempt' = IF ResetBackoffAtHello THEN 0 ELSE attempt
  /\ failures' = 0
  /\ subWaiting' = IF Flush THEN 0 ELSE subWaiting
  /\ wire' = (IF Flush THEN [i \in 1..subWaiting |-> "S"] ELSE <<>>)
             \o (IF Resume /\ held # "none" THEN <<"S">> ELSE <<>>)
  /\ req' = IF Flush /\ req = "waiting" THEN "sent" ELSE req
  /\ hist' = IF T THEN "sent" ELSE hist
  /\ tsub' = T
  /\ UNCHANGED <<failsLeft, held, moves, opening, serverSub, replies, applied,
                 turn, deltaSent, streaming, final, loaded, history>>

\* The .catch at finite.ts:216: hello was refused or timed out, so it calls ws.close().
HelloRefused ==
  /\ phase = "handshaking" /\ failsLeft > 0
  /\ phase' = "closing"
  /\ failsLeft' = failsLeft - 1
  /\ UNCHANGED <<attempt, failures, designVars, reqVars, threadVars>>

\* ws.onclose, finite.ts:230-245, then retry() at :244. `pending` is rejected; `waiting` stays.
\* The server drops this socket's subscriptions on its own close, hub.ts:101-105.
Closed ==
  /\ phase' = "backoff"
  /\ attempt' = attempt + 1
  /\ failures' = failures + 1
  /\ wire' = <<>> /\ opening' = 0 /\ serverSub' = FALSE /\ replies' = 0
  /\ req' = IF req = "sent" THEN Lost ELSE req
  /\ tsub' = FALSE
  /\ hist' = IF hist = "sent" THEN "none" ELSE hist
  /\ loaded' = IF hist = "sent" /\ ~KeepLoadingOnFailure THEN TRUE ELSE loaded \* finite.ts:472-475
  /\ UNCHANGED <<held, moves, subWaiting, applied, turn, deltaSent, streaming, final, history>>

ConnectionDrops ==
  /\ phase \in {"dialing", "handshaking", "open"} /\ failsLeft > 0
  /\ failsLeft' = failsLeft - 1
  /\ Closed

ClosingCompletes ==
  /\ phase = "closing"
  /\ failsLeft' = failsLeft
  /\ Closed

\* retryTimer, finite.ts:252, into connect().
RetryFires ==
  /\ phase = "backoff"
  /\ phase' = "dialing"
  /\ UNCHANGED <<attempt, failures, failsLeft, designVars, reqVars, threadVars>>

\* holdDesign, finite.ts:429-437. A lingering design is still subscribed, so holding it sends nothing.
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

\* The release, finite.ts:439-456.
PageReleases ==
  /\ D /\ moves > 0 /\ held = "held"
  /\ moves' = moves - 1
  /\ held' = "lingering"
  /\ UNCHANGED <<connVars, subWaiting, wire, opening, serverSub, replies, reqVars, threadVars>>

\* The linger timer, finite.ts:446-453. `unsubscribe` goes only `if (ready)`.
LingerExpires ==
  /\ held = "lingering"
  /\ held' = "none"
  /\ wire' = IF phase = "open" THEN Append(wire, "U") ELSE wire
  /\ UNCHANGED <<connVars, moves, subWaiting, opening, serverSub, replies, reqVars, threadVars>>

\* hub.ts:97 runs each message as it arrives, with no queue. subscribe stops at `await hub.open`.
ServerReceivesSubscribe ==
  /\ phase = "open" /\ wire # <<>> /\ Head(wire) = "S"
  /\ wire' = Tail(wire)
  /\ opening' = opening + 1
  /\ UNCHANGED <<connVars, held, moves, subWaiting, serverSub, replies, reqVars, threadVars>>

\* The unsubscribe handler has no await: handlers.ts:91-93.
ServerReceivesUnsubscribe ==
  /\ phase = "open" /\ wire # <<>> /\ Head(wire) = "U"
  /\ wire' = Tail(wire)
  /\ serverSub' = FALSE
  /\ UNCHANGED <<connVars, held, moves, subWaiting, opening, replies, reqVars, threadVars>>

\* After `await hub.open`, handlers.ts:73: `client.subscriptions.add(designId)`.
ServerAddsSubscription ==
  /\ phase = "open" /\ opening > 0
  /\ opening' = opening - 1
  /\ serverSub' = TRUE
  /\ replies' = replies + 1
  /\ UNCHANGED <<connVars, held, moves, subWaiting, wire, reqVars, threadVars>>

\* subscribeDesign after its await, finite.ts:407. Nobody holds it, so finite.ts:410
\* sends `unsubscribe` when UnsubscribeStale, and otherwise says nothing.
SnapshotArrives ==
  /\ phase = "open" /\ replies > 0
  /\ replies' = replies - 1
  /\ wire' = IF UnsubscribeStale /\ held = "none" THEN Append(wire, "U") ELSE wire
  /\ UNCHANGED <<connVars, held, moves, subWaiting, opening, serverSub, reqVars, threadVars>>

\* request(), finite.ts:342-354.
YouSendRequest ==
  /\ Q /\ req = "none"
  /\ req' = IF phase = "open" \/ (SendBeforeHello /\ phase = "handshaking") THEN "sent" ELSE "waiting"
  /\ UNCHANGED <<connVars, designVars, applied, threadVars>>

ServerRunsRequest ==
  /\ phase = "open" /\ req = "sent" /\ ~applied
  /\ applied' = TRUE
  /\ UNCHANGED <<connVars, designVars, req, threadVars>>

\* receive(), finite.ts:282-290.
ReplyArrives ==
  /\ phase = "open" /\ req = "sent" /\ applied
  /\ req' = "ok"
  /\ UNCHANGED <<connVars, designVars, applied, threadVars>>

\* track()'s timer, finite.ts:266-275. A late reply then hits `if (!p) return`.
RequestTimesOut ==
  /\ req = "sent"
  /\ req' = Lost
  /\ UNCHANGED <<connVars, designVars, applied, threadVars>>

\* A text.delta thread event, finite.ts:333. Missed when the socket is down.
ServerStreamsText ==
  /\ T /\ turn = "running" /\ ~deltaSent
  /\ deltaSent' = TRUE
  /\ streaming' = (tsub \/ streaming)
  /\ UNCHANGED <<connVars, designVars, reqVars, turn, tsub, final, loaded, history, hist>>

\* The `text`/`result` thread event, finite.ts:336. Missed when the socket is down.
TurnFinishes ==
  /\ T /\ turn = "running"
  /\ turn' = "finished"
  /\ streaming' = (streaming /\ ~tsub)
  /\ final' = (final \/ tsub)
  /\ UNCHANGED <<connVars, designVars, reqVars, deltaSent, tsub, loaded, history, hist>>

\* loadThread after its await, finite.ts:459-471. streamingAfter (finite.ts:124)
\* drops `streaming` when ClearStreamingOnLoad and the history has the final text.
\* The server's read and the reply are one step here; see "left out" in SKILL.md.
HistoryArrives ==
  /\ phase = "open" /\ hist = "sent"
  /\ hist' = "none"
  /\ loaded' = TRUE /\ history' = TRUE
  /\ final' = (final \/ turn = "finished")
  /\ streaming' = (streaming /\ ~(ClearStreamingOnLoad /\ turn = "finished"))
  /\ UNCHANGED <<connVars, designVars, reqVars, turn, deltaSent, tsub>>

\* loadThread's catch, finite.ts:472-475. KeepLoadingOnFailure leaves `loaded` false.
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
  \/ YouSendRequest \/ ServerRunsRequest \/ ReplyArrives \/ RequestTimesOut
  \/ ServerStreamsText \/ TurnFinishes \/ HistoryArrives \/ HistoryRefused

\* The connected page with nothing left to do. Any other stuck state is a deadlock TLC reports.
Done == phase = "open" /\ ~ENABLED Steps /\ UNCHANGED vars

Next ==
  \/ SocketOpens \/ HelloAccepted \/ HelloRefused \/ ConnectionDrops \/ ClosingCompletes
  \/ RetryFires
  \/ PageHolds \/ PageReleases \/ LingerExpires
  \/ ServerReceivesSubscribe \/ ServerReceivesUnsubscribe \/ ServerAddsSubscription \/ SnapshotArrives
  \/ YouSendRequest \/ ServerRunsRequest \/ ReplyArrives \/ RequestTimesOut
  \/ ServerStreamsText \/ TurnFinishes \/ HistoryArrives \/ HistoryRefused
  \/ Done

\* Timers fire, and the server keeps answering once the failure budget has run out.
Fairness ==
  /\ WF_vars(SocketOpens) /\ WF_vars(HelloAccepted) /\ WF_vars(ClosingCompletes) /\ WF_vars(RetryFires)
  /\ WF_vars(ServerRunsRequest) /\ WF_vars(ReplyArrives)

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
FailedMeansNotApplied == req = "failed" => ~applied

\* A finished turn's partial text doesn't sit beside its final text.
NoStaleStreaming == ~(streaming /\ final)

\* A thread with messages never shows as loaded and empty.
LoadedMeansHistory == loaded => history

\* A request settles, given the server comes back. The file's header promises it waits until then.
RequestSettles == req \in {"waiting", "sent"} ~> req \in {"ok", "failed", "unknown"}
====
