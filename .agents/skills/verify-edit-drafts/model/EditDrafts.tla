---- MODULE EditDrafts ----
(* Half-finished work a person holds in Finite's web UI: inspector fields, the token colour
   picker, the composer and its queued chips, attachment uploads, comment drafts, the command menu.
   The six areas share no state, so `area` picks one at the start and each run explores that area
   alone. Each action is one synchronous stretch of code, and splits at every await.
   Paths are under apps/web/src/components unless they say otherwise. *)
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS
  Areas,    \* which areas to explore
  Changes   \* names of the code changes this variant applies; {} is the code as it stands

Has(c) == c \in Changes

Msgs == {"m1", "m2"}
Runs == {1, 2}
Uploads == {"u1", "u2"}
Drafts == {"d1", "d2"}

VARIABLES area, insp, token, send, upload, comment, menu
vars == <<area, insp, token, send, upload, comment, menu>>

OnlyInsp    == UNCHANGED <<area, token, send, upload, comment, menu>>
OnlyToken   == UNCHANGED <<area, insp, send, upload, comment, menu>>
OnlySend    == UNCHANGED <<area, insp, token, upload, comment, menu>>
OnlyUpload  == UNCHANGED <<area, insp, token, send, comment, menu>>
OnlyComment == UNCHANGED <<area, insp, token, send, upload, menu>>
OnlyMenu    == UNCHANGED <<area, insp, token, send, upload, comment>>

Init ==
  /\ area \in Areas
  /\ insp = [focus |-> FALSE,       \* the DraftField has the browser's focus
             typed |-> "none",      \* DraftField `typing`: none | whole (the live preview is the value)
                                    \*   | partial (reads as a value only once finished, e.g. a short hex)
             handle |-> FALSE,      \* DraftField `draft.current` is set
             open |-> "none",       \* styleEditor `open`: none | field
             edits |-> FALSE,       \* styleEditor mine.edits is non-null
             scrub |-> "none",      \* the `drive` in progress: none | pressed | moving
             preview |-> "none",    \* what the frame shows: none | field | scrub | landing
             sent |-> "nothing",    \* last value sent for this typing session: nothing | whole | final
             sends |-> 0,           \* source edits sent for this typing session
             lost |-> FALSE]        \* the person left the field and the source lacks what they typed
  /\ token = [phase |-> "closed",   \* closed | open | closing (close() ran, ColorPicker not unmounted yet)
              gesture |-> FALSE,    \* ColorPicker `gesture.current` is set
              picked |-> "none",    \* TokenSwatch `picked`
              kept |-> "none",      \* TokenSwatch `kept.current`
              color |-> "c0",       \* the token's saved value
              touched |-> FALSE,    \* the person changed the colour since opening this time
              rewrote |-> FALSE]    \* a close saved over a newer value with an old pick
  /\ send = [text |-> "",           \* Composer `text`
             used |-> {},           \* messages written so far (bound)
             flight |-> "none",     \* the thread.send under way: none | pending | answered
             flightText |-> "",
             mode |-> "steer",
             running |-> FALSE,     \* thread.running
             queued |-> <<>>,       \* thread.queued
             delivered |-> [m \in Msgs |-> 0],
             chip |-> [r \in Runs |-> "idle"],   \* each press of Send now, QueuedChip's onClick
             chipMsg |-> [r \in Runs |-> ""],
             lostText |-> FALSE,    \* a reply wiped text typed after the send
             echo |-> FALSE,        \* a reply left the sent text in the box in front of what came after
             attached |-> FALSE,    \* a file was attached while the send was under way
             lostFile |-> FALSE,    \* a reply cleared a file it didn't send
             vanished |-> FALSE,    \* a failed Send now lost the message it had taken off the queue
             doubled |-> FALSE]     \* a second send started while one was under way
  /\ upload = [chip |-> [u \in Uploads |-> "absent"],  \* absent | uploading | own | other (holds the other's path)
               net |-> [u \in Uploads |-> "idle"]]     \* idle | flying | over
  /\ comment = [draft |-> "none",   \* editor.state.commentDraft
                used |-> {},
                flight |-> "none",  \* comment.add under way: none | pending | answered
                flightOf |-> "none",
                posts |-> [d \in Drafts |-> 0],
                dropped |-> FALSE]  \* a reply cancelled a draft it didn't post
  /\ menu = [step |-> "root",       \* CommandMenu `step`: root | connect
             busy |-> FALSE,
             works |-> 0,           \* finish() bodies running
             backed |-> FALSE,      \* the person backed out while work ran
             closed |-> FALSE,
             error |-> FALSE,
             misplaced |-> FALSE,   \* an error landed on a step that didn't start the work
             strayed |-> FALSE]     \* work navigated after the person backed out

(* ---- Inspector field and scrub label: inspector/styleEditor.ts, DraftField.tsx ---- *)

\* DraftField.tsx useDraftField's onFocus, a new typing session.
YouFocusTheField ==
  /\ area = "inspector" /\ ~insp.focus /\ insp.scrub = "none" /\ insp.typed = "none"
  /\ insp' = [insp EXCEPT !.focus = TRUE, !.sent = "nothing", !.sends = 0, !.lost = FALSE]
  /\ OnlyInsp

CanType == insp.focus /\ (insp.scrub = "none" \/ Has("field-keeps-focus"))

\* DraftField.tsx useDraftField's show(): begin() on the first keystroke, then preview. styleEditor.ts begin, preview.
Type(kind) ==
  LET starting == ~insp.handle
      live == starting \/ insp.open = "field"
      edits == kind = "whole"
  IN insp' = [insp EXCEPT
       !.typed = kind,
       !.handle = TRUE,
       !.open = IF starting THEN "field" ELSE @,
       !.edits = IF live THEN edits ELSE @,
       !.preview = IF ~live THEN @ ELSE IF edits THEN "field" ELSE "none"]

