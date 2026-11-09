---- MODULE AgentSession ----
\* One thread and its Claude Code session, from apps/server/src/agent/index.ts at the commit in
\* SKILL.md. `s` is one record so each action names only the fields it writes. Line numbers are
\* that file's unless another file is named.
\*
\* Atomicity. `inThread` (:284) runs one thread's sends, results, interrupts and timers one at a
\* time, so a section is cut only where something outside the lock can act: the CLI, the consume
\* loop (:449) and snooze/settle. The awaits inside deliver before the push touch no field those
\* actors read, so they stay in DeliverPrepares.
EXTENDS Naturals, Sequences

CONSTANTS
  MaxSends, MaxStops, MaxCrashes, MaxRestarts, MaxGrants,
  SetupThread,   \* the thread is a setup thread, so finish_setup can mark it replaced
  MayReject,     \* deliver can reject before it marks running (setModel, applyFlagSettings, reads)
  Mutant         \* "none", or the name of one removed guard

VARIABLE s
vars == <<s>>

\* "cancelled" is any result answering a message sent before a Stop (`answersStop`), however the
\* turn really ended. The real results carry `user_message_uuid`, so the server can tell.
Results == {"result0", "result1", "cancelled"}

Init == s = [
  \* ThreadMeta, persisted (packages/protocol/src/model.ts:331)
  metaRunning |-> FALSE, queued |-> 0, snoozed |-> FALSE, settled |-> FALSE,
  \* Live (:224)
  live |-> FALSE, running |-> FALSE, steers |-> 0, steerWait |-> FALSE, heldSteers |-> 0,
  betweenTurns |-> FALSE, idleArmed |-> FALSE, prodWrite |-> FALSE, replaced |-> FALSE,
  \* The serial lock's queue, the running section's step, what it is pushing, a dead Live's timer
  lock |-> <<>>, pc |-> "free", priority |-> FALSE, popped |-> FALSE,
  \* The CLI: "none" (no process), "idle", "working", "winding" (cancelling a turn)
  \* `turnOld`: the turn in the CLI answers a message sent before a Stop (Live.stopped).
  cli |-> "none", inbox |-> 0, steerPending |-> 0, mayDrop |-> FALSE, turnOld |-> FALSE,
  stream |-> <<>>, consumeBusy |-> FALSE, interruptAsked |-> FALSE, receipt |-> FALSE,
  \* Ghost: facts the code doesn't hold but the rules need
  sessions |-> 0, lastEnd |-> "none", lost |-> 0, grantCarried |-> FALSE, popAfterStop |-> FALSE,
  stopNoSend |-> FALSE, replacedEver |-> FALSE, removed |-> FALSE, turnNo |-> 0, initsRead |-> 0,
  grantTurn |-> 0,
  \* Bounds
  sends |-> 0, stops |-> 0, crashes |-> 0, restarts |-> 0, grants |-> 0
]

Release(st) == [st EXCEPT !.lock = Tail(st.lock), !.pc = "free", !.popped = FALSE]

\* The sections of one Live that no longer run once it's gone (`live.closing`, identity checks).
NotOfLive(x) == x \notin (Results \cup {"ended", "grace", "idle"})

\* shut (:644): a closing session; consume returns quietly (:476, :491).
Shut(st) == [st EXCEPT
  !.live = FALSE, !.running = FALSE, !.idleArmed = FALSE, !.steerWait = FALSE,
  !.steers = 0, !.prodWrite = FALSE, !.replaced = FALSE, !.turnOld = FALSE,
  !.cli = "none", !.inbox = 0, !.steerPending = 0, !.stream = <<>>, !.consumeBusy = FALSE,
  !.interruptAsked = FALSE, !.receipt = FALSE, !.sessions = st.sessions - 1,
  !.lock = SelectSeq(st.lock, NotOfLive)]

\* removeSetup: the session ends with its design.
RemoveSetup(st) == [Shut(Release(st)) EXCEPT !.removed = TRUE]

