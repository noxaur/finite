---- MODULE Previews ----
\* One design's preview: its install, its dev-server child, who keeps it alive, and, for a Next
\* design, its frame registry. Each action is one step of the code: no `await` inside it.
\* The single variable `s` is a record, so the code's sync helpers (stopRun, start) compose.
EXTENDS Naturals, FiniteSets

CONSTANTS
    Kinds,              \* subset of {"blank", "workspace", "setup", "next"}
    MaxVisits, AgentTools, McpTools, ConfigEdits, Faults, LateChunks, Removes, Retries, MaxRuns,
    \* The code as it stands: every one of these has its value in current.cfg.
    CancelIdleOnEnsure, ObserveChildExit, StalePrepareGuard,
    \* Fixes now in the code, all TRUE in current.cfg; FALSE brings the finding back.
    FixKeepAlive, KillOnServiceExit, FixEnsure, FixRemove, GuardLateChunk, ShareRegistryWait

VARIABLE s
Callers == {"page", "agent", "mcp"}
Requests == {1, 2}

InitFor(k) == [
    kind |-> k,
    status |-> IF k = "next" THEN "ready" ELSE "none",  \* "none": no entry in `runs`
    child |-> IF k = "next" THEN "alive" ELSE "none",   \* run.child, while it's alive
    dying |-> 0,            \* children that got SIGTERM and haven't exited
    orphans |-> 0,          \* children alive that no run points at any more
    runId |-> 0,            \* which `Run` is current
    viewer |-> FALSE,       \* a client is subscribed
    idleTimer |-> FALSE,    \* idleTimers has the design
    restarting |-> FALSE,   \* the `restarting` set has the design
    restartIdle |-> FALSE,  \* the `idle` snapshot restart() took before it checked `watched`
    page |-> "idle", agent |-> "idle", mcp |-> "idle",  \* where each caller of ensure() is
    preparing |-> {},       \* runs whose workspaces.prepare is in flight
    service |-> "none",     \* the finite.json service
    runHolds |-> FALSE,     \* run.release is set
    restartHolds |-> FALSE, \* restart() still holds the old run's release
    removed |-> FALSE,
    install |-> "none",     \* install.ts handle.state.status
    finished |-> FALSE,     \* install.ts `finished`
    outcome |-> "none",     \* how handle.done settled: "ok" or "failed"
    kept |-> FALSE,         \* store `installs` still has the job
    nodeModules |-> k # "blank",
    registered |-> FALSE,   \* next/index.ts `registered` has the file
    compiled |-> FALSE,     \* Next has rebuilt with the file in its registry
    req |-> [r \in Requests |-> "none"],
    visits |-> 0, agentUsed |-> 0, mcpUsed |-> 0, edits |-> 0, faults |-> 0,
    chunks |-> 0, removes |-> 0, retries |-> 0
]

Init == s \in {InitFor(k) : k \in Kinds}

Life == s.kind # "next"

\* --- The code's sync helpers ------------------------------------------------------------------

CancelIdle(x) == IF CancelIdleOnEnsure THEN [x EXCEPT !.idleTimer = FALSE] ELSE x

\* A release: workspace.ts retire() stops the service once the last holder lets go.
Settle(x) ==
    IF x.service = "up" /\ ~x.runHolds /\ ~x.restartHolds /\ x.preparing = {}
    THEN [x EXCEPT !.service = "none"] ELSE x

\* preview/index.ts:407 stopRun, up to its first await.
StopSync(x) == Settle([x EXCEPT
    !.status = "none", !.idleTimer = FALSE, !.restarting = FALSE, !.runHolds = FALSE,
    !.child = "none", !.dying = x.dying + IF x.child = "alive" THEN 1 ELSE 0])

\* preview/index.ts:163 start. It overwrites runs[id] without stopping what was there.
Start(x) ==
    LET id == x.runId + 1
        y == [x EXCEPT !.runId = id, !.runHolds = FALSE,
                       !.orphans = x.orphans + IF x.child = "alive" THEN 1 ELSE 0]
    IN CASE x.kind = "setup" -> [y EXCEPT !.status = "detecting", !.child = "none"]
         [] x.kind = "workspace" ->
              [y EXCEPT !.status = "starting", !.child = "none", !.preparing = x.preparing \cup {id}]
         [] OTHER -> [y EXCEPT !.status = "starting", !.child = "alive"]

SetCaller(x, c, v) ==
    CASE c = "page" -> [x EXCEPT !.page = v]
      [] c = "agent" -> [x EXCEPT !.agent = v]
      [] OTHER -> [x EXCEPT !.mcp = v]

CallerIn(x, c) == CASE c = "page" -> x.page [] c = "agent" -> x.agent [] OTHER -> x.mcp