YouTypeAWholeValue == area = "inspector" /\ CanType /\ Type("whole") /\ OnlyInsp
YouTypeAPartialValue == area = "inspector" /\ CanType /\ Type("partial") /\ OnlyInsp

\* DraftField.tsx ScrubLabel's onPointerDown runs editor.drive; styleEditor.ts drive calls finishOpen, which runs the field's
\* onLost (styleEditor.ts finishOpen, DraftField.tsx useDraftField's show), which is finish(true), then commits what's left.
\* The browser moves focus later, on mousedown, so the field is still open here.
YouPressAScrubLabel ==
  /\ area = "inspector" /\ insp.scrub = "none"
  /\ LET sendsOpen == insp.open = "field" /\ insp.edits
         finishes == Has("superseded-finishes") /\ insp.open = "field"
     IN insp' = [insp EXCEPT
          !.scrub = "pressed",
          !.open = "none",
          !.edits = FALSE,
          !.typed = IF finishes THEN "none" ELSE @,
          !.handle = IF finishes THEN FALSE ELSE @,
          !.sent = IF finishes THEN (IF insp.typed = "partial" THEN "final" ELSE "whole")
                   ELSE IF sendsOpen THEN "whole" ELSE @,
          !.sends = IF finishes \/ sendsOpen THEN @ + 1 ELSE @,
          !.preview = IF finishes \/ sendsOpen THEN "landing" ELSE "none"]
  /\ OnlyInsp

\* The browser moves focus on mousedown, right after pointerdown and before any later pointer event.
FocusSettled == ~insp.focus \/ Has("field-keeps-focus")

\* styleEditor.ts drive's onMove.
YouDragTheScrub ==
  /\ area = "inspector" /\ insp.scrub \in {"pressed", "moving"} /\ FocusSettled
  /\ insp' = [insp EXCEPT !.scrub = "moving", !.preview = "scrub"]
  /\ OnlyInsp