\* finishTurn (:551), past the `more` return.
FinishTurn(st) ==
  LET base == [st EXCEPT !.prodWrite = FALSE]
  IN IF st.queued > 0
     THEN [base EXCEPT
            !.queued = st.queued - 1, !.pc = "deliverPrepares", !.priority = FALSE,
            !.popped = TRUE, !.consumeBusy = FALSE,
            !.popAfterStop = st.popAfterStop \/ st.stopNoSend]
     ELSE LET ended == [base EXCEPT
                !.running = FALSE, !.metaRunning = FALSE, !.lastEnd = "finished",
                !.consumeBusy = FALSE]
          IN IF st.replaced THEN RemoveSetup(ended) ELSE Release([ended EXCEPT !.idleArmed = TRUE])

\* ---- What people do ----

YouSendSteer ==
  /\ ~s.removed /\ s.sends < MaxSends
  /\ s' = [s EXCEPT !.lock = Append(s.lock, "sendSteer"), !.sends = s.sends + 1]

YouSendQueued ==
  /\ ~s.removed /\ s.sends < MaxSends
  /\ s' = [s EXCEPT !.lock = Append(s.lock, "sendQueue"), !.sends = s.sends + 1]

\* The composer's Stop shows while the thread is marked running.
YouPressStop ==
  /\ ~s.removed /\ s.metaRunning /\ s.stops < MaxStops
  /\ s' = [s EXCEPT !.lock = Append(s.lock, "interrupt"), !.stops = s.stops + 1]

\* handlers.ts thread.snooze and thread.settle, outside the lock; each writes only its own field.
YouSnooze == ~s.removed /\ s' = [s EXCEPT !.snoozed = ~s.snoozed]
YouSettle == ~s.removed /\ s' = [s EXCEPT !.settled = ~s.settled]

\* ---- Sections, run one at a time ----

Free == s.pc = "free" /\ s.lock /= <<>> /\ ~s.removed
Head1 == Head(s.lock)

\* sendNow (:707)
RunSend ==
  /\ Free /\ Head1 \in {"sendSteer", "sendQueue"}
  /\ IF s.live /\ s.running /\ Head1 = "sendQueue"
     THEN s' = Release([s EXCEPT !.queued = s.queued + 1])
     ELSE IF s.live /\ s.running
     THEN s' = [s EXCEPT !.steers = s.steers + 1, !.pc = "deliverPrepares", !.priority = TRUE]
     ELSE IF s.live /\ Mutant /= "second-session"
     THEN s' = [s EXCEPT !.pc = "deliverPrepares", !.priority = FALSE]
     ELSE \* start (:301), registered at :439 with no idle timer and running false
          s' = [s EXCEPT
            !.live = TRUE, !.running = FALSE, !.steers = 0,
            !.betweenTurns = FALSE, !.idleArmed = FALSE, !.prodWrite = FALSE, !.replaced = FALSE,
            !.cli = "idle", !.inbox = 0, !.steerPending = 0, !.stream = <<>>,
            !.sessions = s.sessions + 1, !.pc = "deliverPrepares", !.priority = FALSE]

\* deliver (:656) up to the thread write (:679): clears idle, marks running, then revives.
DeliverPrepares ==
  /\ s.pc = "deliverPrepares"
  /\ s' = [s EXCEPT
       !.idleArmed = FALSE, !.running = TRUE, !.metaRunning = TRUE, !.stopNoSend = FALSE,
       !.snoozed = IF Mutant = "send-keeps-hidden" THEN s.snoozed ELSE FALSE,
       !.settled = IF Mutant = "send-keeps-hidden" THEN s.settled ELSE FALSE,
       !.pc = "deliverPushes"]

\* setModel, applyFlagSettings or reading the canvases rejected (:675): idle goes back on.
DeliverRejects ==
  /\ MayReject /\ s.pc = "deliverPrepares" /\ ~s.popped
  /\ s' = Release([s EXCEPT !.idleArmed = s.live /\ ~s.running])

