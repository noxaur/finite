---
name: verify-edit-drafts
description: TLA+ model of half-finished work in Finite's web UI. Use when a change touches inspector/styleEditor.ts, useDraftField or ScrubLabel in DraftField.tsx, ColorPicker.tsx, ColorSwatch in TokensPanel.tsx, Composer.tsx (send, upload, QueuedChip), the comment draft in Comments.tsx, or finish/back in CommandMenu.tsx, or when typed text, a queued message, an attachment, a comment draft or a colour gets lost, wiped or sent twice.
---

# Verify edit drafts

`model/EditDrafts.tla` models six independent machines: inspector field and scrub label, token colour picker, composer with queued chips, attachment uploads, comment draft, command menu. `area` picks one at the start, so a run explores each alone. TLC checks every order of the modelled steps.

## Check a change

1. Run `git diff --name-only 51ee6f77f44453401756379b78aca7017ee11950 -- apps/web/src apps/server/src/agent/index.ts`. If nothing in the coverage table appears, you're done.
2. Read the changed code against the actions the table names. Each action is one synchronous stretch of code, split at every `await`.
3. Make the model say what the code now does: edit that action, or add a change name to `Changes` in `model/current.cfg` when the code now matches a variant.
4. Run `.agents/skills/verify-edit-drafts/check.sh`. It takes about a minute. Exit 0 means every row of `model/expected.tsv` matched. Exit 1 prints `MISMATCH` rows and the folder holding TLC's output. Exit 2 means TLC couldn't run.
5. Read every result with `/statechart`, using `model/view.ts` and `model/chart-inspector.cfg` or `model/chart-composer.cfg`. It gives the shortest path to a broken rule in plain words, and a chart when the rules hold.

## Read a mismatch

- `current RULE expected holds, got breaks`: the change broke a promise. Replay the shortest path against the real code, one step per action. If it happens, it's a real bug. Fix the code.
- `current RULE expected breaks, got holds`: a recorded bug is gone. Confirm the fix in the code, change that row to `holds`, delete the finding below, and add a variant that removes the fix so the rule can still fail.
- The path needs a step the code can't take (an order the browser never produces, an `await` that isn't there): the model is wrong. Fix the action and say which line proves it.
- `fixed` or a broken-variant row mismatching means the variant no longer does what its name says. Fix the variant. Never drop a rule or a row to get a pass.

## Rules

| Rule                                | Promise                                                      | Harm when broken                      | Now   |
| ----------------------------------- | ------------------------------------------------------------ | ------------------------------------- | ----- |
| `LeftTextReachesSource`             | Text you typed and left reaches the source, read as finished | A typed value silently vanishes       | holds |
| `SupersededFieldIsTold`             | A field whose draft was taken over knows it                  | Field keeps typing into a dead draft  | holds |
| `OnePreviewDriver`                  | A typing field and a scrub never both drive the preview      | Each wipes the other's preview        | holds |
| `OneSendPerTyping`                  | One typing session sends one source edit                     | Two undo steps, double write          | holds |
| `NoOrphanPreview`                   | Escape leaves no preview behind                              | Frame shows a value that isn't saved  | holds |
| `ClosedPickerHoldsNothing`          | A closed picker holds no pick                                | Swatch shows a stale colour           | holds |
| `ClosingNeverRewrites`              | Closing never saves an old pick over a newer value           | Someone's token edit is overwritten   | holds |
| `TextTypedDuringSendSurvives`       | Text typed after Send stays in the box                       | Text is wiped                         | holds |
| `SentTextLeavesTheBox`              | After a send, the box holds only what was typed after it     | The sent words come back in the box   | holds |
| `AttachmentAddedDuringSendSurvives` | A file attached during a send is still attached after it     | The file vanishes before it's sent    | holds |
| `FailedSendNowKeepsTheMessage`      | A Send now that fails leaves the message on the queue        | A queued message vanishes             | holds |
| `OneSendAtATime`                    | One press starts one send                                    | Duplicate message                     | holds |
| `QueuedMessageDeliveredOnce`        | A queued message reaches the agent once                      | The agent acts on it twice            | holds |
| `UploadsStayApart`                  | Each chip holds its own upload                               | An attachment is lost or duplicated   | holds |
| `NewerDraftSurvives`                | Finishing a comment never cancels a newer draft              | The new draft disappears              | holds |
| `CommentPostedOnce`                 | One Post makes one comment                                   | Duplicate comment                     | holds |
| `BackingOutStopsNavigation`         | Backing out stops the pending work from navigating           | The page jumps away after you left    | holds |
| `ErrorStaysOnItsStep`               | An error shows on the step that caused it                    | A confusing error on the wrong screen | holds |
| `OneMenuWorkAtATime`                | One action at a time from the menu                           | Two designs get connected             | holds |