\* styleEditor.ts drive's stop(true).
YouReleaseTheScrub ==
  /\ area = "inspector" /\ insp.scrub # "none" /\ FocusSettled
  /\ insp' = [insp EXCEPT !.scrub = "none",
                          !.preview = IF insp.scrub = "moving" THEN "landing" ELSE @]
  /\ OnlyInsp

\* styleEditor.ts drive's stop(false), Escape or pointercancel.
YouEscapeTheScrub ==
  /\ area = "inspector" /\ insp.scrub # "none" /\ FocusSettled
  /\ insp' = [insp EXCEPT !.scrub = "none",
                          !.preview = IF insp.scrub = "moving" THEN "none" ELSE @]
  /\ OnlyInsp

\* DraftField.tsx useDraftField's finish(true), from onBlur, Enter or unmounting. styleEditor.ts begin's commit:
\* `live()` makes a stale handle do nothing.
LeaveAndKeep ==
  LET expected == IF insp.typed = "partial" THEN "final" ELSE "whole"
      live == insp.handle /\ (insp.open = "field" \/ Has("no-live-guard"))
      ends == insp.typed # "none"
  IN insp' = [insp EXCEPT
       !.focus = FALSE,
       !.typed = "none",
       !.handle = FALSE,
       !.open = IF live THEN "none" ELSE @,
       !.edits = IF live THEN FALSE ELSE @,
       !.sent = IF live THEN expected ELSE @,
       !.sends = IF live THEN @ + 1 ELSE @,
       !.preview = IF live THEN "landing" ELSE @,
       !.lost = IF ends /\ ~live /\ insp.sent # expected THEN TRUE ELSE @]

\* Mousedown on the label moved focus off the field.
TheBrowserBlursTheField ==
  /\ area = "inspector" /\ insp.focus /\ insp.scrub # "none" /\ ~Has("field-keeps-focus")
  /\ LeaveAndKeep /\ OnlyInsp

YouLeaveTheField ==
  /\ area = "inspector" /\ insp.focus /\ insp.scrub = "none"
  /\ LeaveAndKeep /\ OnlyInsp

\* DraftField.tsx useDraftField's finish(false). styleEditor.ts begin's cancel clears the preview.
YouEscapeTheField ==
  /\ area = "inspector" /\ insp.focus /\ insp.scrub = "none"
  /\ LET live == insp.handle /\ insp.open = "field"
     IN insp' = [insp EXCEPT
          !.focus = FALSE, !.typed = "none", !.handle = FALSE,
          !.open = IF live THEN "none" ELSE @,
          !.edits = IF live THEN FALSE ELSE @,
          !.preview = IF live /\ ~Has("cancel-keeps-preview") THEN "none" ELSE @]
  /\ OnlyInsp

\* The frame's HMR update replaces a landing preview.
TheEditLands ==
  /\ area = "inspector" /\ insp.preview = "landing"
  /\ insp' = [insp EXCEPT !.preview = "none"]
  /\ OnlyInsp

(* ---- Token colour picker: TokensPanel.tsx ColorSwatch, ColorPicker.tsx ---- *)

\* TokensPanel.tsx ColorSwatch's button onClick.
YouOpenTheTokenPicker ==
  /\ area = "token" /\ token.phase = "closed"
  /\ token' = [token EXCEPT !.phase = "open", !.touched = FALSE]
  /\ OnlyToken

\* ColorPicker.tsx show(): a drag, a held arrow key, or a typed hex. edit.preview sets `picked`.
YouChangeTheColor ==
  /\ area = "token" /\ token.phase = "open"
  /\ token' = [token EXCEPT !.gesture = TRUE, !.picked = "pick", !.touched = TRUE]
  /\ OnlyToken

\* ColorPicker.tsx finish(), edit.commit.
YouFinishTheChange ==
  /\ area = "token" /\ token.phase = "open" /\ token.gesture
  /\ token' = [token EXCEPT !.gesture = FALSE, !.kept = token.picked]
  /\ OnlyToken

