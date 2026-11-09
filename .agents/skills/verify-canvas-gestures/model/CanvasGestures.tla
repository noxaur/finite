---- MODULE CanvasGestures ----
\* The canvas's pointer, tool, pen, text-edit and selection state, from apps/web/src/canvas.
\* Each action is one step of the code: no `await` inside it. Microtasks that run back to back on
\* one promise (`.then` callbacks and an `await` on it) are one step, since no event can land
\* between them. `Scope` picks which third runs, so each check stays small.
EXTENDS Naturals, FiniteSets

CONSTANTS
  Scope,            \* "pointer", "text" or "selection"
  MaxPress,         \* how many presses a run makes
  Tools,            \* the tools a run can pick
  Elements,         \* the text elements a run can edit
  \* What the person can physically do
  MultiPointer,     \* a second pointer can go down during a press (touch or pen plus mouse)
  \* The code as it stands is the setting named in current.cfg; the others are variants
  Line300,          \* setTool (editor.ts:315) deactivates even when the tool isn't changing
  DraggingGuard,    \* the begin callback checks the press is still current (editor.ts:687)
  BackToMoveGuard,  \* backToMove leaves a newer press alone (editor.ts:727)
  PenLeaveGuard,    \* the pen's trailing setTool leaves a newer draft alone (pen.ts:58)
  DownGuard,        \* onDown ignores a press while another pointer's is current (editor.ts:642)
  UpClearsCurrent,  \* onUp clears this.current (editor.ts:699)
  CancelEndsGesture,\* cancelPress ends the gesture (editor.ts:734)
  DoneGuard,        \* RichTextEditor's done ref and finishText's null check (RichTextEditor.tsx:247)
  OpenGuard,        \* a second editText waits for the first to open (tools/text.ts:80)
  KeepsStaleText,   \* a refused text edit keeps what was typed (editor.ts:946)
  OutsideClearsText,\* a selection from outside the canvas clears selectedText (editor.ts:228)
  OffFrameClearsOpen,\* a comment placed off any frame closes the open one (tools/comment.ts:50)
  LandingKeepsPick, \* draw selects its shape only if nobody picked since (tools/draw.ts, land)
  LandingsKnowEachOther \* a landing rebases newer draws and overtakes older ones (tools/draw.ts, land)

Presses == 1..MaxPress
Draws == 1..2                 \* the older and the newer of two draws on their way at once
Sticky(t) == t # "rect"       \* tools/shapes.ts has no `sticky`; move, pen and vectorEdit do

VARIABLES
  \* The press (editor.ts:145, Press and this.current)
  tool, current, nextPress,
  phase,      \* per press: unused, armed, started, clicking, awaitingBegin, cancelled, ending, done
  gesture,    \* per press: none, pending (begin() unresolved), live, ended
  pressTool, endCount, dragging,
  killed,     \* history: a press was cancelled by an earlier press finishing
  \* The pen (tools/pen.ts) and the point editor's counter (tools/vectorState.ts:68)
  anchors, placing,
  repickCost, \* history: picking the current tool again changed the draft
  draftKilled,\* history: an earlier finish ended a newer draft
  vecGestures,
  \* Rich text (editingText, tools/text.ts, RichTextEditor.tsx)
  editing, opening, opens, hidden, typed, fileRev, targetRev, landing, finishes,
  lostTyped,  \* history: text the person typed was refused and is gone
  \* Selection and comments (EditorState, selectionStore)
  elementsSelected, textSelected, objectSelected, commentDraft, commentOpen,
  drawing,            \* the draws on their way
  pickedWhileDrawing, \* per draw: the person picked something since it started
  landedAsPick,       \* the older draw's own landing counted as a pick for the newer
  newerSelected,      \* the newer draw landed and selected while the older was on its way
  newestLost,         \* history: the newest shape wasn't selected, and nobody picked anything
  stolen      \* history: a landing shape replaced a selection the person had made

pressVars == <<tool, current, nextPress, phase, gesture, pressTool, endCount, dragging, killed,
               anchors, placing, repickCost, draftKilled, vecGestures>>
textVars == <<editing, opening, opens, hidden, typed, fileRev, targetRev, landing, finishes,
              lostTyped>>
