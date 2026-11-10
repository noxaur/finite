---------------------------- MODULE DesktopShell ----------------------------
(* The Electron main process's supervision of the Node server, and how the app quits.
   Code: apps/desktop/src/main.ts, apps/desktop/src/restarts.ts.
   Each action is one synchronous run of main-process JavaScript. *)
EXTENDS Naturals

CONSTANTS
    MaxStops,                  \* MAX_STOPS in restarts.ts
    SpawnCanFail,              \* spawn() can emit 'error' with no 'exit' (EAGAIN, ENOENT, ...)
    HandleSpawnError,          \* fix: main.ts spawnServer listens for 'error' and treats a failed spawn as a stop
    GateSpawnOnQuit,           \* fix: startServer checks `quitting` before spawnServer
    LimitRestarts,             \* mutant when FALSE: afterStop always restarts
    IgnoreExitWhileQuitting,   \* mutant when FALSE: main.ts spawnServer's `stopped` loses its `if (quitting) return`
    WaitForServerOnQuit        \* mutant when FALSE: before-quit doesn't preventDefault, main.ts before-quit

VARIABLES
    app,             \* "running", "closing" (quit went through, windows closing), "exited"
    boot,            \* startServer: "probing", "spawned", "loaded", "abandoned", "timedOut"
    server,          \* main.ts `server` and the real process: "none", "live", "stale" (no process, never exits)
    quitting,        \* main.ts `quitting`
    waiting,         \* before-quit prevented the quit and listens for the exit, main.ts before-quit
    stops,           \* main.ts `stops`, as the number of stops still inside WINDOW_MS
    errorShown,      \* dialog.showErrorBox ran, main.ts spawnServer's `stopped`
    errorEvent,      \* only with HandleSpawnError: the failed child's 'error' is on the next tick
    restartedInQuit  \* history: a server was started again after quitting began

vars == <<app, boot, server, quitting, waiting, stops, errorShown, errorEvent, restartedInQuit>>

Init ==
    /\ app = "running"
    /\ boot = "probing"     \* startServer awaits freePort and loginShellPath, main.ts startServer
    /\ server = "none"
    /\ quitting = FALSE
    /\ waiting = FALSE
    /\ stops = 0
    /\ errorShown = FALSE
    /\ errorEvent = FALSE
    /\ restartedInQuit = FALSE

(* spawnServer's spawn call, main.ts spawnServer. A failed spawn still assigns `server`; with HandleSpawnError the
   'error' event on the next tick clears it, so the model holds `server` at "none" and leaves the event pending. *)
Spawn ==
    \/ server' = "live" /\ errorEvent' = FALSE
    \/ /\ SpawnCanFail
       /\ IF HandleSpawnError
          THEN server' = "none" /\ errorEvent' = TRUE
          ELSE server' = "stale" /\ errorEvent' = FALSE

(* before-quit, main.ts before-quit handler. `server` is truthy when stale, so a stale handle waits too. *)
BeforeQuit ==
    /\ quitting' = TRUE
    /\ IF server = "none" \/ ~WaitForServerOnQuit
       THEN app' = "closing" /\ UNCHANGED waiting
       ELSE waiting' = TRUE /\ UNCHANGED app

(* The stop handler, main.ts spawnServer's `stopped`, with afterStop, restarts.ts afterStop. The respawn runs inside
   the handler, so no event can land between the stop and the new server. With `waiting`, the
   listener in main.ts before-quit calls app.quit(), and before-quit then finds no server. *)
OnStop ==
    LET recent == IF stops + 1 > MaxStops THEN MaxStops ELSE stops + 1
        restart == ~LimitRestarts \/ recent < MaxStops
    IN IF quitting /\ IgnoreExitWhileQuitting
       THEN /\ server' = "none"
            /\ errorEvent' = FALSE
            /\ IF waiting THEN app' = "closing" /\ waiting' = FALSE ELSE UNCHANGED <<app, waiting>>
            /\ UNCHANGED <<quitting, stops, errorShown, restartedInQuit>>
       ELSE /\ stops' = recent
            /\ IF restart
               THEN /\ Spawn
                    /\ restartedInQuit' = (restartedInQuit \/ quitting)
                    /\ UNCHANGED <<app, quitting, waiting, errorShown>>
               ELSE /\ server' = "none"
                    /\ errorEvent' = FALSE
                    /\ errorShown' = TRUE
                    /\ quitting' = TRUE
                    /\ app' = "closing"
                    /\ waiting' = FALSE
                    /\ UNCHANGED restartedInQuit