\* ColorPicker.tsx cancel(), edit.cancel.
YouEscapeTheChange ==
  /\ area = "token" /\ token.phase = "open" /\ token.gesture
  /\ token' = [token EXCEPT !.gesture = FALSE, !.picked = token.kept]
  /\ OnlyToken

\* TokensPanel.tsx ColorSwatch's close(), reached by the swatch or by pressing outside (ColorPicker.tsx's `away` listener).
\* The capture listener runs before the browser blurs the hex field.
YouCloseThePicker ==
  /\ area = "token" /\ token.phase = "open"
  /\ LET saves == token.picked # "none" /\ token.picked # token.color
     IN token' = [token EXCEPT
          !.phase = "closing", !.picked = "none", !.kept = "none",
          !.color = IF saves THEN token.picked ELSE @,
          !.rewrote = @ \/ (saves /\ token.color = "newer" /\ ~token.touched)]
  /\ OnlyToken

\* ColorPicker.tsx's unmount effect runs finish(); edit.commit stops at `closed`, TokensPanel.tsx ColorSwatch.
TheClosedPickerUnmounts ==
  /\ area = "token" /\ token.phase = "closing"
  /\ token' = [token EXCEPT
       !.phase = "closed", !.gesture = FALSE,
       !.picked = IF token.gesture /\ ~Has("picker-closed-guard") THEN token.color ELSE "none",
       !.kept = IF token.gesture /\ ~Has("picker-closed-guard") THEN token.color ELSE "none"]
  /\ OnlyToken

\* An undo, or another person editing the token.
TheTokenChangesElsewhere ==
  /\ area = "token" /\ token.phase = "closed" /\ token.color # "newer" /\ token.color # "c0"
  /\ token' = [token EXCEPT !.color = "newer"]
  /\ OnlyToken

(* ---- Composer and queued chips: Composer.tsx, lib/composer.ts, server agent sendNow ---- *)

NextMsg == CHOOSE m \in Msgs \ send.used : \A o \in Msgs \ send.used : m <= o \/ m = o

\* Composer.tsx `setText`. The textarea stays editable during a send.
YouWriteAMessage ==
  /\ area = "composer" /\ send.text = "" /\ send.used # Msgs
  /\ LET m == IF "m1" \in send.used THEN "m2" ELSE "m1"
     IN send' = [send EXCEPT !.text = m, !.used = @ \union {m}]
  /\ OnlySend

\* "m2" is "m1" with more typed after it.
YouKeepTypingDuringTheSend ==
  /\ area = "composer" /\ send.flight # "none" /\ send.text = "m1" /\ send.flightText = "m1"
  /\ send' = [send EXCEPT !.text = "m2", !.used = @ \union {"m2"}]
  /\ OnlySend

\* Composer.tsx upload() adds a chip while the send is under way.
YouAttachDuringTheSend ==
  /\ area = "composer" /\ send.flight # "none" /\ ~send.attached
  /\ send' = [send EXCEPT !.attached = TRUE]
  /\ OnlySend

\* Composer.tsx send(), lib/composer.ts sendModeFor. Alt picks the other mode while running.
Press(mode) ==
  /\ send.text # ""
  /\ send.flight = "none" \/ (Has("no-send-guard") /\ ~send.doubled)   \* the variant gets one extra press, to stay finite
  /\ send' = [send EXCEPT !.flight = "pending", !.flightText = send.text, !.mode = mode,
                          !.doubled = @ \/ send.flight # "none"]

YouPressSendWhileIdle ==
  /\ area = "composer" /\ ~send.running /\ Press("steer") /\ OnlySend
YouSteerTheRunningTurn ==
  /\ area = "composer" /\ send.running /\ Press("steer") /\ OnlySend
YouQueueForTheNextTurn ==
  /\ area = "composer" /\ send.running /\ Press("queue") /\ OnlySend

Deliver(s, m) == [s.delivered EXCEPT ![m] = @ + 1]

