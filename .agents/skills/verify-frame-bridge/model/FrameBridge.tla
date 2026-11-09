---- MODULE FrameBridge ----
\* One iframe on the canvas and the two halves of its bridge.
\* Host half: connectFrame in apps/web/src/canvas/bridge.ts, run by the effect in FrameView.tsx:43-93.
\* Frame half: start/post/receive in packages/vite-plugin/src/client/bridge.ts.
\* Each action is one synchronous run of code, with no await inside it.
EXTENDS Naturals, Sequences

CONSTANTS
  Requests,      \* the canvas's calls: hit, rects, inspect, layers, drop, vector, measure, measureArea
  MaxDocs,       \* documents the iframe loads (2 = one reload)
  MaxRemounts,   \* times the effect re-runs on the same iframe
  \* The code as it stands has every toggle TRUE but AskHelloOnRemount and ChartOnly, and MaxRemounts 0.
  LoadFallback,          \* bridge.ts:130-134, a load with no hello connects anyway
  DropPendingOnHello,    \* bridge.ts:94, onHello refuses what was in flight
  TimerOnSend,           \* bridge.ts:144, the 5 s timer set in send()
  FlushAndSizeOnConnect, \* client/bridge.ts:1037-1038, flush the buffer and force a size report
  RejectWaitingOnClose,  \* bridge.ts:190-191, close() also rejects requests still waiting for a hello
  TimerWhileWaiting,     \* bridge.ts:144, a waiting request has the 5 s timer too
  NoticeUnload,          \* client/bridge.ts:1041 and bridge.ts:101-107, the frame says it's leaving
  IgnoreRepeatHello,     \* bridge.ts:87-90, the hello after a load's connect keeps its channel
  AskHelloOnRemount,     \* not taken: a new bridge asks a loaded frame to say hello again
  ChartOnly              \* chart.cfg only: leaves out steps that add states but nothing to the picture

VARIABLES
  bridge,      \* "before" (effect hasn't run), "open", "closed" (bridge.ts:70 `closed`)
  page,        \* "blank" (navigating), "live" (bridge script ran), "noBridge" (page never ran it)
  doc,         \* which document is in the iframe
  loadPending, \* the iframe's load event is still to come for this document
  helloMsg,    \* BRIDGE_HELLO posted and not yet read by the parent
  greeted,     \* bridge.ts:81
  helloDue,    \* bridge.ts:83, `port` came from a load, so its document's hello may still arrive
  chanTaken,   \* the frame took the channel in `port`, so it can say when it's leaving (ghost)
  hostChan,    \* bridge.ts:64 `port`: 0 is null, otherwise which MessageChannel
  hostChanDoc, \* the document that channel was opened for (ghost)
  nextChan,    \* the next MessageChannel to create
  connects,    \* BRIDGE_CONNECT messages on their way to the window
  frameChan,   \* client/bridge.ts:154 `port`
  reqState,    \* "unmade", "waiting" (bridge.ts:66 `waiting`), "inflight" (`pending`), "stranded", "settled"
  reqChan,     \* the channel a request was posted on
  reqDoc,      \* the document that channel belonged to (ghost)
  askedStale,  \* the request was posted on a channel whose document had already gone (ghost)
  refusedNoReload, \* refused with "The frame reloaded" although the document never changed (ghost)
  errorState,  \* the document's error report: "none", "buffered", "delivered"
  sizeChan,    \* the channel the frame last forced a size report on
  remounts

vars == <<bridge, page, doc, loadPending, helloMsg, greeted, helloDue, chanTaken, hostChan, hostChanDoc, nextChan,
          connects, frameChan, reqState, reqChan, reqDoc, askedStale, refusedNoReload,
          errorState, sizeChan, remounts>>

Init ==
  /\ bridge = "before" /\ page = "blank" /\ doc = 1 /\ loadPending = FALSE
  /\ helloMsg = FALSE /\ greeted = FALSE /\ helloDue = FALSE /\ chanTaken = FALSE /\ hostChan = 0 /\ hostChanDoc = 0 /\ nextChan = 1
  /\ connects = <<>> /\ frameChan = 0
  /\ reqState = [r \in Requests |-> "unmade"]
  /\ reqChan = [r \in Requests |-> 0]
  /\ reqDoc = [r \in Requests |-> 0]
  /\ askedStale = [r \in Requests |-> FALSE]
  /\ refusedNoReload = [r \in Requests |-> FALSE]
  /\ errorState = "none" /\ sizeChan = 0 /\ remounts = 0

\* bridge.ts:84-121, the body of onHello, minus `greeted`, which callers set.
OnHello(fromLoad) ==
  LET c == nextChan IN
  /\ hostChan' = c /\ hostChanDoc' = doc /\ nextChan' = c + 1
  /\ helloDue' = fromLoad /\ chanTaken' = FALSE
  /\ connects' = Append(connects, c)
  /\ reqState' = [r \in Requests |->
       CASE reqState[r] = "inflight" -> IF DropPendingOnHello THEN "settled" ELSE "inflight"
         [] reqState[r] = "waiting"  -> "inflight"
         [] OTHER -> reqState[r]]
  /\ reqChan' = [r \in Requests |-> IF reqState[r] = "waiting" THEN c ELSE reqChan[r]]
  /\ reqDoc'  = [r \in Requests |-> IF reqState[r] = "waiting" THEN doc ELSE reqDoc[r]]
  /\ refusedNoReload' = [r \in Requests |->
       refusedNoReload[r] \/ (DropPendingOnHello /\ reqState[r] = "inflight" /\ reqDoc[r] = doc)]