drawVars == <<drawing, pickedWhileDrawing, landedAsPick, newerSelected, newestLost, stolen>>
selectVars == <<elementsSelected, textSelected, objectSelected, commentDraft, commentOpen,
                drawVars>>
vars == <<pressVars, textVars, selectVars>>

\* Each action names its third of the model and leaves the other two alone.
InPointer == Scope = "pointer" /\ UNCHANGED <<textVars, selectVars>>
InText == Scope = "text" /\ UNCHANGED <<pressVars, selectVars>>
InSelection == Scope = "selection" /\ UNCHANGED <<pressVars, textVars>>

Init ==
  /\ tool = "select" /\ current = 0 /\ nextPress = 1
  /\ phase = [p \in Presses |-> "unused"]
  /\ gesture = [p \in Presses |-> "none"]
  /\ pressTool = [p \in Presses |-> "select"]
  /\ endCount = [p \in Presses |-> 0]
  /\ dragging = FALSE /\ killed = FALSE
  /\ anchors = 0 /\ placing = FALSE /\ repickCost = FALSE /\ draftKilled = FALSE
  /\ vecGestures = 0
  /\ editing = "none" /\ opening = {} /\ opens = [e \in Elements |-> 0] /\ hidden = {}
  /\ typed = FALSE /\ fileRev = 0 /\ targetRev = 0 /\ landing = {}
  /\ finishes = [e \in Elements |-> 0] /\ lostTyped = FALSE
  /\ elementsSelected = FALSE /\ textSelected = FALSE /\ objectSelected = FALSE
  /\ commentDraft = FALSE /\ commentOpen = FALSE
  /\ drawing = {} /\ pickedWhileDrawing = [d \in Draws |-> FALSE] /\ stolen = FALSE
  /\ landedAsPick = FALSE /\ newerSelected = FALSE /\ newestLost = FALSE

Vector(p) == IF pressTool[p] = "vector" THEN 1 ELSE 0

\* cancelPress (editor.ts:730): clears current and dragging, then ends the gesture when it resolves.
ApplyCancel ==
  /\ current' = 0
  /\ dragging' = FALSE
  /\ IF current = 0
     THEN UNCHANGED <<phase, gesture, endCount, vecGestures>>
     ELSE LET c == current IN
       /\ phase' = [phase EXCEPT ![c] = IF gesture[c] = "pending" THEN "cancelled" ELSE "done"]
       /\ IF gesture[c] = "live" /\ CancelEndsGesture
          THEN /\ gesture' = [gesture EXCEPT ![c] = "ended"]
               /\ endCount' = [endCount EXCEPT ![c] = @ + 1]
               /\ vecGestures' = vecGestures - Vector(c)
          ELSE /\ UNCHANGED gesture
               /\ endCount' = IF gesture[c] = "ended" /\ CancelEndsGesture
                              THEN [endCount EXCEPT ![c] = @ + 1] ELSE endCount
               /\ UNCHANGED vecGestures

PhysicallyPressed == current # 0 /\ phase[current] \in {"armed", "started"}

\* onDown then press() (editor.ts:589, :648). tool.down adds the pen's anchor synchronously.
\* A press whose release never arrived is CancelPress then PressDown (taken, editor.ts:640).
PressDown ==
  /\ InPointer
  /\ nextPress <= MaxPress
  /\ IF DownGuard THEN current = 0
     ELSE MultiPointer \/ ~PhysicallyPressed
  /\ tool = "pen" => anchors < 2
  /\ LET p == nextPress IN
     /\ phase' = [phase EXCEPT ![p] = "armed"]
     /\ pressTool' = [pressTool EXCEPT ![p] = tool]
     /\ current' = p
     /\ nextPress' = p + 1
     /\ anchors' = IF tool = "pen" THEN anchors + 1 ELSE anchors
  /\ UNCHANGED <<tool, gesture, endCount, dragging, killed, placing, repickCost, draftKilled,
                 vecGestures>>