(* startServer resumes after its await, main.ts startServer. With GateSpawnOnQuit it checks `quitting` first,
   and throws, so createWindow rejects and the `.catch` of main.ts's `whenReady` chain quits again, which a quitting app ignores. *)
ProbeFinishes ==
    /\ boot = "probing"
    /\ app /= "exited"
    /\ IF GateSpawnOnQuit /\ quitting
       THEN boot' = "abandoned" /\ UNCHANGED <<server, errorEvent>>
       ELSE boot' = "spawned" /\ Spawn
    /\ UNCHANGED <<app, quitting, waiting, stops, errorShown, restartedInQuit>>

(* waitFor sees /api/health answer, main.ts startServer, and the window loads it, main.ts createWindow. *)
HealthAnswers ==
    /\ boot = "spawned"
    /\ app = "running"
    /\ ~quitting
    /\ server = "live"
    /\ boot' = "loaded"
    /\ UNCHANGED <<app, server, quitting, waiting, stops, errorShown, errorEvent, restartedInQuit>>

(* waitFor gives up after 15 s; createWindow rejects and the `.catch` of main.ts's `whenReady` chain quits. *)
HealthTimesOut ==
    /\ boot = "spawned"
    /\ app = "running"
    /\ ~quitting
    /\ ~errorEvent
    /\ boot' = "timedOut"
    /\ BeforeQuit
    /\ UNCHANGED <<server, stops, errorShown, errorEvent, restartedInQuit>>

(* A quit from the menu, or window-all-closed, main.ts. *)
YouQuit ==
    /\ app = "running"
    /\ ~quitting
    /\ ~errorEvent
    /\ BeforeQuit
    /\ UNCHANGED <<boot, server, stops, errorShown, errorEvent, restartedInQuit>>

(* The server stops on its own, and main.ts spawnServer's `stopped` runs. *)
ServerCrashes ==
    /\ server = "live"
    /\ app /= "exited"
    /\ ~waiting
    /\ OnStop
    /\ UNCHANGED boot

(* SIGTERM in main.ts before-quit, or SIGKILL 5 s later (SHUTDOWN_MS), ends a live process. *)
ServerObeysQuit ==
    /\ waiting
    /\ server = "live"
    /\ OnStop
    /\ UNCHANGED boot

(* Only with HandleSpawnError: the 'error' listener in main.ts spawnServer runs the same stop handling. *)
SpawnErrorHandled ==
    /\ errorEvent
    /\ OnStop
    /\ UNCHANGED boot

(* WINDOW_MS passes, so the oldest stop stops counting: restarts.ts afterStop. *)
AMinutePasses ==
    /\ app = "running"
    /\ ~quitting
    /\ stops > 0
    /\ stops' = stops - 1
    /\ UNCHANGED <<app, boot, server, quitting, waiting, errorShown, errorEvent, restartedInQuit>>

(* Electron finishes closing and the main process ends. A child isn't killed with it. *)
AppExits ==
    /\ app = "closing"
    /\ app' = "exited"
    /\ UNCHANGED <<boot, server, quitting, waiting, stops, errorShown, errorEvent, restartedInQuit>>

Done == app = "exited" /\ UNCHANGED vars

Next ==
    \/ ProbeFinishes
    \/ HealthAnswers
    \/ HealthTimesOut
    \/ YouQuit
    \/ ServerCrashes
    \/ ServerObeysQuit
    \/ SpawnErrorHandled
    \/ AMinutePasses
    \/ AppExits
    \/ Done

Spec ==
    /\ Init
    /\ [][Next]_vars
    /\ WF_vars(ServerObeysQuit)
    /\ WF_vars(SpawnErrorHandled)
    /\ WF_vars(AppExits)

(* While the app is open and not quitting, a started server is up or about to restart. *)
OpenAppHasServer ==
    (app = "running" /\ ~quitting /\ boot \in {"spawned", "loaded"}) => (server = "live" \/ errorEvent)

(* A spawn that failed never stays behind as the app's `server`. *)
FailedSpawnHandled == server /= "stale"

(* When the app has exited, no server process it started is still alive. *)
QuitLeavesNoServer == app = "exited" => server /= "live"

(* Once a quit starts, the app always ends up exiting. *)
QuitFinishes == quitting ~> (app = "exited")

(* The third stop in a minute shows the error and never starts a fourth server. *)
NoRestartPastTheLimit == stops = MaxStops => (server /= "live" /\ errorShown)

(* A server that stops because the app is quitting is never started again. *)
NoRestartWhileQuitting == ~restartedInQuit
=============================================================================
