---
name: verify-desktop-shell
description: TLA+ model of how the Electron app supervises its Node server and quits. Use when a change touches apps/desktop/src/main.ts (spawnServer, startServer, before-quit, the server's exit handler) or apps/desktop/src/restarts.ts, or when the desktop app won't quit, leaves a server behind, or doesn't restart its server.
---

# Verify the desktop shell

`model/DesktopShell.tla` models the main process in `apps/desktop/src/main.ts`: starting the server, restarting it, giving up, and quitting. TLC explores every order of those events, in a model of the code. It never reads the TypeScript, so a passing check says something about your change only after the model matches it.

## Rules

| Rule                     | Promise                                                                             | Harm if broken                                                                                      | Today |
| ------------------------ | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ----- |
| `OpenAppHasServer`       | While the app is open and not quitting, a started server is up or about to restart. | The page stays disconnected with nothing trying to recover.                                         | holds |
| `FailedSpawnHandled`     | A failed spawn never stays behind as `server`.                                      | Everything that trusts `server` acts on a process that doesn't exist.                               | holds |
| `QuitFinishes`           | Once a quit starts, the app exits.                                                  | Quit does nothing, and the person has to force quit.                                                | holds |
| `QuitLeavesNoServer`     | When the app has exited, no server it started is alive.                             | An orphan holds port 4100, so the next launch gets another port and loses the page's local storage. | holds |
| `NoRestartPastTheLimit`  | The third stop in a minute shows the error, and no fourth server starts.            | A crash loop runs forever.                                                                          | holds |
| `NoRestartWhileQuitting` | A server that stops during a quit never starts again.                               | Quit races a new server.                                                                            | holds |

## Check a change

1. Check whether your diff touches `apps/desktop/src/main.ts` or `apps/desktop/src/restarts.ts`. If it touches neither, stop here.
2. Find each changed function in the coverage table below. For a line outside the table that adds an `await`, an event listener, a `spawn`, or a write to `server` or `quitting`, add an action for it.
3. Change the model to match the code. A guard from the variant table is one constant in `model/current.cfg`. Anything else is an edit to the action, keeping one action per synchronous run of JavaScript, split at each `await`.
4. Run `.agents/skills/verify-desktop-shell/check.sh`. It took 51 seconds on a busy Mac (load average 30 to 60) and needs TLC 2.19 at `~/.local/share/tlaplus/tla2tools.jar`, or `TLA2TOOLS` pointing to the jar, and Java 11 or later.
5. Read the result. Exit 0 means every rule matches its record. Exit 1 prints a `MISMATCH` row. Exit 2 means TLC couldn't run the model.
6. For a mismatch, read the counterexample TLC wrote to the kept `.out` file. It lists each state from the start to the broken rule.
7. Decide what the path is:
   - **A real bug:** every step exists in the code and is one synchronous run of it. Replay it as a test in `apps/desktop/src/main.test.ts`, which fakes Electron, `child_process` and the port probe around the real `main.ts`, and report it.
   - **A modeling error:** a step fuses two runs across an `await`, or allows something the code can't do. Fix the action, and check the code it names in its comment.
8. Confirm every row of the coverage table against the code before you finish.

Keep the rule and its `expected.tsv` row as they are unless the promise itself changed on purpose. An edit that only makes a row pass hides the bug.

## Variants

Each constant in the `.cfg` files toggles one piece of code. `current.cfg` is the code as it stands, with both fixes on.

| Constant                  | Code                                                                       | Variant that flips it      |
| ------------------------- | -------------------------------------------------------------------------- | -------------------------- |
| `HandleSpawnError`        | `child.on("error")` in `spawnServer`; TRUE is the code, FALSE removes it   | `fixed`, `fix-spawn-error` |
| `GateSpawnOnQuit`         | `if (quitting) throw` in `startServer`; TRUE is the code, FALSE removes it | `fixed`, `fix-quit-gate`   |
| `LimitRestarts`           | `recent.length < MAX_STOPS` in `afterStop`                                 | `no-limit`                 |
| `IgnoreExitWhileQuitting` | `if (quitting) return` in `stopped`                                        | `no-quit-guard`            |
| `WaitForServerOnQuit`     | `event.preventDefault()` in `before-quit`                                  | `no-wait`                  |

## Coverage

| File                           | Function                               | Actions                                    | Rules                                                          |
| ------------------------------ | -------------------------------------- | ------------------------------------------ | -------------------------------------------------------------- |
| `apps/desktop/src/main.ts`     | `startServer`                          | `ProbeFinishes`, `HealthAnswers`           | `QuitLeavesNoServer`                                           |
| `apps/desktop/src/main.ts`     | `spawnServer`, stop and error handlers | `Spawn`, `OnStop`, `ServerCrashes`         | all                                                            |
| `apps/desktop/src/main.ts`     | `whenReady` chain's `catch`            | `HealthTimesOut`                           | `QuitFinishes`                                                 |
| `apps/desktop/src/main.ts`     | `before-quit`                          | `BeforeQuit`, `YouQuit`, `ServerObeysQuit` | `QuitFinishes`, `QuitLeavesNoServer`, `NoRestartWhileQuitting` |
| `apps/desktop/src/restarts.ts` | `afterStop`                            | `OnStop`, `AMinutePasses`                  | `NoRestartPastTheLimit`                                        |

## Bounds and assumptions

The check covers every order of events with `MAX_STOPS` = 3, and 48 reachable states for the current code. `stops` is a count of stops still inside `WINDOW_MS`, and `AMinutePasses` drops one. A live process always ends after SIGTERM or the SIGKILL 5 seconds later. An uncaught `error` is assumed to leave the app running, which is what Electron's default handler does.

Left out:

- A quit vetoed by a window's `beforeunload` after `quitting` is set. Finite's own pages have no such handler, but a design's page could. `quitting` never resets, so the app would stay open with no server.
- A second quit during the shutdown wait. It adds a timer and a listener, and both are harmless.
- `updates.ts`, windows, `activate`, and the dev mode's `waitFor(DEV_URL)`.
- What the server does after SIGTERM.