\* onMove past the slop (editor.ts:681). A point-edit gesture counts itself as begin() runs.
\* Only Move's begin() waits on anything (tools/move.ts, the frame's hit). The shape, pen and point
\* tools' begin() is `async () => gesture`, so it resolves in the same step.
DragPastSlop ==
  /\ InPointer
  /\ current # 0 /\ phase[current] = "armed"
  /\ phase' = [phase EXCEPT ![current] = "started"]
  /\ IF pressTool[current] = "select"
     THEN /\ gesture' = [gesture EXCEPT ![current] = "pending"]
          /\ UNCHANGED dragging
     ELSE /\ gesture' = [gesture EXCEPT ![current] = "live"]
          /\ dragging' = TRUE
  /\ vecGestures' = vecGestures + Vector(current)
  /\ UNCHANGED <<tool, current, nextPress, pressTool, endCount, killed, anchors, placing,
                 repickCost, draftKilled>>

\* The begin() promise resolves: editor.ts:687 and whichever of onUp or cancelPress waits on it.
BeginResolves(p) ==
  /\ InPointer
  /\ gesture[p] = "pending"
  /\ \/ /\ phase[p] = "started"
        /\ gesture' = [gesture EXCEPT ![p] = "live"]
        /\ dragging' = IF DraggingGuard /\ current # p THEN dragging ELSE TRUE
        /\ UNCHANGED <<phase, endCount, vecGestures>>
     \/ /\ phase[p] = "awaitingBegin"   \* onUp (editor.ts:719-721)
        /\ gesture' = [gesture EXCEPT ![p] = "ended"]
        /\ phase' = [phase EXCEPT ![p] = "ending"]
        /\ endCount' = [endCount EXCEPT ![p] = @ + 1]
        /\ dragging' = FALSE
        /\ vecGestures' = vecGestures - Vector(p)
     \/ /\ phase[p] = "cancelled"       \* cancelPress (editor.ts:734)
        /\ gesture' = [gesture EXCEPT ![p] = "ended"]
        /\ phase' = [phase EXCEPT ![p] = "done"]
        /\ endCount' = [endCount EXCEPT ![p] = @ + 1]
        /\ dragging' = IF DraggingGuard THEN dragging ELSE TRUE
        /\ vecGestures' = vecGestures - Vector(p)
  /\ UNCHANGED <<tool, current, nextPress, pressTool, killed, anchors, placing, repickCost,
                 draftKilled>>

\* onUp (editor.ts:696). The awaits on an already-resolved gesture are microtasks.
PressUp ==
  /\ InPointer
  /\ current # 0 /\ phase[current] \in {"armed", "started"}
  /\ LET c == current IN
     /\ current' = IF UpClearsCurrent THEN 0 ELSE c
     /\ \/ /\ phase[c] = "armed"
           /\ phase' = [phase EXCEPT ![c] = "clicking"]
           /\ UNCHANGED <<gesture, endCount, dragging, vecGestures>>
        \/ /\ phase[c] = "started" /\ gesture[c] = "pending"
           /\ phase' = [phase EXCEPT ![c] = "awaitingBegin"]
           /\ UNCHANGED <<gesture, endCount, dragging, vecGestures>>
        \/ /\ phase[c] = "started" /\ gesture[c] = "live"
           /\ phase' = [phase EXCEPT ![c] = "ending"]
           /\ gesture' = [gesture EXCEPT ![c] = "ended"]
           /\ endCount' = [endCount EXCEPT ![c] = @ + 1]
           /\ dragging' = FALSE
           /\ vecGestures' = vecGestures - Vector(c)
  /\ UNCHANGED <<tool, nextPress, pressTool, killed, anchors, placing, repickCost, draftKilled>>