\* What the caller does once ensure() has returned. `ToolFinishes` is when it settles.
After(x, c) == SetCaller(x, c, IF c = "page" /\ ~FixKeepAlive THEN "idle" ELSE "using")

\* hub.release, and the finally in preview/index.ts:440 ensure: a run nobody watches gets the timer.
ArmIfUnwatched(x) ==
    IF ~x.viewer /\ x.status # "none" THEN [x EXCEPT !.idleTimer = TRUE] ELSE x

SomeoneStopping(x) == \E c \in Callers : CallerIn(x, c) = "stopping"

\* preview/index.ts:440 ensure and :420 up, up to its await. With no child to wait for, the await
\* is a microtask, so the start is the same step. Callers during a replacement share it.
Ensure(x, c) ==
    LET y == CancelIdle(x)
    IN IF FixEnsure /\ SomeoneStopping(y) THEN SetCaller(y, c, "stopping")
       ELSE IF y.status = "none" THEN After(Start(y), c)
       ELSE IF y.status \notin {"error", "needs-setup"} THEN After(y, c)
       ELSE IF y.child = "alive" \/ y.dying > 0 THEN SetCaller(StopSync(y), c, "stopping")
       ELSE After(Start(StopSync(y)), c)

\* --- A person opens and leaves the design -----------------------------------------------------

\* handlers.ts:71 subscribe with store/index.ts:148 startInstall. A failed job a late chunk marked
\* "running" is handed back as if it were still going, and its `done` has already rejected.
Subscribe ==
    /\ Life /\ ~s.viewer /\ ~s.removed /\ s.visits < MaxVisits
    /\ LET x == [s EXCEPT !.viewer = TRUE, !.visits = s.visits + 1] IN
       IF s.kind # "blank" THEN s' = Ensure(x, "page")
       ELSE IF s.kept /\ s.install = "running" /\ s.finished THEN s' = x
       ELSE IF s.kept /\ s.install = "running" THEN s' = [x EXCEPT !.page = "afterInstall"]
       ELSE IF s.nodeModules THEN s' = Ensure(x, "page")
       ELSE /\ s.retries < Retries
            /\ s' = [x EXCEPT !.page = "afterInstall", !.install = "running", !.finished = FALSE,
                              !.outcome = "none", !.kept = TRUE, !.retries = s.retries + 1]

\* hub.ts:118 unsubscribe, hub.ts:122 release, preview/index.ts:476 idle. idle() is a no-op with
\* no run, so a viewer who leaves while nothing runs leaves no record of it.
Unsubscribe ==
    /\ Life /\ s.viewer
    /\ s' = [s EXCEPT !.viewer = FALSE, !.idleTimer = s.status # "none" \/ s.idleTimer]

\* preview/index.ts:141, the timer's callback.
IdleTimerFires ==
    /\ Life /\ s.idleTimer
    /\ s' = StopSync(s)

\* handlers.ts:49 design.remove, mcp/tools.ts:279, agent/index.ts:596 removeSetup, and
\* preview/index.ts:467 remove: stops, and refuses later ensures.
RemoveDesign ==
    /\ Life /\ ~s.removed /\ s.removes < Removes
    /\ s' = [StopSync(s) EXCEPT !.removed = TRUE, !.removes = s.removes + 1]

\* --- The dependency install (store/install.ts) ------------------------------------------------

\* install.ts:65 finish, on the child's `exit`. Success also runs install.ts's job.done.then
\* (store/index.ts:160), which forgets the job.
InstallSucceeds ==
    /\ Life /\ s.install = "running" /\ ~s.finished
    /\ s' = [s EXCEPT !.install = "done", !.finished = TRUE, !.outcome = "ok",
                      !.nodeModules = TRUE, !.kept = FALSE]

InstallFails ==
    /\ Life /\ s.install = "running" /\ ~s.finished
    /\ s' = [s EXCEPT !.install = "error", !.finished = TRUE, !.outcome = "failed"]

\* install.ts:57 append. Node can deliver a chunk after `exit`; append drops it once `finished`.
LateOutput ==
    /\ Life /\ s.finished /\ s.chunks < LateChunks
    /\ s' = [s EXCEPT !.chunks = s.chunks + 1,
                      !.install = IF GuardLateChunk THEN s.install ELSE "running"]

\* handlers.ts:77-78, the .then after install.done.
InstallDoneEnsures ==
    /\ Life /\ s.page = "afterInstall" /\ s.outcome = "ok"
    /\ IF FixRemove /\ s.removed
       THEN s' = [s EXCEPT !.page = "idle"]
       ELSE s' = Ensure(s, "page")

InstallFailEndsWait ==
    /\ Life /\ s.page = "afterInstall" /\ s.outcome = "failed"
    /\ s' = [s EXCEPT !.page = "idle"]