\* :703. A Live that ended has an ended inbox, so the push does nothing (inbox(), push).
DeliverPushes ==
  /\ s.pc = "deliverPushes"
  /\ IF s.live
     THEN s' = Release([s EXCEPT
            !.inbox = s.inbox + 1,
            !.steerPending = s.steerPending + (IF s.priority THEN 1 ELSE 0),
            !.betweenTurns = s.priority /\ s.betweenTurns])
     ELSE s' = Release([s EXCEPT !.lost = s.lost + 1])

\* A result still waiting behind Stop answers a message sent before it.
Old(x) == IF x \in {"result0", "result1"} THEN "cancelled" ELSE x
Olds(q) == [i \in 1..Len(q) |-> Old(q[i])]

\* interrupt (:771), up to `await live.query.interrupt({ cancelQueued: true })` (:783)
RunInterrupt ==
  /\ Free /\ Head1 = "interrupt"
  /\ IF s.live /\ s.running
     THEN s' = [s EXCEPT
            !.running = FALSE, !.prodWrite = FALSE, !.steers = 0,
            !.steerWait = FALSE, !.interruptAsked = TRUE, !.pc = "interruptWaits",
            !.stopNoSend = TRUE, !.lock = Olds(s.lock), !.stream = Olds(s.stream),
            !.turnOld = s.cli \in {"working", "winding"}]
     ELSE s' = Release([s EXCEPT !.metaRunning = FALSE, !.lastEnd = "stop"])

\* :784-:794, once the CLI's receipt came back. A replaced setup design goes with its turn.
InterruptAnswered ==
  /\ s.pc = "interruptWaits" /\ s.receipt
  /\ LET after == [s EXCEPT !.receipt = FALSE, !.metaRunning = FALSE, !.lastEnd = "stop"]
     IN s' = IF s.replaced THEN RemoveSetup(after) ELSE Release([after EXCEPT !.idleArmed = TRUE])

\* The process died first: interrupt() rejects and the section throws. `ended` repairs the thread.
InterruptFails ==
  /\ s.pc = "interruptWaits" /\ s.cli = "none"
  /\ s' = Release([s EXCEPT !.interruptAsked = FALSE, !.receipt = FALSE])

\* The result handler (:475), once it holds the lock.
RunResult ==
  /\ Free /\ Head1 \in Results
  /\ LET more == Head1 = "result1"
         steers == IF more /\ s.steers > 0 THEN s.steers - 1 ELSE s.steers
     IN IF ~s.live THEN s' = Release([s EXCEPT !.consumeBusy = FALSE])
        \* Stop already handed the thread back. Revoking here is safe for any newer turn.
        ELSE IF Head1 = "cancelled" \/ ~s.running
        THEN s' = Release([s EXCEPT !.prodWrite = FALSE, !.consumeBusy = FALSE])
        ELSE IF steers > 0 /\ ~more
        THEN s' = Release([s EXCEPT \* holdForSteer (:531)
               !.steers = steers, !.steerWait = TRUE, !.heldSteers = steers,
               !.consumeBusy = FALSE, !.prodWrite = FALSE])
        ELSE IF more
        THEN s' = Release([s EXCEPT \* finishTurn's `if (more) return` (:559)
               !.steers = steers, !.prodWrite = FALSE, !.consumeBusy = FALSE])
        ELSE s' = FinishTurn([s EXCEPT !.steers = steers])

\* The steer grace timer's section (:537). :538 checks the timer is still this Live's.
RunGrace ==
  /\ Free /\ Head1 = "grace"
  /\ IF ~s.steerWait
     THEN s' = Release(s)
     ELSE IF s.steers > s.heldSteers
     THEN s' = Release([s EXCEPT !.heldSteers = s.steers]) \* another steer: wait for it too
     ELSE s' = FinishTurn([s EXCEPT !.steerWait = FALSE, !.steers = 0])