\* FrameView.tsx:44, connectFrame registers the window.
EffectConnects ==
  /\ bridge = "before" /\ bridge' = "open"
  /\ UNCHANGED <<page, doc, loadPending, helloMsg, greeted, helloDue, chanTaken, hostChan, hostChanDoc, nextChan,
                 connects, frameChan, reqState, reqChan, reqDoc, askedStale, refusedNoReload,
                 errorState, sizeChan, remounts>>

\* client/bridge.ts:1061, the last line of start().
BridgeSaysHello ==
  /\ page = "blank" /\ page' = "live" /\ helloMsg' = TRUE /\ loadPending' = TRUE
  /\ UNCHANGED <<bridge, doc, greeted, helloDue, chanTaken, hostChan, hostChanDoc, nextChan, connects, frameChan,
                 reqState, reqChan, reqDoc, askedStale, refusedNoReload, errorState, sizeChan, remounts>>

\* A page that fails before the bridge script runs, or one the plugin didn't serve.
PageNeverRunsBridge ==
  /\ ~ChartOnly \/ doc = 1
  /\ page = "blank" /\ page' = "noBridge" /\ loadPending' = TRUE
  /\ UNCHANGED <<bridge, doc, helloMsg, greeted, helloDue, chanTaken, hostChan, hostChanDoc, nextChan, connects, frameChan,
                 reqState, reqChan, reqDoc, askedStale, refusedNoReload, errorState, sizeChan, remounts>>

\* bridge.ts:50-52 reaches onHello through byWindow; unregistered or closed, nobody hears it.
HelloHeard ==
  /\ helloMsg /\ helloMsg' = FALSE /\ bridge = "open"
  /\ IF IgnoreRepeatHello /\ hostChan # 0 /\ helloDue
       THEN /\ helloDue' = FALSE
            /\ UNCHANGED <<greeted, chanTaken, hostChan, hostChanDoc, nextChan, connects, reqState, reqChan, reqDoc, refusedNoReload>>
       ELSE /\ greeted' = TRUE /\ OnHello(FALSE)
  /\ UNCHANGED <<bridge, page, doc, loadPending, frameChan, askedStale, errorState, sizeChan, remounts>>

HelloUnheard ==
  /\ helloMsg /\ helloMsg' = FALSE /\ bridge # "open"
  /\ UNCHANGED <<bridge, page, doc, loadPending, greeted, helloDue, chanTaken, hostChan, hostChanDoc, nextChan, connects,
                 frameChan, reqState, reqChan, reqDoc, askedStale, refusedNoReload, errorState, sizeChan, remounts>>