\* --- Agents and MCP use the preview without being viewers ---------------------------------------

\* agent/tools.ts:291,511,537,555, agent/index.ts:616 finish_setup and mcp/tools.ts:193 ensure. The
\* model starts tools only once the dependencies are in; mcp/tools.ts refuses before that, and a dev
\* server has nothing to run.
ToolEnsures(c) ==
    /\ Life /\ c \in {"agent", "mcp"} /\ CallerIn(s, c) = "idle" /\ ~s.removed /\ s.nodeModules
    /\ IF c = "agent" THEN s.agentUsed < AgentTools ELSE s.mcpUsed < McpTools
    /\ s' = LET x == Ensure(s, c)
            IN IF c = "agent" THEN [x EXCEPT !.agentUsed = s.agentUsed + 1]
               ELSE [x EXCEPT !.mcpUsed = s.mcpUsed + 1]

\* The caller's ensure has settled: every caller's run goes on the timer if nobody watches it.
\* The code arms it in ensure's finally; a tool still using the run counts as not Settled, so the
\* rule can't tell that from arming here, when the tool's result is back (mcp/tools.ts:206).
ToolFinishes(c) ==
    /\ Life /\ CallerIn(s, c) = "using"
    /\ s.status \in {"ready", "error", "needs-setup", "none"}
    /\ LET x == SetCaller(s, c, "idle")
       IN s' = IF c = "mcp" \/ FixKeepAlive THEN ArmIfUnwatched(x) ELSE x

\* preview/index.ts:430-433, after `stopRun`. The callers that joined take the run the first one
\* started.
EnsureResumes(c) ==
    /\ Life /\ CallerIn(s, c) = "stopping" /\ s.dying = 0
    /\ IF FixRemove /\ s.removed
       THEN s' = SetCaller(s, c, "idle")
       ELSE IF FixEnsure /\ s.status # "none" THEN s' = After(s, c)
       ELSE s' = After(Start(s), c)

\* --- The run and its child (preview/index.ts) ---------------------------------------------------

\* preview/index.ts:190-199, detection ends.
DetectionEnds ==
    /\ Life /\ s.status = "detecting"
    /\ s' = [s EXCEPT !.status = "needs-setup"]

\* preview/index.ts:234-239. A stale run lets go and forks nothing (line 235).
PrepareSucceeds(id) ==
    /\ Life /\ id \in s.preparing
    /\ LET x == [s EXCEPT !.preparing = s.preparing \ {id}, !.service = "up", !.restartHolds = FALSE]
           current == id = s.runId /\ s.status = "starting"
       IN IF current
          THEN s' = [x EXCEPT !.child = "alive", !.runHolds = TRUE]
          ELSE IF StalePrepareGuard
          THEN s' = Settle(x)
          ELSE s' = [x EXCEPT !.orphans = s.orphans + 1]

\* preview/index.ts:241-248, setup or a service failed.
PrepareFails(id) ==
    /\ Life /\ id \in s.preparing /\ s.faults < Faults
    /\ LET x == Settle([s EXCEPT !.preparing = s.preparing \ {id}, !.restartHolds = FALSE,
                                 !.faults = s.faults + 1])
       IN s' = IF id = s.runId /\ s.status = "starting"
               THEN [x EXCEPT !.status = "error"] ELSE x

\* preview/index.ts:300-305, the child's "ready" message.
HostReady ==
    /\ Life /\ s.status = "starting" /\ s.child = "alive"
    /\ s' = [s EXCEPT !.status = "ready"]

\* preview/index.ts:313 `exit` and :286 fail. A host that reports `error` exits straight after
\* (vite-host.mjs:60), so that message is this step too.
ChildCrashes ==
    /\ Life /\ s.child = "alive" /\ s.faults < Faults
    /\ IF ObserveChildExit
       THEN s' = Settle([s EXCEPT !.child = "none", !.status = "error", !.runHolds = FALSE,
                                  !.faults = s.faults + 1])
       ELSE s' = [s EXCEPT !.child = "none", !.faults = s.faults + 1]

\* preview/index.ts:399-402: a child that was told to stop has exited.
StoppedChildExits ==
    /\ Life /\ s.dying > 0
    /\ s' = [s EXCEPT !.dying = s.dying - 1]

\* workspace.ts:155-161 tells each holder; preview/index.ts:222-229 is the holder. It stops the
\* dev server too.
ServiceExits ==
    /\ Life /\ s.service = "up" /\ s.status \in {"starting", "ready"} /\ s.faults < Faults
    /\ s.runHolds
    /\ LET x == [s EXCEPT !.service = "none", !.status = "error", !.runHolds = FALSE,
                          !.faults = s.faults + 1]
       IN s' = IF KillOnServiceExit /\ s.child = "alive"
               THEN [x EXCEPT !.child = "none", !.dying = s.dying + 1]
               ELSE x