\* armIdle's section (:637). A crash landing on this 10-minute timer is left out (`cli` guard).
RunIdle ==
  /\ Free /\ Head1 = "idle"
  /\ IF s.live /\ ~s.running /\ s.cli /= "none" THEN s' = Shut(Release(s)) ELSE s' = Release(s)

\* ended (:499)
RunEnded ==
  /\ Free /\ Head1 = "ended"
  /\ s' = [s EXCEPT
       !.live = FALSE, !.running = FALSE, !.idleArmed = FALSE, !.steerWait = FALSE,
       !.steers = 0, !.prodWrite = FALSE, !.replaced = FALSE, !.turnOld = FALSE,
       !.metaRunning = FALSE, !.lastEnd = "crash", !.consumeBusy = FALSE,
       !.sessions = s.sessions - 1, !.removed = s.replaced,
       !.pc = "free", !.lock = SelectSeq(s.lock, NotOfLive)]

\* ---- Timers ----

\* Timing assumption: consume reads a crash long before the 10-minute idle timer.
IdleTimerFires ==
  /\ s.idleArmed /\ ~s.removed /\ s.cli /= "none"
  /\ s' = [s EXCEPT !.idleArmed = FALSE, !.lock = Append(s.lock, "idle")]

\* Timing assumption: the CLI starts a steer's turn well inside the 3 s grace (measured: 37 ms), so
\* the timer only fires when that turn isn't coming.
SteerGraceExpires ==
  /\ s.steerWait /\ ~s.removed /\ \A i \in 1..Len(s.lock) : s.lock[i] /= "grace"
  /\ s.cli \in {"idle", "none"} /\ s.inbox = 0 /\ \A i \in 1..Len(s.stream) : s.stream[i] /= "init"
  /\ s' = [s EXCEPT !.lock = Append(s.lock, "grace")]

\* ---- The consume loop (:449): one message at a time, outside the lock until a result ----

ConsumeInit ==
  /\ ~s.consumeBusy /\ s.stream /= <<>> /\ Head(s.stream) = "init" /\ ~s.removed
  /\ s' = [s EXCEPT
       !.steers = IF s.betweenTurns /\ s.steers > 0 THEN s.steers - 1 ELSE s.steers,
       !.betweenTurns = FALSE, !.steerWait = FALSE,
       !.grantCarried = s.grantCarried \/ (s.prodWrite /\ s.grantTurn < s.initsRead + 1),
       !.initsRead = IF MaxGrants > 0 THEN s.initsRead + 1 ELSE 0,
       !.stream = Tail(s.stream)]

\* :474 sets betweenTurns, then the handler waits its place in the lock.
ConsumeResult ==
  /\ ~s.consumeBusy /\ s.stream /= <<>> /\ Head(s.stream) \in Results /\ ~s.removed
  /\ s' = [s EXCEPT
       !.betweenTurns = s.betweenTurns \/ Head(s.stream) = "result0", !.consumeBusy = TRUE,
       !.lock = Append(s.lock, Head(s.stream)), !.stream = Tail(s.stream)]

\* The stream threw or ended (:489); the catch at :492 waits its place in the lock.
ConsumeEnd ==
  /\ ~s.consumeBusy /\ s.stream /= <<>> /\ Head(s.stream) = "end" /\ ~s.removed
  /\ s' = [s EXCEPT
       !.consumeBusy = TRUE, !.lock = Append(s.lock, "ended"), !.stream = Tail(s.stream)]

\* ---- The CLI. Orders measured against Claude Code 2.1.311, see SKILL.md. ----

CliStartsTurn ==
  /\ s.cli = "idle" /\ s.inbox > 0
  /\ s' = [s EXCEPT
       !.cli = "working", !.inbox = s.inbox - 1,
       !.steerPending = IF s.steerPending > 0 THEN s.steerPending - 1 ELSE 0,
       !.mayDrop = FALSE, !.stream = Append(s.stream, "init"), !.turnOld = s.interruptAsked,
       !.turnNo = IF MaxGrants > 0 THEN s.turnNo + 1 ELSE 0]

