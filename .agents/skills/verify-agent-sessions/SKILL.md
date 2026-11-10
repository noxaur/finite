---
name: verify-agent-sessions
description: TLA+ model of an agent thread's Claude Code session. Use when a change touches apps/server/src/agent/index.ts (sendNow, deliver, consume, finishTurn, holdForSteer, ended, shut, armIdle, interrupt, finishSetup), ThreadMeta or threadSection in packages/protocol/src/model.ts, thread.snooze or thread.settle in handlers.ts, the crash repair in store/open.ts, or when a thread shows the wrong running state, a queued message goes missing or Stop misbehaves.
---

# Verify agent sessions

`model/AgentSession.tla` is a model of one thread: its persisted `ThreadMeta`, its `Live` session, the per-thread serial lock, the consume loop and the Claude Code process. TLC explores every order of those steps within the bounds below. `./check.sh` runs every row of `model/expected.tsv` and exits 0 when each result matches the record.

## Check a change

1. Open the coverage table. If the diff touches nothing in it, you're done.
2. Read the changed code against the action named in the table. Mirror each behaviour change in `model/AgentSession.tla`, keeping one action per step: cut at every point where the CLI, the consume loop or snooze/settle can act. Done when every changed line maps to an action or to "Left out".
3. Run `.agents/skills/verify-agent-sessions/check.sh` from the repo root. It took 196 seconds on a busy Mac (load average 30 to 100). Exit 0 means every row matched. Exit 2 means TLC couldn't run or the model has an error: read the kept `.out` file.
4. For each `MISMATCH`, read the counterexample in the kept `.out` file: TLC lists each state from the start to the broken rule.
   - `expected holds, got breaks`: the path is a new way to break the rule. Replay it step by step against `apps/server/src/agent/agent.test.ts`'s fake SDK. If it reproduces, it's a real bug. If it doesn't, the model is wrong: fix the model.
   - `expected breaks, got holds` on a `current*` row: your change fixed that finding. Flip the row to `holds`, remove the finding below, and keep the code path true in the model.
5. When the check matches and the model describes the code, confirm every row of the coverage table against the code.

## Rules

A rule is checked only while no lock section is running or waiting, except where noted.

| Rule                             | In plain words                                                                                                                                                       | Now   |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| `ShownRunningHasATurn`           | A thread shown running has a session with a turn in it.                                                                                                              | holds |
| `TurnInFlightIsShown`            | A turn Claude Code is working on is shown running.                                                                                                                   | holds |
| `NoQueuedMessageLost`            | A message taken off the queue reaches a session.                                                                                                                     | holds |
| `QueueOnlyWaitsAfterStopOrCrash` | A queued message waits only because you pressed Stop or the session crashed. The chips (`QueuedChip` in `Composer.tsx`) keep it visible and sendable in those cases. | holds |
| `StopNeverSendsTheQueue`         | Stop never sends the next queued message.                                                                                                                            | holds |
| `StopFlagEndsWithItsTurn`        | What Stop recorded for a turn ends with that turn; the next turn is unaffected.                                                                                      | holds |
| `ProdGrantEndsWithItsTurn`       | A `move_to_prod` grant applies to the turn that asked for it.                                                                                                        | holds |
| `StoppedResultLeavesLaterGrant`  | A stopped turn's late result doesn't take a later turn's `move_to_prod` grant.                                                                                       | holds |
| `ReplacedSetupIsRemoved`         | A setup design that `finish_setup` replaced is removed when its session goes.                                                                                        | holds |
| `EveryLiveHasATurnOrIdleTimer`   | A session in `lives` has a turn or an idle timer.                                                                                                                    | holds |
| `OneSessionPerThread`            | A thread has at most one Claude Code process.                                                                                                                        | holds |
| `MessageRevivesThread`           | A delivered message clears snooze and settle.                                                                                                                        | holds |

## Findings at the last sync

None: every rule holds.

## What the CLI really does

Measured against Claude Code 2.1.311 and SDK 0.3.309 with haiku. The SDK types say the same about the first two.