\* apps/server/src/agent/index.ts sendNow, serial per thread.
TheServerQueuesIt ==
  /\ area = "composer" /\ send.flight = "pending" /\ send.running /\ send.mode = "queue"
  /\ send' = [send EXCEPT !.flight = "answered", !.queued = Append(@, send.flightText)]
  /\ OnlySend

TheServerDeliversIt ==
  /\ area = "composer" /\ send.flight = "pending" /\ ~(send.running /\ send.mode = "queue")
  /\ send' = [send EXCEPT !.flight = "answered", !.running = TRUE,
                          !.delivered = Deliver(send, send.flightText)]
  /\ OnlySend

\* Composer.tsx send() takes the sent text out of the box after the await: all of it if nothing was typed
\* (send-keeps-new-text), and only the sent part when more came after it (send-strips-sent).
\* It also clears the files that were sent, and a file attached since stays (send-clears-only-sent).
TheSendIsAnswered ==
  /\ area = "composer" /\ send.flight = "answered"
  /\ LET newer == send.text # send.flightText
         keep == newer /\ Has("send-keeps-new-text")
     IN send' = [send EXCEPT !.flight = "none", !.text = IF keep THEN @ ELSE "",
                             !.lostText = @ \/ (newer /\ ~keep),
                             !.echo = @ \/ (keep /\ ~Has("send-strips-sent")),
                             !.lostFile = @ \/ (send.attached /\ ~Has("send-clears-only-sent")),
                             !.attached = FALSE]
  /\ OnlySend

\* Composer.tsx send()'s catch keeps the text and shows a toast.
TheSendFails ==
  /\ area = "composer" /\ send.flight = "pending"
  /\ send' = [send EXCEPT !.flight = "none"]
  /\ OnlySend

\* apps/server/src/agent/index.ts finishTurn pops the queue's head and delivers it.
TheTurnEndsAndTakesTheQueue ==
  /\ area = "composer" /\ send.running /\ send.queued # <<>>
  /\ send' = [send EXCEPT !.queued = Tail(@), !.delivered = Deliver(send, Head(send.queued))]
  /\ OnlySend

TheTurnEnds ==
  /\ area = "composer" /\ send.running /\ send.queued = <<>>
  /\ send' = [send EXCEPT !.running = FALSE]
  /\ OnlySend

\* apps/server/src/agent/index.ts interrupt; the queue stays.
YouPressStop ==
  /\ area = "composer" /\ send.running
  /\ send' = [send EXCEPT !.running = FALSE]
  /\ OnlySend

\* Composer.tsx QueuedChip's Send now onClick, `await edit(null)`. The button has no in-flight guard.
YouPressSendNow(r) ==
  /\ area = "composer" /\ send.chip[r] = "idle" /\ send.queued # <<>>
  /\ send' = [send EXCEPT !.chip[r] = "dequeuing", !.chipMsg[r] = Head(send.queued)]
  /\ OnlySend

InQueue(m) == \E i \in 1..Len(send.queued) : send.queued[i] = m
Without(q, m) == SelectSeq(q, LAMBDA x : x # m)

\* apps/server/src/agent/index.ts editQueued refuses an id that's gone.
TheServerAnswersTheDequeue(r) ==
  /\ area = "composer" /\ send.chip[r] = "dequeuing"
  /\ LET m == send.chipMsg[r]
     IN send' = [send EXCEPT !.chip[r] = IF InQueue(m) THEN "dequeued" ELSE "refused",
                             !.queued = Without(@, m)]
  /\ OnlySend

\* The socket dropped: finite.ts rejects the request, and the message is still queued.
TheDequeueIsLost(r) ==
  /\ area = "composer" /\ send.chip[r] = "dequeuing"
  /\ send' = [send EXCEPT !.chip[r] = "refused"]
  /\ OnlySend