\* The click or g.end(true) has landed; backToMove runs (editor.ts:702-722, :726).
Finished(p) ==
  /\ InPointer
  /\ phase[p] \in {"clicking", "ending"}
  /\ IF ~Sticky(pressTool[p]) /\ tool = pressTool[p] /\ ~(BackToMoveGuard /\ current # 0)
     THEN /\ tool' = "select"
          /\ killed' = (killed \/ current # 0)
          /\ current' = 0
          /\ dragging' = FALSE
          /\ IF current = 0
             THEN /\ phase' = [phase EXCEPT ![p] = "done"]
                  /\ UNCHANGED <<gesture, endCount, vecGestures>>
             ELSE LET c == current IN
               /\ phase' = [phase EXCEPT ![p] = "done",
                                         ![c] = IF gesture[c] = "pending" THEN "cancelled" ELSE "done"]
               /\ gesture' = IF gesture[c] = "live" THEN [gesture EXCEPT ![c] = "ended"] ELSE gesture
               /\ endCount' = IF gesture[c] = "live" THEN [endCount EXCEPT ![c] = @ + 1] ELSE endCount
               /\ vecGestures' = IF gesture[c] = "live" THEN vecGestures - Vector(c) ELSE vecGestures
     ELSE /\ phase' = [phase EXCEPT ![p] = "done"]
          /\ UNCHANGED <<tool, killed, current, dragging, gesture, endCount, vecGestures>>
  /\ UNCHANGED <<nextPress, pressTool, anchors, placing, repickCost, draftKilled>>

\* setTool (editor.ts:311) from a key or the toolbar. Key repeat isn't filtered (registry.ts:87).
PickTool(t) ==
  /\ InPointer
  /\ t # "vector"
  /\ LET same == t = tool
         drops == tool = "pen" /\ (Line300 \/ ~same)
     IN /\ anchors' = IF drops THEN 0 ELSE anchors
        /\ repickCost' = (repickCost \/ (same /\ drops /\ anchors > 0))
        /\ tool' = t
        /\ IF same THEN UNCHANGED <<current, dragging, phase, gesture, endCount, vecGestures>>
                   ELSE ApplyCancel
  /\ UNCHANGED <<nextPress, pressTool, killed, placing, draftKilled>>

\* pointercancel (editor.ts:203), Escape reaching escape() (editor.ts:782), or the same pointer going
\* down again (taken, editor.ts:640). A pen draft takes Escape first (tools/pen.ts:116), so only the
\* other two reach this then; the model lets all three, which covers more.
CancelPress ==
  /\ InPointer
  /\ current # 0
  /\ ApplyCancel
  /\ UNCHANGED <<tool, nextPress, pressTool, killed, anchors, placing, repickCost, draftKilled>>

\* Enter or Escape with a draft: finish(host, false) (tools/pen.ts:116, :52-57).
PenFinish ==
  /\ InPointer
  /\ tool = "pen" /\ anchors > 0 /\ ~placing
  /\ anchors' = 0
  /\ placing' = (anchors >= 2)
  /\ UNCHANGED <<tool, current, nextPress, phase, gesture, pressTool, endCount, dragging, killed,
                 repickCost, draftKilled, vecGestures>>

\* The path landed; the trailing setTool("select") (tools/pen.ts:58).
PenPlaced ==
  /\ InPointer
  /\ placing
  /\ placing' = FALSE
  /\ IF tool = "pen" /\ ~(PenLeaveGuard /\ anchors > 0)
     THEN /\ tool' = "select"
          /\ draftKilled' = (draftKilled \/ anchors > 0)
          /\ anchors' = 0
          /\ ApplyCancel
     ELSE UNCHANGED <<tool, draftKilled, anchors, current, dragging, phase, gesture, endCount,
                      vecGestures>>
  /\ UNCHANGED <<nextPress, pressTool, killed, repickCost>>

\* Double-clicking a path, once enterVector's reads return (tools/vectorEdit.ts:57).
EnterPointEditing ==
  /\ InPointer
  /\ "vector" \in Tools /\ tool = "select" /\ current = 0
  /\ tool' = "vector"
  /\ UNCHANGED <<current, nextPress, phase, gesture, pressTool, endCount, dragging, killed, anchors,
                 placing, repickCost, draftKilled, vecGestures>>

\* Escape, Enter or a click away out of point editing (tools/vectorEdit.ts:151, :240).
LeavePointEditing ==
  /\ InPointer
  /\ tool = "vector"
  /\ tool' = "select"
  /\ ApplyCancel
  /\ UNCHANGED <<nextPress, pressTool, killed, anchors, placing, repickCost, draftKilled>>