\* bridge.ts:130-134, onLoad. Left out: a load before the effect runs (see SKILL.md).
LoadFires ==
  /\ loadPending /\ loadPending' = FALSE /\ bridge = "open"
  /\ greeted' = FALSE
  /\ IF LoadFallback /\ ~greeted
       THEN OnHello(TRUE)
       ELSE UNCHANGED <<helloDue, chanTaken, hostChan, hostChanDoc, nextChan, connects, reqState, reqChan, reqDoc, refusedNoReload>>
  /\ UNCHANGED <<bridge, page, doc, helloMsg, frameChan, askedStale, errorState, sizeChan, remounts>>

\* close() removed the listener (bridge.ts:187).
LoadAfterClose ==
  /\ loadPending /\ loadPending' = FALSE /\ bridge = "closed"
  /\ UNCHANGED <<bridge, page, doc, helloMsg, greeted, helloDue, chanTaken, hostChan, hostChanDoc, nextChan, connects,
                 frameChan, reqState, reqChan, reqDoc, askedStale, refusedNoReload, errorState, sizeChan, remounts>>

\* client/bridge.ts:1027-1039. Its source and origin checks (1029-1033) are left out; see SKILL.md.
FrameTakesConnect ==
  /\ page = "live" /\ connects # <<>>
  /\ frameChan' = Head(connects) /\ connects' = Tail(connects)
  /\ errorState' = IF errorState = "buffered" /\ FlushAndSizeOnConnect THEN "delivered" ELSE errorState
  /\ sizeChan' = IF FlushAndSizeOnConnect THEN Head(connects) ELSE sizeChan
  /\ chanTaken' = (chanTaken \/ Head(connects) = hostChan)
  /\ UNCHANGED <<bridge, page, doc, loadPending, helloMsg, greeted, helloDue, hostChan, hostChanDoc, nextChan,
                 reqState, reqChan, reqDoc, askedStale, refusedNoReload, remounts>>

ConnectHasNoListener ==
  /\ page # "live" /\ connects # <<>> /\ connects' = Tail(connects)
  /\ UNCHANGED <<bridge, page, doc, loadPending, helloMsg, greeted, helloDue, chanTaken, hostChan, hostChanDoc, nextChan,
                 frameChan, reqState, reqChan, reqDoc, askedStale, refusedNoReload, errorState, sizeChan, remounts>>

\* bridge.ts:137-163, send() while open: `if (port) go(); else waiting.set(id, go)`.
CanvasAsks(r) ==
  /\ bridge = "open" /\ reqState[r] = "unmade"
  /\ IF hostChan # 0
       THEN /\ reqState' = [reqState EXCEPT ![r] = "inflight"]
            /\ reqChan' = [reqChan EXCEPT ![r] = hostChan]
            /\ reqDoc' = [reqDoc EXCEPT ![r] = hostChanDoc]
            \* A document that took the channel says when it's leaving; one that never took it can't,
            \* so a request in that gap times out. It isn't a request made during a reload.
            /\ askedStale' = [askedStale EXCEPT ![r] = hostChanDoc # doc /\ chanTaken]
       ELSE /\ reqState' = [reqState EXCEPT ![r] = "waiting"]
            /\ UNCHANGED <<reqChan, reqDoc, askedStale>>
  /\ UNCHANGED <<bridge, page, doc, loadPending, helloMsg, greeted, helloDue, chanTaken, hostChan, hostChanDoc, nextChan,
                 connects, frameChan, refusedNoReload, errorState, sizeChan, remounts>>

\* bridge.ts:141, a closed bridge rejects at once.
CanvasAsksClosed(r) ==
  /\ ~ChartOnly
  /\ bridge = "closed" /\ reqState[r] = "unmade"
  /\ reqState' = [reqState EXCEPT ![r] = "settled"]
  /\ UNCHANGED <<bridge, page, doc, loadPending, helloMsg, greeted, helloDue, chanTaken, hostChan, hostChanDoc, nextChan,
                 connects, frameChan, reqChan, reqDoc, askedStale, refusedNoReload, errorState, sizeChan, remounts>>