- `interrupt()` resolves before the cancelled turn's result, 4 to 12 ms earlier. The fake in `agent.test.ts` emits the result first, so it never exercises the gap.
- Every result carries the `user_message_uuid` of the message it answers, cut and cancelled ones included. The server compares it with the messages sent before the last Stop (`answersStop`), so a Stop can't reach a later turn.
- A steer with a uuid waiting behind a running tool is taken back by `interrupt({ cancelQueued: true })` and listed under `cancelled`. A plain interrupt leaves it, the receipt lists it under `still_queued`, and it runs. CLIs without `interrupt_cancel_queued_v1` ignore the option and the steer runs.
- A message pushed in that gap isn't counted: the cancelled result says `queued_turn_count: 0`, and the message then runs as its own turn.
- An in-process MCP tool gets its call's id in `extra._meta["claudecode/toolUseId"]`. It's the id of the `tool_use` block in the stream, and that block is in the stream before the tool runs. The tool doesn't wait for the server to read the stream, so a grant can land before the results ahead of it are handled.

The model lets the receipt and the result come in either order.

## Bounds and assumptions

The `current` row covers 3 sends, 1 Stop and 1 crash. `current-four-sends` covers 4 sends and 1 Stop, `current-prod` 1 grant and 1 Stop, `current-setup` a setup thread with 1 crash, `current-reject` rejected delivers. `fixed*` rows repeat the rules at smaller bounds; `fixed` also includes a restart. One thread, one queue position per message, no message text.

Timing assumptions: a steer's turn starts well inside the 3 s grace (measured 37 ms), and a crash doesn't land on the 10-minute idle timer.

Left out: `editQueued` (inside the lock, only removes or rewrites), `writing` file locks, `sessionId` and resume, spawned child threads, `stopDesign` (ends in the design's removal), `awaitingSince`, `settledAt` (`settle`, `granted`), event mapping and which errors are suppressed, a deliver that rejects while taking a message off the queue, a store write that fails after deliver marks running, a `move_to_prod` with no call id (any stopped result revokes it, which fails safe), a grant that lands after its own turn's result was handled, and a finished or steered result revoking a later turn's grant (`StoppedResultLeavesLaterGrant` covers stopped results only). A server restart appears only in `fixed`: `openDesign` in `store/open.ts` repairs `running` before anything reads it.

## Coverage

| File                                   | Function                                             | Backs                                                                    |
| -------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------ |
| `apps/server/src/agent/index.ts`       | `Live`, `inThread`                                   | the state record and lock                                                |
|                                        | `sendNow`, `start`                                   | `RunSend`                                                                |
|                                        | `deliver`                                            | `DeliverPrepares`, `DeliverPushes`, `DeliverRejects`                     |
|                                        | `consume`, `answersStop`                             | `ConsumeInit`, `ConsumeCall`, `ConsumeResult`, `ConsumeEnd`, `RunResult` |
|                                        | `holdForSteer`                                       | `RunResult`, `RunGrace`                                                  |
|                                        | `finishTurn`, `removeSetup`                          | `FinishTurn`, `RemoveSetup`                                              |
|                                        | `ended`                                              | `RunEnded`                                                               |
|                                        | `shut`, `armIdle`                                    | `Shut`, `RunIdle`, `IdleTimerFires`                                      |
|                                        | `interrupt`                                          | `RunInterrupt`, `InterruptAnswered`, `InterruptFails`                    |
|                                        | `finishSetup`, `grantProdWrite`, `grantIsLater`      | `AgentFinishesSetup`, `AgentMovesToProd`, `RunResult`                    |
| `apps/server/src/store/open.ts`        | crash repair at load                                 | `ServerRestarts`                                                         |
| `apps/server/src/handlers.ts`          | `thread.snooze`, `thread.settle`, `thread.interrupt` | `YouSnooze`, `YouSettle`, `YouPressStop`                                 |
| `packages/protocol/src/model.ts`       | `ThreadMeta`, `threadSection`                        | persisted fields                                                         |
| `apps/web/src/components/Composer.tsx` | queued chips                                         | visibility in `QueueOnlyWaitsAfterStopOrCrash`                           |

The CLI actions come from the measurements above. Re-measure them when the `@anthropic-ai/claude-agent-sdk` version changes.