\* The double-click reaches editText, which awaits readInline and the bridge (tools/text.ts:102).
\* A press while the box is open only blurs it (editor.ts:591), so this needs editing = none.
DoubleClickText(e) ==
  /\ InText
  /\ editing = "none" /\ opens[e] = 0
  /\ OpenGuard => opening = {}
  /\ opening' = opening \cup {e}
  /\ opens' = [opens EXCEPT ![e] = 1]
  /\ UNCHANGED <<editing, hidden, typed, fileRev, targetRev, landing, finishes, lostTyped>>

\* editText's host.update, then the layout effect's HIDDEN preview (RichTextEditor.tsx:208-225).
EditorOpens(e) ==
  /\ InText
  /\ e \in opening
  /\ opening' = opening \ {e}
  /\ editing' = e
  /\ hidden' = hidden \cup {e}
  /\ typed' = FALSE
  /\ targetRev' = fileRev
  /\ UNCHANGED <<opens, fileRev, landing, finishes, lostTyped>>

YouType ==
  /\ InText
  /\ editing # "none" /\ ~typed
  /\ typed' = TRUE
  /\ UNCHANGED <<editing, opening, opens, hidden, fileRev, targetRev, landing, finishes, lostTyped>>

\* The rev is a hash of the whole file (source/files.ts:8), so any edit to that file changes it.
OutsideEdit ==
  /\ InText
  /\ fileRev = 0
  /\ fileRev' = 1
  /\ UNCHANGED <<editing, opening, opens, hidden, typed, targetRev, landing, finishes, lostTyped>>

\* Enter, or blur by clicking away: finish(true), finishText up to its await (editor.ts:919-946).
KeepText ==
  /\ InText
  /\ editing # "none"
  /\ LET e == editing IN
     /\ editing' = "none"
     /\ hidden' = hidden \ {e}
     /\ finishes' = [finishes EXCEPT ![e] = @ + 1]
     /\ landing' = IF typed THEN landing \cup {e} ELSE landing
  /\ UNCHANGED <<opening, opens, typed, fileRev, targetRev, lostTyped>>

\* Escape: finish(false) (RichTextEditor.tsx:278).
DiscardText ==
  /\ InText
  /\ editing # "none"
  /\ LET e == editing IN
     /\ editing' = "none"
     /\ hidden' = hidden \ {e}
     /\ finishes' = [finishes EXCEPT ![e] = @ + 1]
  /\ UNCHANGED <<opening, opens, typed, fileRev, targetRev, landing, lostTyped>>

\* The blur that follows Enter or Escape as the box unmounts. Only reaches anything without the guards.
LateBlur(e) ==
  /\ InText
  /\ ~DoneGuard
  /\ editing = "none" /\ finishes[e] = 1
  /\ finishes' = [finishes EXCEPT ![e] = 2]
  /\ UNCHANGED <<editing, opening, opens, hidden, typed, fileRev, targetRev, landing, lostTyped>>

\* source.edit answers: rewrite.ts:142 refuses a stale rev. finishText (editor.ts:946) writes the
\* words over the new rev when only the rest of the file changed, else keepTyped puts them back
\* in the box (editor.ts:965). If another element took the loc or the keeps changed, the words go
\* in a notice instead (editor.ts:980).
EditLands(e) ==
  /\ InText
  /\ e \in landing
  /\ landing' = landing \ {e}
  /\ lostTyped' = (lostTyped \/ (targetRev # fileRev /\ ~KeepsStaleText))
  /\ UNCHANGED <<editing, opening, opens, hidden, typed, fileRev, targetRev, finishes>>

\* A press on the canvas: tools/move.ts:71, :83, :95 clear selectedText alongside the store.
ClickElementOnCanvas ==
  /\ InSelection
  /\ elementsSelected' = TRUE /\ textSelected' = FALSE /\ objectSelected' = FALSE
  /\ pickedWhileDrawing' = [d \in Draws |-> pickedWhileDrawing[d] \/ d \in drawing]
  /\ UNCHANGED <<commentDraft, commentOpen, drawing, landedAsPick, newerSelected, newestLost, stolen>>