\* A steer ends the running turn; the result counts it or doesn't (the comment at :247).
CliCutsTurnForSteer ==
  /\ s.cli = "working" /\ s.steerPending > 0
  /\ \E r \in {"result0", "result1"} :
       s' = [s EXCEPT
              !.cli = "idle", !.mayDrop = (r = "result0"), !.turnOld = FALSE,
              !.stream = Append(s.stream, IF s.turnOld THEN "cancelled" ELSE r)]

\* A steer's own turn may never start: agent.test.ts "ends a steered turn when ... never starts".
CliDropsSteer ==
  /\ s.cli = "idle" /\ s.steerPending > 0 /\ s.mayDrop
  /\ s' = [s EXCEPT !.inbox = s.inbox - 1, !.steerPending = s.steerPending - 1, !.mayDrop = FALSE]

CliFinishesTurn ==
  /\ s.cli = "working" /\ s.steerPending = 0
  /\ s' = [s EXCEPT
       !.cli = "idle", !.turnOld = FALSE,
       !.stream = Append(s.stream, IF s.turnOld THEN "cancelled" ELSE "result0")]

\* Receipt and cancelled result come in either order here. `cancelQueued` takes back what was
\* sent before Stop and hasn't started; a send behind Stop in the lock is pushed after the receipt.
CliTakesInterrupt ==
  /\ s.interruptAsked /\ s.cli /= "none"
  /\ s' = [s EXCEPT
       !.cli = IF s.cli = "working" THEN "winding" ELSE s.cli,
       !.inbox = 0, !.steerPending = 0, !.interruptAsked = FALSE, !.receipt = TRUE]

CliWindsDown ==
  /\ s.cli = "winding"
  /\ s' = [s EXCEPT !.cli = "idle", !.turnOld = FALSE, !.stream = Append(s.stream, "cancelled")]

CliCrashes ==
  /\ s.cli /= "none" /\ s.crashes < MaxCrashes /\ ~s.removed
  /\ s' = [s EXCEPT
       !.cli = "none", !.inbox = 0, !.steerPending = 0, !.turnOld = FALSE,
       !.stream = Append(s.stream, "end"), !.crashes = s.crashes + 1]

\* The move_to_prod tool (grantProdWrite, :403)
AgentMovesToProd ==
  /\ s.cli = "working" /\ s.live /\ ~s.prodWrite /\ s.grants < MaxGrants
  /\ s' = [s EXCEPT !.prodWrite = TRUE, !.grants = s.grants + 1, !.grantTurn = s.turnNo]

\* finish_setup with a replaced setup design (:608)
AgentFinishesSetup ==
  /\ SetupThread /\ s.cli = "working" /\ s.live /\ ~s.replaced
  /\ s' = [s EXCEPT !.replaced = TRUE, !.replacedEver = TRUE]

\* The server process restarts. store/open.ts:124 repairs a thread still marked running on load.
ServerRestarts ==
  /\ s.restarts < MaxRestarts /\ s.sessions > 0 /\ ~s.removed
  /\ s' = [s EXCEPT
       !.metaRunning = FALSE, !.live = FALSE, !.running = FALSE,
       !.steers = 0, !.steerWait = FALSE, !.betweenTurns = FALSE, !.idleArmed = FALSE,
       !.prodWrite = FALSE, !.replaced = FALSE, !.lock = <<>>, !.pc = "free", !.priority = FALSE,
       !.popped = FALSE, !.cli = "none", !.inbox = 0, !.steerPending = 0, !.turnOld = FALSE,
       !.mayDrop = FALSE, !.stream = <<>>, !.consumeBusy = FALSE, !.interruptAsked = FALSE,
       !.receipt = FALSE, !.sessions = 0, !.lastEnd = "crash", !.restarts = s.restarts + 1]

