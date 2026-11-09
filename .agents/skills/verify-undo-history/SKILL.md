---
name: verify-undo-history
description: TLA+ model of per-person undo and redo. Use when a change touches apps/server/src/source/history.ts, step or apply in source/index.ts, patchCanvas or undoCanvas in store/open.ts, inversePatch in store/canvas.ts, apps/web/src/canvas/undoOrder.ts, or undo, edit or patch in canvas/editor.ts, or when undo takes the wrong step, redo reports "Nothing to redo", or one person's undo overwrites another's work.
---

# Verify undo history

`check.sh` runs a TLA+ model of undo through TLC, one run per row of `model/expected.tsv`, and compares each result with the record. It explores every order of edits, undos, redos and someone else's work inside the bounds below. A pass means the results match the record; no rule is recorded as broken in today's code.

## Run it after a change

1. **Does the change touch covered code?** Run `git diff --stat 4025ebd6712ebb76e092381adc0457c218cd56de -- <files in the coverage table>`. Done when you know which functions changed. If none, the check has nothing to say.
2. **Mirror the change in the model.** Each action in `model/UndoHistory.tla` cites its `file:line`. Edit the action, or flip a constant in `model/current.cfg` when one already describes the change. An action is one step between `await`s; split it if the code gained an `await`. Done when every changed line maps to an action, or you've written why it doesn't affect any.
3. **Run `.agents/skills/verify-undo-history/check.sh`.** About 75 seconds. Exit 0: every row matches. Exit 1: a row differs and the line names it. Exit 2: TLC couldn't run.
4. **Read each mismatch with `/statechart`.** Give it `model/UndoHistory.tla`, a config with the rule as an `INVARIANT`, and `model/view.ts`. `UNDO_CHART=text` with `model/chart-text.cfg`, or `UNDO_CHART=frame` with `model/chart-frame.cfg`, draws the whole flow. Write the output outside the repo.
5. **Decide what the mismatch means.** Replay the path against the real code, one step per action, with the real `createHistory`, `createUndoOrder` or `open.undoCanvas` and a held promise where the path needs one request to wait.
   - The replay shows the bad result: it's a real bug. Report the path in the code's words.
   - The replay doesn't: the model is wrong. Fix the action to match the code.
   - The change was meant to fix a recorded finding: flip that `current` row to `holds`.
   - The behaviour change is intended and a rule no longer applies: change the rule and say so to the person.
6. **Move the sync commit.** Once the model describes the code at the new commit, update `Last synced` below. Move it only after that check. For drift you didn't introduce, use `/maintain-formal-verification-skill`.

## Rules

| Rule                        | Plain meaning                                                 | Harm when broken                                            | Today |
| --------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------- | ----- |
| `NewEditClearsRedo`         | An edit asked for after an undo leaves nothing to redo        | Redo restores a step from before your newest edit           | holds |
| `PageMatchesServer`         | Every step the page offers, the server still has              | Redo or undo answers "Nothing to…" and wastes the key press | holds |
| `UndoTakesNewestEdit`       | ⌘Z takes back the edit you just made, even while it saves     | ⌘Z removes an older edit and the new one stays              | holds |
| `CanvasUndoKeepsOthersWork` | A canvas undo never overwrites a value someone else set since | Your undo silently throws away their move                   | holds |
| `UndosApplyInPressOrder`    | Quick undos of one file apply in press order                  | Steps refuse each other or land scrambled                   | holds |
| `SourceUndoKeepsOthersWork` | A source undo never overwrites text someone else wrote since  | Your undo deletes their text                                | holds |
| `RefusedStepIsDropped`      | A refused step leaves both stacks                             | The next undo hits the same wall forever                    | holds |

## Variants and bounds

`current*` configs describe today's code. `fixed` is the same code at the widest bounds. `no-file-lock`, `no-swap-check`, `keep-refused`, `no-forget-refused`, `no-one-at-a-time` and `no-canvas-check` each remove one guard, so each `holds` rule is seen failing.

| Config                  | Your source edits | Your frame moves | Someone's edits, moves, removals |
| ----------------------- | ----------------- | ---------------- | -------------------------------- |
| `current`               | 2                 | 0                | 1, 0, 0                          |
| `current-three-edits`   | 3 (a third file)  | 0                | 1, 0, 0                          |
| `current-canvas`        | 1                 | 1                | 0, 1, 1                          |
| `current-one-at-a-time` | 2                 | 1                | 1, 1, 1                          |
| `fixed`                 | 3                 | 1                | 1, 1, 1                          |

Two files with one span each, one canvas with one frame property, TLC 2.19. Someone else's request is a single step, because any timing against yours is another order TLC already tries.

## Left out

- Text-level matching: `swap` also finds a moved span, and identical text written by two people looks unchanged. Each span's value here names the edit that wrote it.
- Patches spanning several files, where locks are taken in sorted order.
- A page reload, which empties the page's order on purpose; ⌘Z then falls back to source undo (`editor.ts:896`).
- A lost connection, where the page can't tell whether the server ran the step.
- Requests from anywhere but one page: an agent over `/mcp`, or the same person in a second tab, doesn't go through `inTurn`.
- The depth limits: the page keeps 200 steps, each server stack 100, so past 100 edits the page can offer steps the server has dropped.
- Canvas patch kinds beyond moving a frame, someone else's redo, and someone else's canvas undo.

## Coverage

Last synced: `4025ebd6712ebb76e092381adc0457c218cd56de`

| File                                | Function                                    | Actions                                                     | Rules                                                                |
| ----------------------------------- | ------------------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------- |
| `apps/server/src/source/history.ts` | `push`, `step`, `stepPatches`, `swap`       | `EditLands`, `SourcePress`, `StepLands`, `StepRefused`      | all source rules                                                     |
| `apps/server/src/source/index.ts`   | `apply`, `write`, `step`, `transact`        | `YouStartEdit`, `EditReachesLock`, `EditLands`, `StepLands` | `NewEditClearsRedo`, `UndoTakesNewestEdit`, `UndosApplyInPressOrder` |
| `apps/server/src/source/files.ts`   | `createLocks`                               | `Turn`, `EditReachesLock`                                   | `UndosApplyInPressOrder`                                             |
| `apps/server/src/store/open.ts`     | `apply`, `patchCanvas`, `undoCanvas`        | `YouMoveFrame`, `CanvasPress`, `OtherMovesFrame`            | `CanvasUndoKeepsOthersWork`, `RefusedStepIsDropped`                  |
| `apps/server/src/store/canvas.ts`   | `applyPatch`, `inversePatch`, `overwritten` | `CanvasPress`                                               | `CanvasUndoKeepsOthersWork`                                          |
| `apps/web/src/canvas/undoOrder.ts`  | `did`, `undo`, `redo`, `forget`, `inTurn`   | `PressStep`, `ReplyArrives`, `StepRefused`, `MayRequest`    | `PageMatchesServer`, `NewEditClearsRedo`, `UndoTakesNewestEdit`      |
| `apps/web/src/canvas/editor.ts`     | `undo`, `edit`, `patch`                     | `PressStep`, `ReplyArrives`                                 | `PageMatchesServer`, `UndoTakesNewestEdit`                           |