Every `breaks` row has a `fixed` row where the rule holds. Every `holds` row has a broken variant where it fails.

## Findings at the sync commit

None open. Every rule holds on `current`; the regression tests are `editDrafts.test.ts` and `draftRaces.test.ts` in `apps/web/src/components`.

## Bounds and what's left out

Two messages, two presses of Send now, two uploads, two comment drafts, one DraftField, one scrub label. The areas don't interact, so each is explored alone.

Left out: a reply that's lost after the server applied the request (`verify-client-sync`), the agent's own turn lifecycle (`verify-agent-sessions`), editing a queued chip's text, a Send now whose requeue also fails (the words are lost then), removing a chip mid-upload, the system folder picker, and the inspector rebuilding its editor on a selection change. A pass covers these orders of these steps, and says nothing about rendering or real network timing.

## Coverage

Last synced: 51ee6f77f44453401756379b78aca7017ee11950. Move this forward only after confirming the model describes the code at the new commit.

| File                                               | Function                                           | Actions                                                                     | Rules                                                                                                        |
| -------------------------------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `apps/web/src/components/inspector/styleEditor.ts` | `begin`, `finishOpen`, `drive`, `commit`           | `Type`, `YouPressAScrubLabel`, scrub actions, `LeaveAndKeep`                | inspector rules                                                                                              |
| `apps/web/src/components/DraftField.tsx`           | `useDraftField`, `ScrubLabel`                      | `Type`, `LeaveAndKeep`, `YouEscapeTheField`, `YouPressAScrubLabel`          | inspector rules                                                                                              |
| `apps/web/src/components/ColorPicker.tsx`          | `show`, `finish`, `cancel`, unmount effect, `away` | token actions                                                               | `ClosedPickerHoldsNothing`, `ClosingNeverRewrites`                                                           |
| `apps/web/src/components/TokensPanel.tsx`          | `ColorSwatch`, `close`                             | `YouCloseThePicker`, `TheClosedPickerUnmounts`                              | `ClosedPickerHoldsNothing`, `ClosingNeverRewrites`                                                           |
| `apps/web/src/components/Composer.tsx`             | `send`                                             | `Press`, `TheSendIsAnswered`, `TheSendFails`, `YouAttachDuringTheSend`      | `TextTypedDuringSendSurvives`, `SentTextLeavesTheBox`, `AttachmentAddedDuringSendSurvives`, `OneSendAtATime` |
| `apps/web/src/components/Composer.tsx`             | `QueuedChip`                                       | `YouPressSendNow`, `TheSteerFails` and the chip actions                     | `QueuedMessageDeliveredOnce`, `FailedSendNowKeepsTheMessage`                                                 |
| `apps/web/src/components/Composer.tsx`             | `upload`                                           | `YouDropAFile`, `TheUploadLands`, `TheUploadFails`                          | `UploadsStayApart`                                                                                           |
| `apps/web/src/lib/composer.ts`                     | `sendModeFor`                                      | `YouPressSendWhileIdle`, `YouSteerTheRunningTurn`, `YouQueueForTheNextTurn` | `OneSendAtATime`                                                                                             |
| `apps/server/src/agent/index.ts`                   | `sendNow`, `finishTurn`, `editQueued`, `interrupt` | `TheServer*`, `TheTurnEnds*`, `YouPressStop`                                | `QueuedMessageDeliveredOnce`                                                                                 |
| `apps/web/src/components/Comments.tsx`             | `CommentLayer` draft, `Composer.submit`            | comment actions                                                             | `NewerDraftSurvives`, `CommentPostedOnce`                                                                    |
| `apps/web/src/canvas/tools/comment.ts`             | draft placement                                    | `YouPlaceACommentDraft`                                                     | `NewerDraftSurvives`                                                                                         |
| `apps/web/src/canvas/editor.ts`                    | `cancelCommentDraft`                               | `ThePostIsAnswered`, `YouCancelTheDraft`                                    | `NewerDraftSurvives`                                                                                         |
| `apps/web/src/components/CommandMenu.tsx`          | `finish`, `back`, `go`                             | menu actions                                                                | menu rules                                                                                                   |

To bring the model back in line after changes that skipped this check, use `/maintain-formal-verification-skill`.