\* client/bridge.ts:891-907, receive(), then the reply or refusal over the port.
FrameAnswers(r) ==
  /\ reqState[r] = "inflight" /\ page = "live" /\ reqChan[r] = frameChan
  /\ reqState' = [reqState EXCEPT ![r] = "settled"]
  /\ UNCHANGED <<bridge, page, doc, loadPending, helloMsg, greeted, helloDue, chanTaken, hostChan, hostChanDoc, nextChan,
                 connects, frameChan, reqChan, reqDoc, askedStale, refusedNoReload, errorState, sizeChan, remounts>>

\* bridge.ts:144-148.
RequestTimesOut(r) ==
  /\ \/ reqState[r] = "inflight" /\ TimerOnSend
     \/ reqState[r] = "waiting" /\ TimerWhileWaiting
  /\ reqState' = [reqState EXCEPT ![r] = "settled"]
  /\ UNCHANGED <<bridge, page, doc, loadPending, helloMsg, greeted, helloDue, chanTaken, hostChan, hostChanDoc, nextChan,
                 connects, frameChan, reqChan, reqDoc, askedStale, refusedNoReload, errorState, sizeChan, remounts>>

\* client/bridge.ts:157-160 (post) and reportError at :952: errors buffer before connect.
FrameReportsError ==
  /\ ~ChartOnly
  /\ page = "live" /\ errorState = "none"
  /\ errorState' = IF frameChan = 0 THEN "buffered" ELSE "delivered"
  /\ UNCHANGED <<bridge, page, doc, loadPending, helloMsg, greeted, helloDue, chanTaken, hostChan, hostChanDoc, nextChan,
                 connects, frameChan, reqState, reqChan, reqDoc, askedStale, refusedNoReload, sizeChan, remounts>>

\* The iframe navigates. With NoticeUnload a document that took the channel posts `leaving` from
\* pagehide; a page with no bridge, or one that never took the channel, says nothing.
FrameReloads ==
  /\ page # "blank" /\ doc < MaxDocs
  /\ ~ChartOnly \/ (hostChan # 0 /\ ~loadPending)
  /\ page' = "blank" /\ doc' = doc + 1
  /\ loadPending' = FALSE /\ helloMsg' = FALSE /\ connects' = <<>>
  /\ frameChan' = 0 /\ errorState' = "none" /\ sizeChan' = 0
  /\ IF NoticeUnload /\ bridge = "open" /\ page = "live" /\ chanTaken
       THEN /\ hostChan' = 0 /\ hostChanDoc' = 0 /\ greeted' = FALSE /\ helloDue' = FALSE /\ chanTaken' = FALSE
            /\ reqState' = [r \in Requests |-> IF reqState[r] = "inflight" THEN "settled" ELSE reqState[r]]
       ELSE UNCHANGED <<hostChan, hostChanDoc, greeted, helloDue, chanTaken, reqState>>
  /\ UNCHANGED <<bridge, nextChan, reqChan, reqDoc, askedStale, refusedNoReload, remounts>>

\* bridge.ts:185-196, close(). Without RejectWaitingOnClose, a waiting request is left and never settles.
BridgeCloses ==
  /\ ~ChartOnly \/ remounts = 0
  /\ bridge = "open" /\ bridge' = "closed"
  /\ hostChan' = 0 /\ hostChanDoc' = 0 /\ helloDue' = FALSE /\ chanTaken' = FALSE
  /\ reqState' = [r \in Requests |->
       CASE reqState[r] = "inflight" -> "settled"
         [] reqState[r] = "waiting"  -> IF RejectWaitingOnClose THEN "settled" ELSE "stranded"
         [] OTHER -> reqState[r]]
  /\ UNCHANGED <<page, doc, loadPending, helloMsg, greeted, nextChan, connects, frameChan,
                 reqChan, reqDoc, askedStale, refusedNoReload, errorState, sizeChan, remounts>>

\* A new connectFrame on the same loaded iframe. FrameView.tsx:93 no longer depends on `hug`, so
\* current.cfg sets MaxRemounts to 0: a remount now only comes with a new iframe or a new src.
EffectReruns ==
  /\ bridge = "closed" /\ remounts < MaxRemounts
  /\ ~ChartOnly \/ page = "live"
  /\ bridge' = "open" /\ remounts' = remounts + 1 /\ greeted' = FALSE
  /\ helloMsg' = (helloMsg \/ (AskHelloOnRemount /\ page = "live"))
  /\ UNCHANGED <<page, doc, loadPending, helloDue, chanTaken, hostChan, hostChanDoc, nextChan, connects, frameChan,
                 reqState, reqChan, reqDoc, askedStale, refusedNoReload, errorState, sizeChan>>