\* Composer.tsx QueuedChip's Send now returns when edit's .catch(fail) took a refusal (dequeue-failure-stops), else its thread.send runs.
TheChipGoesOnToSend(r) ==
  /\ area = "composer" /\ send.chip[r] \in {"dequeued", "refused"}
  /\ send' = [send EXCEPT !.chip[r] =
       IF send.chip[r] = "refused" /\ Has("dequeue-failure-stops") THEN "done" ELSE "steering"]
  /\ OnlySend

TheServerSteersItIn(r) ==
  /\ area = "composer" /\ send.chip[r] = "steering"
  /\ send' = [send EXCEPT !.chip[r] = "done", !.running = TRUE,
                          !.delivered = Deliver(send, send.chipMsg[r])]
  /\ OnlySend

\* Composer.tsx QueuedChip's Send now: the steer is refused or lost, after the message left the queue. The catch sends it
\* again in queue mode (requeue-on-failure); without that it's gone.
TheSteerFails(r) ==
  /\ area = "composer" /\ send.chip[r] = "steering"
  /\ send' = [send EXCEPT !.chip[r] = IF Has("requeue-on-failure") THEN "requeueing" ELSE "done",
                          !.vanished = @ \/ ~Has("requeue-on-failure")]
  /\ OnlySend

\* apps/server/src/agent/index.ts sendNow in queue mode: queue it while the turn runs, else start it.
TheServerRequeuesIt(r) ==
  /\ area = "composer" /\ send.chip[r] = "requeueing"
  /\ send' = IF send.running
       THEN [send EXCEPT !.chip[r] = "done", !.queued = Append(@, send.chipMsg[r])]
       ELSE [send EXCEPT !.chip[r] = "done", !.running = TRUE,
                         !.delivered = Deliver(send, send.chipMsg[r])]
  /\ OnlySend

(* ---- Attachments: Composer.tsx upload ---- *)

\* Composer.tsx upload() adds { id, name, path: null }. Two drops of same-named files overlap.
YouDropAFile(u) ==
  /\ area = "upload" /\ upload.net[u] = "idle"
  /\ upload' = [upload EXCEPT !.chip[u] = "uploading", !.net[u] = "flying"]
  /\ OnlyUpload

\* Composer.tsx upload() fills the chip with that id.
TheUploadLands(u) ==
  /\ area = "upload" /\ upload.net[u] = "flying"
  /\ upload' = [chip |-> [v \in Uploads |->
                   IF v = u THEN (IF upload.chip[v] = "uploading" THEN "own" ELSE upload.chip[v])
                   ELSE IF upload.chip[v] = "uploading" /\ ~Has("upload-ids") THEN "other"
                   ELSE upload.chip[v]],
                net |-> [upload.net EXCEPT ![u] = "over"]]
  /\ OnlyUpload

\* Composer.tsx upload() removes the chip with that id.
TheUploadFails(u) ==
  /\ area = "upload" /\ upload.net[u] = "flying"
  /\ upload' = [chip |-> [v \in Uploads |->
                   IF upload.chip[v] = "uploading" /\ (v = u \/ ~Has("upload-ids"))
                   THEN "absent" ELSE upload.chip[v]],
                net |-> [upload.net EXCEPT ![u] = "over"]]
  /\ OnlyUpload

(* ---- Comment draft: Comments.tsx, canvas/tools/comment.ts placeComment, canvas/editor.ts cancelCommentDraft ---- *)

\* canvas/tools/comment.ts placeComment, a click with the Comment tool.
YouPlaceACommentDraft(d) ==
  /\ area = "comment" /\ d \notin comment.used
  /\ comment' = [comment EXCEPT !.draft = d, !.used = @ \union {d}]
  /\ OnlyComment

\* Comments.tsx Composer's submit; `sending` is the guard.
YouPressPost ==
  /\ area = "comment" /\ comment.draft # "none"
  /\ comment.flight = "none" \/ (Has("no-post-guard") /\ comment.posts[comment.draft] < 2)
  /\ comment' = [comment EXCEPT !.flight = "pending", !.flightOf = comment.draft]
  /\ OnlyComment

