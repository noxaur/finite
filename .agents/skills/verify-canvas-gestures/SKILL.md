---
name: verify-canvas-gestures
description: TLA+ model of the canvas's press, tool, pen, text-edit and selection state. Use when a change touches apps/web/src/canvas/editor.ts (onDown, press, onMove, onUp, cancelPress, backToMove, setTool, finishText, escape), tools/pen.ts, tools/vectorEdit.ts, tools/vectorState.ts, tools/text.ts, tools/draw.ts, RichTextEditor.tsx, or a tool's begin() or end(), or when a drag gets stuck or cancelled, a pen draft vanishes, typed text is lost, or the wrong thing is selected.
---

# Verify canvas gestures

`model/CanvasGestures.tla` is a model of how presses, tools, pen drafts, text edits and selection move between states. TLC explores every order of events within the bounds below, which unit tests can't. It checks the design as written in the model, so a code change only reaches it when you mirror the change in the model.

## Check a change

1. Run `git diff --name-only $(git merge-base HEAD main) -- apps/web/src/canvas apps/web/src/components/LayersTree.tsx` and compare it with the coverage table. No covered function changed: stop, nothing to check.
2. Mirror each change in `model/CanvasGestures.tla`. A new `await` splits an action in two. A new or removed guard changes the action's enabling condition. Each action's comment names the function it mirrors. Where a constant already describes the change, set it in `model/current.cfg` (or `text.cfg`, `selection.cfg`, `pen.cfg`, whichever the action's scope uses).
3. Run `.agents/skills/verify-canvas-gestures/check.sh`. Done when it exits 0, or every `MISMATCH` line is explained by step 4. It took 277 seconds on a busy Mac (load average 30 to 70).
4. Read each `MISMATCH` counterexample in the kept `.out` file; it lists each state from the start to the broken rule. Then decide:
   - **`expected holds, got breaks`**: replay the path against the real code, one step per action, with the `editorOnViewport` harness in `apps/web/src/canvas/editor.test.ts`. If it happens, your change introduced a bug. If it can't happen, the model mirrors the code wrongly: fix the model.
   - **`expected breaks, got holds`** on a `current`, `pen`, `text` or `selection` row: you fixed a finding. Flip the row to `holds`, and remove it from Findings.
   - **`got error`**: the model is broken (a TLC syntax error, a deadlock). Read the kept `.out` file.
5. When the change is intended and verified, confirm every row of the coverage table against the code.

Never weaken a rule to get a pass. Add a rule with a row in `model/expected.tsv` and a variant showing it can fail.

## Rules

| Rule                            | In plain words                                                                 | Scope and current result                |
| ------------------------------- | ------------------------------------------------------------------------------ | --------------------------------------- |
| `DraggingOnlyWhileLive`         | The canvas thinks you're dragging only while a press really is.                | pointer, holds                          |
| `FinishingLeavesNextPressAlone` | Finishing one press never cancels the press after it.                          | pointer, holds                          |
| `SameToolKeepsPenDraft`         | Pressing the key of the tool you're on leaves your pen draft alone.            | pointer, holds                          |
| `FinishedPathLeavesNewDraft`    | Finishing one pen path doesn't end the one you've started since.               | pointer (`pen.cfg`), holds              |
| `GestureEndsAtMostOnce`         | A gesture's `end` runs at most once.                                           | pointer, holds                          |
| `NoOrphanGesture`               | Every running gesture belongs to a press that will end it.                     | pointer, holds with one or two pointers |
| `PointCountHasOwners`           | The point editor's `gestures` count is only held up by gestures that will end. | pointer, holds with one or two pointers |
| `TextFinishesOnce`              | One text edit finishes once.                                                   | text, holds                             |
| `OnlyEditedElementHidden`       | Only the element being typed in is hidden.                                     | text, holds                             |
| `TypedTextIsKept`               | Text you typed and kept is written, or stays in front of you.                  | text, holds                             |
| `OneKindOfSelection`            | One kind of thing is selected at a time.                                       | selection, holds                        |
| `OneCommentSurface`             | A comment draft and an open comment never show together.                       | selection, holds                        |
| `LandingKeepsYourPick`          | A shape that lands doesn't replace what you picked while it was on its way.    | selection, holds                        |
| `NewestLandingIsSelected`       | Of two shapes landing at once, the newest ends up selected unless you picked.  | selection, holds                        |

`model/expected.tsv` records each rule's result per variant. `current`, `pen`, `text`, `selection` and `two-pointers` are the code as it stands. `fixed`, `pen-fixed`, `text-fixed` and `selection-fixed` set the guards the fixes added. `up-keeps-current`, `cancel-no-end`, `no-done-guard` and `landings-blind` show the holding rules can fail.

## Findings (the code breaks these today)

None.

## Bounds and what's left out

- Pointer scope: 2 presses, tools Move, a shape tool, Pen, point editing (`pen.cfg`: 3 presses, Move and Pen). Pen draft: up to 2 anchors. Text: 2 elements, each opened once, one outside edit. Selection: unbounded picks, up to two draws at a time.
- `begin()` is modelled as always resolving to a gesture, never `null`. Only Move's `begin()` waits; every other tool's resolves in the same step.
- Left out: `dispose()` mid-gesture (rare unmount), the override maps' ownership, hover, Inspect, the image tool, new text from the Text tool (`target.kind === "new"`), frame reloads and HMR during a text edit, the vector edit queue's rejection path, undo order (`verify-undo-history` covers it). A pass says nothing about these.
- `EditLands` is one step for what's several in `finishText`: the second read, the retry over the new rev, and `keepTyped`. If a second text box opened while a refused edit was on its way, the words go in a notice instead of a box, and the same goes when another element has taken the loc or the `keeps` changed. The model doesn't tell those apart, and a box that `keepTyped` puts back isn't a new `editing` state.
- `onPath` in `tools/text.ts` lands through the same `land` as `draw`, and isn't modelled separately. The pen's second select of the path (`place` in `tools/pen.ts`) runs only while the selection is the one `land` set, so it isn't a pick either.
- Scopes run separately: a bug that needs a press and a text edit interleaved wouldn't show. The code keeps them apart in `onDown` in `editor.ts`, where a press during a text edit only blurs.

## Coverage

| File (under `apps/web/src/canvas/`)             | Functions                                                                                                             | Backs                                                                                                    |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `editor.ts`                                     | `onDown`, `taken`, `press`, `onMove`, `onUp`, `backToMove`, `cancelPress`, `setTool`, `key`, `escape`                 | `PressDown`, `DragPastSlop`, `BeginResolves`, `PressUp`, `Finished`, `PickTool`, `CancelPress`           |
| `editor.ts`                                     | `finishText`, `keepTyped`, `notSaved`, `refused`, `selectText`, `selectObject`, `openComment`, the store subscription | `KeepText`, `DiscardText`, `EditLands`, `ClickTextLabel`, `ClickSection`, `OpenAComment`, `PickInLayers` |
| `tools/move.ts`                                 | press plans, `beginDragInFrame`, `onDoubleClick`                                                                      | `DragPastSlop`, `ClickElementOnCanvas`, `DoubleClickText`                                                |
| `tools/shapes.ts`                               | `shapeTool`, `boxGesture`                                                                                             | `Sticky`, `Finished`                                                                                     |
| `tools/pen.ts`                                  | `pen`, `finish`                                                                                                       | `PressDown`, `PenFinish`, `PenPlaced`, `SameToolKeepsPenDraft`                                           |
| `tools/vectorEdit.ts`, `tools/vectorState.ts`   | `enterVector`, `gestureOver`, `gestureStarted`, `gestureEnded`                                                        | `EnterPointEditing`, `LeavePointEditing`, `PointCountHasOwners`                                          |
| `tools/text.ts`, `RichTextEditor.tsx`           | `editText`, `openEditor`, `finish`, the layout effect                                                                 | `DoubleClickText`, `EditorOpens`, `KeepText`, `DiscardText`, `LateBlur`                                  |
| `tools/draw.ts`, `tools/comment.ts`             | `draw`, `landing`, `placeComment`                                                                                     | `DrawStarts`, `DrawLands`, `PlaceCommentOffFrame`, `PlaceCommentOnFrame`                                 |
| `apps/server/src/source/rewrite.ts`, `files.ts` | the `revs` check, `rev`                                                                                               | `OutsideEdit`, `EditLands`                                                                               |
| `apps/web/src/components/LayersTree.tsx`        | the row's `selectionStore.set`                                                                                        | `PickInLayers`                                                                                           |