\* preview/index.ts:353 then restart at :362, up to its await.
FiniteJsonChanges ==
    /\ Life /\ s.kind = "workspace" /\ s.status = "ready" /\ s.edits < ConfigEdits
    /\ s' = [StopSync([s EXCEPT !.restartHolds = s.runHolds, !.runHolds = FALSE,
                                !.edits = s.edits + 1, !.restartIdle = s.idleTimer])
             EXCEPT !.restarting = TRUE]

\* preview/index.ts:367-371, after `await stopped`.
RestartResumes ==
    /\ Life /\ s.restarting /\ s.dying = 0
    /\ LET x == [s EXCEPT !.restarting = FALSE]
       IN IF (IF FixKeepAlive THEN ~s.viewer ELSE s.restartIdle) \/ s.status # "none"
          THEN s' = Settle([x EXCEPT !.restartHolds = FALSE])
          ELSE s' = Start(x)

\* --- Next.js frame registry (packages/vite-plugin/src/next/index.ts:343-354) --------------------

\* A request for a file not yet on the list adds it and waits for the compile; one for a file still
\* compiling waits on that same `compiling` entry (ShareRegistryWait). Without it, it went straight to
\* Next, compiled or not.
FrameRequested(r) ==
    /\ s.kind = "next" /\ s.req[r] = "none"
    /\ IF ~s.registered
       THEN s' = [s EXCEPT !.registered = TRUE, !.req[r] = "waiting"]
       ELSE IF s.compiled
       THEN s' = [s EXCEPT !.req[r] = "ok"]
       ELSE s' = [s EXCEPT !.req[r] = IF ShareRegistryWait THEN "waiting" ELSE "notFound"]

NextRecompiles ==
    /\ s.kind = "next" /\ s.registered /\ ~s.compiled
    /\ s' = [s EXCEPT !.compiled = TRUE]

\* next/index.ts:390 untilRegistered's poll stops getting 404.
FrameWaitEnds(r) ==
    /\ s.kind = "next" /\ s.req[r] = "waiting" /\ s.compiled
    /\ s' = [s EXCEPT !.req[r] = "ok"]

\* --- The whole machine -------------------------------------------------------------------------

Steps ==
    \/ Subscribe \/ Unsubscribe \/ IdleTimerFires \/ RemoveDesign
    \/ InstallSucceeds \/ InstallFails \/ LateOutput \/ InstallDoneEnsures \/ InstallFailEndsWait
    \/ \E c \in Callers : ToolEnsures(c) \/ ToolFinishes(c) \/ EnsureResumes(c)
    \/ DetectionEnds \/ HostReady \/ ChildCrashes \/ StoppedChildExits \/ ServiceExits
    \/ \E id \in 1..MaxRuns : PrepareSucceeds(id) \/ PrepareFails(id)
    \/ FiniteJsonChanges \/ RestartResumes
    \/ \E r \in Requests : FrameRequested(r) \/ FrameWaitEnds(r)
    \/ NextRecompiles

Done == ~ENABLED Steps /\ UNCHANGED s

Next == Steps \/ Done

Spec == Init /\ [][Next]_s

Bounded == s.runId <= MaxRuns

\* --- Rules -------------------------------------------------------------------------------------

Settled == s.page = "idle" /\ s.agent = "idle" /\ s.mcp = "idle" /\ ~s.restarting

\* A running preview nobody watches, with nothing using it, is on a timer to stop.
UnwatchedHasIdleTimer ==
    (Settled /\ ~s.viewer /\ (s.child = "alive" \/ s.status = "starting")) => s.idleTimer

\* A preview somebody watches is never on a timer to stop.
WatchedHasNoIdleTimer == s.viewer => ~s.idleTimer

\* A preview reported as failed has no dev server still running.
ErrorMeansNoChild == s.status = "error" => s.child # "alive"

\* A preview reported as ready has a dev server.
ReadyHasChild == s.status = "ready" => s.child = "alive"

\* Every dev server alive is one Finite can still stop.
NoUntrackedChild == s.orphans = 0

\* A finite.json service stays up only while a preview holds it or is about to.
ServiceHeld ==
    s.service = "up" => (s.runHolds \/ s.restartHolds \/ s.preparing # {})

\* A removed design runs nothing.
RemovedDesignRunsNothing == s.removed => (s.status = "none" /\ s.child # "alive")

\* An install that ended stays ended.
InstallStaysFinished == s.finished => s.install # "running"

\* A frame request reaches Next only after Next can render its file.
FrameWaitsForRegistry == \A r \in Requests : s.req[r] # "notFound"

====