TheServerAddsTheComment ==
  /\ area = "comment" /\ comment.flight = "pending"
  /\ comment' = [comment EXCEPT !.flight = "answered", !.posts[comment.flightOf] = @ + 1]
  /\ OnlyComment

\* Comments.tsx CommentLayer calls cancelCommentDraft(draft), which leaves a newer draft open (draft-guard).
ThePostIsAnswered ==
  /\ area = "comment" /\ comment.flight = "answered"
  /\ LET newer == comment.draft \notin {"none", comment.flightOf}
         keep == newer /\ Has("draft-guard")
     IN comment' = [comment EXCEPT !.flight = "none", !.flightOf = "none",
                                   !.draft = IF keep THEN @ ELSE "none",
                                   !.dropped = @ \/ (newer /\ ~keep)]
  /\ OnlyComment

ThePostFails ==
  /\ area = "comment" /\ comment.flight = "pending"
  /\ comment' = [comment EXCEPT !.flight = "none", !.flightOf = "none"]
  /\ OnlyComment

YouCancelTheDraft ==
  /\ area = "comment" /\ comment.draft # "none"
  /\ comment' = [comment EXCEPT !.draft = "none"]
  /\ OnlyComment

(* ---- Command menu: CommandMenu.tsx ---- *)

\* CommandMenu.tsx go().
YouPickConnect ==
  /\ area = "menu" /\ ~menu.closed /\ menu.step = "root"
  /\ menu' = [menu EXCEPT !.step = "connect", !.error = FALSE]
  /\ OnlyMenu

\* CommandMenu.tsx finish(): `busy` is the guard, then it awaits work().
YouConfirmTheFolder ==
  /\ area = "menu" /\ ~menu.closed /\ menu.step = "connect"
  /\ ~menu.busy \/ Has("no-busy-guard")
  /\ menu.works < 2
  /\ menu' = [menu EXCEPT !.busy = TRUE, !.works = @ + 1, !.backed = FALSE, !.error = FALSE]
  /\ OnlyMenu

\* CommandMenu.tsx back(), or a press on the scrim; cancel() drops the work in flight
\* (menu-cancels).
YouGoBack ==
  /\ area = "menu" /\ ~menu.closed
  /\ LET cancels == menu.works > 0 /\ Has("menu-cancels")
     IN menu' = [menu EXCEPT
          !.step = "root",
          !.closed = menu.step = "root",
          !.error = FALSE,
          !.backed = @ \/ (menu.works > 0 /\ ~cancels),
          !.busy = IF cancels THEN FALSE ELSE @,
          !.works = IF cancels THEN 0 ELSE @]
  /\ OnlyMenu

\* CommandMenu.tsx finish(): router.push, then onClose, unless the work was cancelled.
TheWorkFinishes ==
  /\ area = "menu" /\ menu.works > 0
  /\ menu' = [menu EXCEPT !.works = @ - 1, !.closed = TRUE, !.strayed = @ \/ menu.backed]
  /\ OnlyMenu