\* selectionStore.set from the layers panel (components/LayersTree.tsx:102); editor.ts:226 reacts.
PickInLayers ==
  /\ InSelection
  /\ elementsSelected' = TRUE /\ objectSelected' = FALSE
  /\ textSelected' = IF OutsideClearsText THEN FALSE ELSE textSelected
  /\ pickedWhileDrawing' = [d \in Draws |-> pickedWhileDrawing[d] \/ d \in drawing]
  /\ UNCHANGED <<commentDraft, commentOpen, drawing, landedAsPick, newerSelected, newestLost, stolen>>

\* selectText (editor.ts:348).
ClickTextLabel ==
  /\ InSelection
  /\ textSelected' = TRUE /\ elementsSelected' = FALSE /\ objectSelected' = FALSE
  /\ pickedWhileDrawing' = [d \in Draws |-> pickedWhileDrawing[d] \/ d \in drawing]
  /\ UNCHANGED <<commentDraft, commentOpen, drawing, landedAsPick, newerSelected, newestLost, stolen>>

\* selectObject (editor.ts:354).
ClickSection ==
  /\ InSelection
  /\ objectSelected' = TRUE /\ elementsSelected' = FALSE /\ textSelected' = FALSE
  /\ pickedWhileDrawing' = [d \in Draws |-> pickedWhileDrawing[d] \/ d \in drawing]
  /\ UNCHANGED <<commentDraft, commentOpen, drawing, landedAsPick, newerSelected, newestLost, stolen>>

\* A shape's edit is on its way; draw polls for it to land (tools/draw.ts, place). The older of
\* two starts first, and a third doesn't start until both have landed.
DrawStarts(d) ==
  /\ InSelection
  /\ d \notin drawing
  /\ IF d = 1 THEN drawing = {} ELSE 1 \in drawing
  /\ drawing' = drawing \cup {d}
  /\ pickedWhileDrawing' = [pickedWhileDrawing EXCEPT ![d] = FALSE]
  /\ landedAsPick' = IF d = 1 THEN FALSE ELSE landedAsPick
  /\ newerSelected' = IF d = 1 THEN FALSE ELSE newerSelected
  /\ UNCHANGED <<elementsSelected, textSelected, objectSelected, commentDraft, commentOpen,
                 newestLost, stolen>>

\* tools/draw.ts, land: host.select unless someone picked since this draw started or a newer one
\* selected first. A landing rebases the newer draw, so it doesn't count as that draw's pick.
DrawLands(d) ==
  /\ InSelection
  /\ d \in drawing
  /\ drawing' = drawing \ {d}
  /\ LET picked == pickedWhileDrawing[d] \/ (d = 2 /\ landedAsPick)
         keeps == (LandingKeepsPick /\ picked) \/
                  (LandingsKnowEachOther /\ d = 1 /\ newerSelected)
     IN
     /\ newestLost' = (newestLost \/ (d = 2 /\ keeps /\ ~pickedWhileDrawing[2])
                                  \/ (d = 1 /\ ~keeps /\ newerSelected))
     /\ IF keeps
        THEN UNCHANGED <<elementsSelected, textSelected, objectSelected, stolen,
                         pickedWhileDrawing, landedAsPick, newerSelected>>
        ELSE /\ elementsSelected' = TRUE
             /\ objectSelected' = FALSE
             /\ textSelected' = IF OutsideClearsText THEN FALSE ELSE textSelected
             /\ stolen' = (stolen \/ pickedWhileDrawing[d])
             /\ pickedWhileDrawing' = [pickedWhileDrawing EXCEPT ![d] = FALSE]
             /\ landedAsPick' = (landedAsPick \/ (~LandingsKnowEachOther /\ d = 1 /\ 2 \in drawing))
             /\ newerSelected' = (newerSelected \/ (d = 2 /\ 1 \in drawing))
  /\ UNCHANGED <<commentDraft, commentOpen>>

\* tools/comment.ts:50, a comment placed on the empty canvas.
PlaceCommentOffFrame ==
  /\ InSelection
  /\ commentDraft' = TRUE
  /\ commentOpen' = IF OffFrameClearsOpen THEN FALSE ELSE commentOpen
  /\ UNCHANGED <<elementsSelected, textSelected, objectSelected, drawVars>>

\* tools/comment.ts:67, a comment placed on a frame.
PlaceCommentOnFrame ==
  /\ InSelection
  /\ commentDraft' = TRUE /\ commentOpen' = FALSE
  /\ UNCHANGED <<elementsSelected, textSelected, objectSelected, drawVars>>