\* Nothing left to do: the design is gone, or every section and message has been handled.
Done ==
  /\ s.removed \/ (s.pc = "free" /\ s.lock = <<>> /\ ~s.consumeBusy /\ s.stream = <<>>)
  /\ UNCHANGED vars

Next ==
  \/ YouSendSteer \/ YouSendQueued \/ YouPressStop \/ YouSnooze \/ YouSettle
  \/ RunSend \/ DeliverPrepares \/ DeliverRejects \/ DeliverPushes
  \/ RunInterrupt \/ InterruptAnswered \/ InterruptFails
  \/ RunResult \/ RunGrace \/ RunIdle \/ RunEnded
  \/ IdleTimerFires \/ SteerGraceExpires
  \/ ConsumeInit \/ ConsumeResult \/ ConsumeEnd
  \/ CliStartsTurn \/ CliCutsTurnForSteer \/ CliDropsSteer \/ CliFinishesTurn
  \/ CliTakesInterrupt \/ CliWindsDown \/ CliCrashes
  \/ AgentMovesToProd \/ AgentFinishesSetup \/ ServerRestarts
  \/ Done

Spec == Init /\ [][Next]_vars

\* For the /statechart chart only: one thing in flight at a time, so the chart stays readable.
ChartScope ==
  /\ ~s.snoozed /\ ~s.settled /\ Len(s.lock) <= 1 /\ Len(s.stream) <= 1 /\ s.inbox <= 1
  /\ (s.pc = "free" \/ s.stream = <<>>) /\ (s.lock = <<>> \/ s.stream = <<>>)

\* ---- Rules. "Settled" means no section is running or waiting and no result is being handled. ----

Settled == s.pc = "free" /\ s.lock = <<>> /\ ~s.consumeBusy
Quiet == Settled /\ s.stream = <<>>
TurnInFlight ==
  \/ s.cli \in {"working", "winding"} \/ s.inbox > 0 \/ s.stream /= <<>> \/ s.steerWait

\* A thread shown running has a session with a turn in it.
ShownRunningHasATurn ==
  (Settled /\ ~s.removed /\ s.metaRunning) => (s.live /\ TurnInFlight)

\* A turn the CLI is working on is shown running.
TurnInFlightIsShown ==
  (Settled /\ s.live /\ s.cli = "working") => (s.metaRunning /\ s.running)

\* A queued message waits only because you pressed Stop or the session crashed.
QueueOnlyWaitsAfterStopOrCrash ==
  (Settled /\ ~s.removed /\ ~s.metaRunning /\ s.queued > 0 /\ ~TurnInFlight)
    => s.lastEnd \in {"stop", "crash"}

\* A queued message taken off the queue reaches a session.
NoQueuedMessageLost == s.lost = 0

\* Stop never sends the next queued message.
StopNeverSendsTheQueue == ~s.popAfterStop

\* A session in `lives` has a turn or an idle timer, so it can't outlive its use.
EveryLiveHasATurnOrIdleTimer == (Quiet /\ s.live) => (s.running \/ s.idleArmed)

\* Stop's flag ends with the turn it cancelled.
StopFlagEndsWithItsTurn == (Settled /\ s.turnOld) => TurnInFlight

\* A move_to_prod grant applies to the turn that asked for it.
ProdGrantEndsWithItsTurn == ~s.grantCarried

\* A setup design that finish_setup replaced goes away when its session does.
ReplacedSetupIsRemoved == (Quiet /\ s.replacedEver /\ ~s.live) => s.removed

\* A thread has at most one Claude Code process.
OneSessionPerThread == s.sessions <= 1

\* A delivered message brings a snoozed or settled thread back.
MessageRevivesThread ==
  [][(s.pc = "deliverPrepares" /\ s'.pc = "deliverPushes") => (~s'.snoozed /\ ~s'.settled)]_vars

====