Busy ==
  \/ EffectConnects \/ BridgeSaysHello \/ PageNeverRunsBridge \/ HelloHeard \/ HelloUnheard
  \/ LoadFires \/ LoadAfterClose \/ FrameTakesConnect \/ ConnectHasNoListener \/ FrameReportsError
  \/ FrameReloads \/ BridgeCloses \/ EffectReruns
  \/ \E r \in Requests : CanvasAsks(r) \/ CanvasAsksClosed(r) \/ FrameAnswers(r) \/ RequestTimesOut(r)

\* Nothing left to happen; keeps a finished run from counting as a deadlock.
Finished == ~ENABLED Busy /\ UNCHANGED vars

Next ==
  \/ EffectConnects \/ BridgeSaysHello \/ PageNeverRunsBridge \/ HelloHeard \/ HelloUnheard
  \/ LoadFires \/ LoadAfterClose \/ FrameTakesConnect \/ ConnectHasNoListener \/ FrameReportsError
  \/ FrameReloads \/ BridgeCloses \/ EffectReruns
  \/ \E r \in Requests : CanvasAsks(r) \/ CanvasAsksClosed(r) \/ FrameAnswers(r) \/ RequestTimesOut(r)
  \/ Finished

\* The browser and the frame get on with it. The person (reload, unmount, resize) may never act.
Fairness ==
  /\ WF_vars(EffectConnects) /\ WF_vars(BridgeSaysHello \/ PageNeverRunsBridge)
  /\ WF_vars(HelloHeard) /\ WF_vars(HelloUnheard) /\ WF_vars(LoadFires) /\ WF_vars(LoadAfterClose)
  /\ WF_vars(FrameTakesConnect) /\ WF_vars(ConnectHasNoListener)
  /\ \A r \in Requests : WF_vars(FrameAnswers(r)) /\ WF_vars(RequestTimesOut(r))

Spec == Init /\ [][Next]_vars /\ Fairness

\* chart.cfg's VIEW: the same picture for any channel numbering.
ChartView == <<bridge, page, doc, loadPending, helloMsg, greeted, remounts, reqState,
               askedStale, refusedNoReload, hostChan # 0, hostChanDoc = doc, frameChan = hostChan,
               connects # <<>>>>

\* ---- Rules ----

\* close() leaves no promise that can never settle.
ClosedBridgeStrandsNothing == \A r \in Requests : reqState[r] # "stranded"

\* The doc comment on connectFrame: requests made before the new hello wait for it.
RequestsMadeDuringAReloadWait == \A r \in Requests : ~askedStale[r]

\* "The frame reloaded" means it did.
OnlyARealReloadRefuses == \A r \in Requests : ~refusedNoReload[r]

\* An open bridge on a running frame always has a connection or a way to get one.
LiveFrameStaysReachable ==
  ~(bridge = "open" /\ page = "live" /\ hostChan = 0 /\ ~helloMsg /\ ~loadPending)

\* The doc comment: requests in flight when the frame reloads are refused.
ReloadedRequestsAreRefused ==
  \A r \in Requests : (reqState[r] = "inflight" /\ bridge = "open") => reqChan[r] = hostChan

\* A first-mounted page that never says hello still fails its requests: the load fallback connects.
NoBridgePageDoesNotHang ==
  (remounts = 0 /\ bridge = "open" /\ page = "noBridge" /\ ~loadPending)
    => \A r \in Requests : reqState[r] # "waiting"

\* The frame half: an error before connect reaches the canvas once connected.
BufferedErrorsFlushOnConnect == frameChan # 0 => errorState # "buffered"

\* The frame half: every connect is followed by a size report, which hug frames depend on.
ConnectReportsSize == frameChan # 0 => sizeChan = frameChan

\* Every request ends: answered, refused, timed out or rejected.
EveryRequestSettles ==
  \A r \in Requests : (reqState[r] \in {"waiting", "inflight", "stranded"}) ~> (reqState[r] = "settled")
====