\* openComment (editor.ts:339).
OpenAComment ==
  /\ InSelection
  /\ commentOpen' = TRUE /\ commentDraft' = FALSE
  /\ UNCHANGED <<elementsSelected, textSelected, objectSelected, drawVars>>

Quiet ==
  /\ Scope = "text"
  /\ editing = "none" /\ opening = {} /\ landing = {}
  /\ \A e \in Elements: opens[e] = 1

Done == Quiet /\ UNCHANGED vars

Next ==
  \/ PressDown \/ DragPastSlop \/ PressUp \/ CancelPress \/ PenFinish \/ PenPlaced
  \/ EnterPointEditing \/ LeavePointEditing
  \/ \E p \in Presses: BeginResolves(p)
  \/ \E p \in Presses: Finished(p)
  \/ \E t \in Tools: PickTool(t)
  \/ YouType \/ OutsideEdit \/ KeepText \/ DiscardText
  \/ \E e \in Elements: DoubleClickText(e)
  \/ \E e \in Elements: EditorOpens(e)
  \/ \E e \in Elements: LateBlur(e)
  \/ \E e \in Elements: EditLands(e)
  \/ ClickElementOnCanvas \/ PickInLayers \/ ClickTextLabel \/ ClickSection
  \/ \E d \in Draws: DrawStarts(d)
  \/ \E d \in Draws: DrawLands(d)
  \/ PlaceCommentOffFrame \/ PlaceCommentOnFrame \/ OpenAComment
  \/ Done

Spec == Init /\ [][Next]_vars

\* Keeps the text chart readable: a second element only ever opens as a race with the first
\* (chart-text.cfg only).
OnlyRacingSecondOpen == opens["caption"] = 1 => ("headline" \in opening \/ "headline" \in hidden)

\* Rules. Each is one sentence a person would agree to.

\* The canvas thinks you're dragging only while a press is really being dragged.
DraggingOnlyWhileLive == dragging => (current # 0 /\ gesture[current] = "live")

\* Finishing one press never cancels the press you've started since.
FinishingLeavesNextPressAlone == ~killed

\* Pressing the key of the tool you're on doesn't touch your pen draft.
SameToolKeepsPenDraft == ~repickCost

\* Finishing one pen path doesn't end the path you've started since.
FinishedPathLeavesNewDraft == ~draftKilled

\* A gesture's end runs at most once.
GestureEndsAtMostOnce == \A p \in Presses: endCount[p] <= 1

\* Every gesture still running belongs to a press that will end it.
NoOrphanGesture ==
  \A p \in Presses:
    gesture[p] \in {"pending", "live"} =>
      (p = current \/ phase[p] \in {"awaitingBegin", "cancelled"})

\* The point editor's gesture count is only ever held up by gestures that will end.
PointCountHasOwners ==
  vecGestures <=
    Cardinality({p \in Presses:
      /\ pressTool[p] = "vector"
      /\ gesture[p] \in {"pending", "live"}
      /\ (p = current \/ phase[p] \in {"awaitingBegin", "cancelled"})})

\* One text edit finishes once.
TextFinishesOnce == \A e \in Elements: finishes[e] <= 1

\* Only the element being typed in is hidden.
OnlyEditedElementHidden == hidden \subseteq (IF editing = "none" THEN {} ELSE {editing})

\* Text you typed and kept is written, or stays in front of you.
TypedTextIsKept == ~lostTyped

\* One kind of thing is selected at a time.
OneKindOfSelection ==
  Cardinality({b \in {"e", "t", "o"}:
    (b = "e" /\ elementsSelected) \/ (b = "t" /\ textSelected) \/ (b = "o" /\ objectSelected)}) <= 1

\* A comment draft and an open comment never show together.
OneCommentSurface == ~(commentDraft /\ commentOpen)

\* A shape that lands doesn't replace what you picked while it was on its way.
LandingKeepsYourPick == ~stolen

\* Of two shapes landing at once, the newest ends up selected, unless you picked something.
NewestLandingIsSelected == ~newestLost
====
