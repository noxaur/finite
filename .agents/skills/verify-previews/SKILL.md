---
name: verify-previews
description: TLA+ model of a design's preview lifecycle. Use when a change touches ensure, stopRun, start, restart or idle in apps/server/src/preview/index.ts, preview/workspace.ts, store/install.ts or startInstall, hub.release, a caller of previews.ensure, the subscribe or design.remove handlers, or the frame registry in packages/vite-plugin/src/next/index.ts, or when a preview won't stop, a dev server is left running, an install looks stuck, or a new Next frame 404s.
---

# Verify previews

`model/Previews.tla` is a model of one design's preview, from opening it to the dev server stopping. TLC, the TLA+ model checker, walks every order of opens, leaves, tool calls, crashes and timers up to the bounds below. It finds orderings a test rarely hits.

The model describes the code by hand, so it can't see your diff. You carry the change into the model, then run the check.

## Check a change

1. Run `git diff --stat $(git merge-base HEAD main) -- <the files in Coverage>`. No changes to those files means the verification still applies: stop here.
2. For each changed function, read the action named in Coverage and decide whether it still describes the code. Each action is one stretch of code with no `await` inside it, so a new `await` splits an action, and a moved check changes what an action guards.
3. Edit `model/Previews.tla` until it describes the new code. Run a config with a constant only when the change matches that variant.
4. Run `.agents/skills/verify-previews/check.sh`. It took 80 seconds on a busy Mac (load average 59) and needs Java and TLC 2.19 at `~/.local/share/tlaplus/tla2tools.jar` (or `TLA2TOOLS`).
5. Read every `MISMATCH`, and read the trace in the kept `.out` file: it lists each state from the start to the broken rule.

   | Result                       | Meaning                                              | What you do                                                                                                                            |
   | ---------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
   | `expected holds, got breaks` | Your change broke a rule, or the model edit is wrong | Tell the trace as steps in the code. If you can walk them in the code, it's a bug in the change. If a step can't happen, fix the model |
   | `expected breaks, got holds` | A finding got fixed, or the edit removed the path    | Check the fix closes the path in the code, then flip the row to `holds`                                                                |
   | `error`                      | TLC couldn't run: a parse error, or a bad constant   | Read the `.out` file it names                                                                                                          |

6. When the verification describes your code, update Coverage. A rule stays as written: change a rule only when the product's promise changes, and say so in the PR.

## Rules

| Rule                       | Promise                                                                       | Harm when it breaks                                                       |
| -------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `UnwatchedHasIdleTimer`    | A running preview nobody watches, and no tool is using, is on a timer to stop | A dev server runs until the app quits                                     |
| `WatchedHasNoIdleTimer`    | A preview someone watches is never on that timer                              | The preview stops in front of the person                                  |
| `ReadyHasChild`            | A preview reported ready has a dev server                                     | Frames point at nothing                                                   |
| `ErrorMeansNoChild`        | A preview reported failed has no dev server left running                      | A process keeps its port and memory while the page says it failed         |
| `NoUntrackedChild`         | Finite can still stop every dev server it started                             | `previews.stop` misses one, and it runs until the app quits               |
| `ServiceHeld`              | A finite.json service runs only while a preview holds it or is about to       | A database or API keeps running with no preview                           |
| `RemovedDesignRunsNothing` | A removed design runs nothing                                                 | A dev server starts in a folder moved to the trash                        |
| `InstallStaysFinished`     | An install that ended never reads as running                                  | The page shows "installing" forever, or a failed install is never retried |
| `FrameWaitsForRegistry`    | A frame request reaches Next only after Next can render its file              | A new frame shows a 404                                                   |

## Findings in the code today

None open: every rule holds within the bounds below. A new finding is recorded as `breaks` in `model/expected.tsv`, with a replay against the real modules.

## Bounds and what's left out

Each run covers one design and one viewer, with at most 2 visits, 1 agent tool call, 1 MCP tool call, 1 finite.json edit, 1 crash, 1 late output chunk, 1 removal, 2 install attempts and 3 runs. A pass covers those bounds only.

- The kinds run separately: `blank` (install, no workspace), `workspace` (setup, a service, restarts), `setup` is in the chart only, `next` (only the frame registry, on a running dev server).
- Left out: a second viewer (`hub.release` only asks whether anyone is subscribed), services shared between designs, a service's `spec` changing, a partial `node_modules` after a failed install, `untilRegistered`'s 10 s deadline, `finish_setup` converting a setup design, `routes` refresh, and agent tools on a design whose dependencies aren't in.

## Coverage

| File                                                               | Function                                                     | Actions and rules                                                             |
| ------------------------------------------------------------------ | ------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| `apps/server/src/preview/index.ts`                                 | `ensure`, `up`                                               | `Ensure`, `EnsureResumes`, `ToolEnsures`, `ToolFinishes`                      |
|                                                                    | `start`, `startHost`                                         | `Start`, `PrepareSucceeds`, `PrepareFails`, `HostReady`, `ChildCrashes`       |
|                                                                    | `stopRun`, `stopChild`                                       | `StopSync`, `StoppedChildExits`, `IdleTimerFires`                             |
|                                                                    | `restart`, `reload`                                          | `FiniteJsonChanges`, `RestartResumes`                                         |
|                                                                    | `idle`, `watch`, `startIdle`                                 | `Unsubscribe`, `ToolFinishes`; `UnwatchedHasIdleTimer`                        |
|                                                                    | `remove`, `refuseRemoved`                                    | `RemoveDesign`, `EnsureResumes`; `RemovedDesignRunsNothing`                   |
|                                                                    | `onExit` in `start`                                          | `ServiceExits`; `ErrorMeansNoChild`                                           |
| `apps/server/src/preview/workspace.ts`                             | `prepare`, `release`, `retire`, service exit                 | `PrepareSucceeds`, `Settle`, `ServiceExits`; `ServiceHeld`                    |
| `apps/server/src/hub.ts`                                           | `unsubscribe`, `release`                                     | `Unsubscribe`, `ToolFinishes`                                                 |
| `apps/server/src/handlers.ts`                                      | `subscribe`, `design.remove`                                 | `Subscribe`, `InstallDoneEnsures`, `RemoveDesign`; `RemovedDesignRunsNothing` |
| `apps/server/src/agent/tools.ts`, `agent/index.ts`, `mcp/tools.ts` | calls to `previews.ensure`, `previews.remove`, `hub.release` | `ToolEnsures`, `ToolFinishes`, `RemoveDesign`                                 |
| `apps/server/src/store/install.ts`                                 | `install`                                                    | `InstallSucceeds`, `InstallFails`, `LateOutput`; `InstallStaysFinished`       |
| `apps/server/src/store/index.ts`                                   | `startInstall`                                               | `Subscribe`                                                                   |
| `packages/vite-plugin/src/next/index.ts`                           | `registered`, `compiling`, `handle`, `untilRegistered`       | `FrameRequested`, `NextRecompiles`, `FrameWaitEnds`; `FrameWaitsForRegistry`  |

## How the check is built

`model/expected.tsv` has one row per check: config, rule, and the result expected. `current*.cfg` describe the code today. `fixed*.cfg` apply a fix, which shows a broken rule can hold. `ensure-keeps-timer`, `exit-unseen` and `no-stale-check` remove a guard, which shows a holding rule can fail. Add a row whenever you add a rule or a variant.