\* CommandMenu.tsx finish(): the catch writes the error onto whatever step is showing.
TheWorkFails ==
  /\ area = "menu" /\ menu.works > 0
  /\ menu' = [menu EXCEPT !.works = @ - 1, !.busy = FALSE, !.backed = FALSE,
                          !.error = ~menu.closed,
                          !.misplaced = @ \/ (~menu.closed /\ menu.step # "connect")]
  /\ OnlyMenu

Moves ==
  \/ YouFocusTheField \/ YouTypeAWholeValue \/ YouTypeAPartialValue \/ YouPressAScrubLabel
  \/ YouDragTheScrub \/ YouReleaseTheScrub \/ YouEscapeTheScrub \/ TheBrowserBlursTheField
  \/ YouLeaveTheField \/ YouEscapeTheField \/ TheEditLands
  \/ YouOpenTheTokenPicker \/ YouChangeTheColor \/ YouFinishTheChange \/ YouEscapeTheChange
  \/ YouCloseThePicker \/ TheClosedPickerUnmounts \/ TheTokenChangesElsewhere
  \/ YouWriteAMessage \/ YouKeepTypingDuringTheSend \/ YouAttachDuringTheSend \/ YouPressSendWhileIdle
  \/ YouSteerTheRunningTurn \/ YouQueueForTheNextTurn \/ TheServerQueuesIt \/ TheServerDeliversIt
  \/ TheSendIsAnswered \/ TheSendFails \/ TheTurnEndsAndTakesTheQueue \/ TheTurnEnds \/ YouPressStop
  \/ \E r \in Runs : \/ YouPressSendNow(r) \/ TheServerAnswersTheDequeue(r) \/ TheDequeueIsLost(r)
                     \/ TheChipGoesOnToSend(r) \/ TheServerSteersItIn(r) \/ TheSteerFails(r)
                     \/ TheServerRequeuesIt(r)
  \/ \E u \in Uploads : YouDropAFile(u) \/ TheUploadLands(u) \/ TheUploadFails(u)
  \/ \E d \in Drafts : YouPlaceACommentDraft(d)
  \/ YouPressPost \/ TheServerAddsTheComment \/ ThePostIsAnswered \/ ThePostFails \/ YouCancelTheDraft
  \/ YouPickConnect \/ YouConfirmTheFolder \/ YouGoBack \/ TheWorkFinishes \/ TheWorkFails

\* Nothing left to do is a fine place to stop.
Finished == ~ENABLED Moves /\ UNCHANGED vars

Next == Moves \/ Finished
Spec == Init /\ [][Next]_vars

(* ---- Rules ---- *)

\* Text you typed and left reaches the source, as it reads when finished.
LeftTextReachesSource == ~insp.lost
\* A field whose draft was taken over knows, instead of typing into nothing.
SupersededFieldIsTold == ~(insp.handle /\ insp.open # "field")
\* A press on a label and a typing field never both drive the frame's preview.
OnePreviewDriver == ~(insp.open = "field" /\ insp.scrub # "none")
\* One typing session sends one source edit.
OneSendPerTyping == insp.sends <= 1
\* Escape leaves no preview behind.
NoOrphanPreview == insp.preview = "field" => insp.open = "field"

\* A closed picker holds no pick.
ClosedPickerHoldsNothing == token.phase = "closed" => token.picked = "none"
\* Closing the picker never saves an old pick over a newer token value.
ClosingNeverRewrites == ~token.rewrote

\* What you typed after pressing Send is still in the box when the send finishes.
TextTypedDuringSendSurvives == ~send.lostText
\* What you typed after pressing Send is the whole box once the send finishes, not the sent text and more.
SentTextLeavesTheBox == ~send.echo
\* A file you attached while a send was under way is still attached when it finishes.
AttachmentAddedDuringSendSurvives == ~send.lostFile
\* A Send now that fails leaves the message on the queue, not nowhere.
FailedSendNowKeepsTheMessage == ~send.vanished
\* One press of Send starts one send.
OneSendAtATime == ~send.doubled
\* A queued message reaches the agent once.
QueuedMessageDeliveredOnce == \A m \in Msgs : send.delivered[m] <= 1

\* Each attachment chip holds its own upload.
UploadsStayApart ==
  \A u \in Uploads : upload.chip[u] # "other" /\ ~(upload.net[u] = "flying" /\ upload.chip[u] = "absent")

\* Finishing one comment never cancels the draft you started after it.
NewerDraftSurvives == ~comment.dropped
\* One Post makes one comment.
CommentPostedOnce == \A d \in Drafts : comment.posts[d] <= 1

\* Backing out of the menu stops the pending work from taking you anywhere.
BackingOutStopsNavigation == ~menu.strayed
\* An error shows on the step that caused it.
ErrorStaysOnItsStep == ~menu.misplaced
\* One action at a time from the menu.
OneMenuWorkAtATime == menu.works <= 1
====
